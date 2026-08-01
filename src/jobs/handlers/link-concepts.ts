import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { buildEntityIndex, resolveEntity, type EntityKind } from '../../ingest/entity-resolver.js';
import { createEntityPage, mergeEntityPage, type ExtractedEntityInfo } from '../../ingest/entity-writer.js';
import { heuristicGate } from '../../intelligence/significance-gate.js';
import { isNoiseEntity } from '../../enrichment/entity-filter.js';
import { nowISO } from '../../shared/date-utils.js';
import { OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { slugify } from '../../vault/paths.js';
import { createLogger } from '../../shared/logger.js';
import { markDirty } from '../../maintenance/mark-dirty.js';
import { createReviewItem } from '../../review/create-review-item.js';
import { findNameVariantCandidatesForNewPage } from '../../compilation/person-name-variants.js';
import { refreshQueue } from '../../maintenance/reconciliation-queue.js';
import { generateReviewAnalysis, bucketConfidence } from '../../review/generate-review-analysis.js';
import { TransientLLMError } from '../../shared/errors.js';

const log = createLogger('handler:link-concepts');

interface PayloadEntity {
  name: string;
  role?: string;
  status?: string;
  context?: string;
  definition?: string;
  confidence?: number;
  chunkRefs?: string[];
  externalIds?: string[];
}

export const linkConceptsHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = job.targetPath;
    if (!summaryPath) throw new Error('link-concepts: no targetPath');

    const entitiesPayload = job.payload.entities as Record<string, PayloadEntity[]> | undefined;
    if (!entitiesPayload) throw new Error('link-concepts: no entities in payload');

    // Build entity index from vault
    const index = await buildEntityIndex(context.vault, context.config.layout);

    // Collect all entities to resolve
    const toResolve: Array<{ entity: PayloadEntity; kind: EntityKind }> = [];

    for (const person of (entitiesPayload.people ?? [])) {
      toResolve.push({ entity: person, kind: 'person' });
    }
    for (const project of (entitiesPayload.projects ?? [])) {
      toResolve.push({ entity: project, kind: 'project' });
    }
    for (const concept of (entitiesPayload.concepts ?? [])) {
      toResolve.push({ entity: concept, kind: 'concept' });
    }
    for (const decision of (entitiesPayload.decisions ?? [])) {
      toResolve.push({ entity: decision, kind: 'decision' });
    }

    // Filter noise entities and low-confidence entities before resolution
    const customBlocklist = context.config.enrichment.entityBlocklist ?? [];
    const minConfidence = context.config.enrichment.minEntityConfidence ?? 0.3;
    const filtered = toResolve.filter(({ entity, kind }) => {
      if (isNoiseEntity(entity.name, kind, customBlocklist)) {
        log.debug('Skipping noise entity', { name: entity.name, kind });
        return false;
      }
      if (entity.confidence !== undefined && entity.confidence < minConfidence) {
        log.debug('Skipping low-confidence entity', { name: entity.name, kind, confidence: entity.confidence });
        return false;
      }
      return true;
    });

    const linkedPaths: string[] = [];
    const touchedPages: string[] = [];
    /**
     * Phase 1: pages whose existing concept was matched + merged (i.e. they
     * got new evidence). These are eligible for cascading curation —
     * `markDirty` here, then `evaluate-refresh-candidates` decides whether to
     * enqueue `topic-refresh`. Newly created pages (resolution === 'new')
     * are excluded; their content is already fresh.
     */
    const mergedPages: string[] = [];

    for (const { entity, kind } of filtered) {
      const resolution = resolveEntity(
        { name: entity.name, kind, externalIds: entity.externalIds },
        index,
        context.config.layout,
        { nicknameMatchingEnabled: context.config.enrichment.personResolution.nicknameMatchingEnabled },
      );
      const info: ExtractedEntityInfo = {
        name: entity.name,
        kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs ?? [],
        externalIds: entity.externalIds,
      };

      try {
        if (resolution.status === 'new' && context.config.enrichment.autoCreateEntities) {
          // D4 significance gate (heuristic mode): drop generic / too-short
          // names rather than spawning a noisy entity page.
          if (context.config.enrichment.significanceGate !== 'off') {
            const decision = heuristicGate(
              { name: entity.name, kind: kind === 'person' ? 'person' : (kind as 'concept' | 'project' | 'tool' | 'organization' | 'topic' | 'decision') },
              [],
            );
            if (decision.action === 'drop') {
              log.debug('Significance gate dropped entity', { name: entity.name, reason: decision.reason });
              continue;
            }
          }
          const path = await createEntityPage(context.vault, resolution, info, summaryPath);
          linkedPaths.push(path);

          // B2c Component 3: same immediate-detection hookup as compiler.ts's
          // rich path (compileFromSource) — best-effort, person-only.
          if (kind === 'person' && context.config.enrichment.personResolution.enabled) {
            try {
              const nameVariantCandidates = findNameVariantCandidatesForNewPage(index, context.config.layout, {
                name: entity.name,
                path,
                aliases: [],
              });
              if (nameVariantCandidates.length > 0) {
                await refreshQueue(context.vault, nameVariantCandidates, context.config.layout);
                log.info('Queued person name-variant candidates', {
                  path,
                  count: nameVariantCandidates.length,
                });
              }
            } catch (err) {
              log.warn('Name-variant check failed; page created without a candidate check', {
                path,
                error: (err as Error).message,
              });
            }
          }

          touchedPages.push(path);
        } else if (resolution.status === 'matched' && resolution.matchedPath) {
          if (context.config.enrichment.autoMergeEntities) {
            const result = await mergeEntityPage(context.vault, resolution.matchedPath, info, summaryPath);
            if (result.changed) {
              touchedPages.push(resolution.matchedPath);
              mergedPages.push(resolution.matchedPath);
            }
          }
          linkedPaths.push(resolution.matchedPath);
        } else if (resolution.status === 'ambiguous') {
          const candidates = resolution.candidates ?? [];
          const candidateList = candidates
            .map((c) => `- [[${c.path.split('/').pop()?.replace(/\.md$/, '')}]] (confidence: ${c.confidence.toFixed(2)})`)
            .join('\n');

          const candidateDetails = await Promise.all(
            candidates.map(async (c) => {
              const noteContent = await context.vault.read(c.path);
              const { data, body } = parseNote(noteContent);
              return {
                path: c.path,
                title: (data.title as string) ?? c.path.split('/').pop()?.replace(/\.md$/, '') ?? c.path,
                excerpt: body.replace(/%%[\s\S]*?%%/g, '').trim().slice(0, 300),
              };
            }),
          );

          const analysis = await generateReviewAnalysis(context.config, context.projectRoot, {
            kind: 'ambiguous_entity',
            entityName: entity.name,
            entityKind: kind,
            sourceContext: entity.context ?? entity.definition ?? '(no additional context)',
            candidates: candidateDetails,
          });

          const validatedMatch =
            analysis.verdict === 'match' && candidateDetails.some((c) => c.path === analysis.matchedPath)
              ? analysis.matchedPath
              : undefined;

          const matchNote = validatedMatch
            ? `\n\n**Suggested match:** [[${validatedMatch.split('/').pop()?.replace(/\.md$/, '')}]] (unconfirmed — approve or dismiss below)`
            : '';

          await createReviewItem(context.vault, {
            slug: slugify(`ambiguous-${entity.name}`),
            title: `Ambiguous: ${entity.name} (${kind})`,
            claimA: `Entity "${entity.name}" found in ${summaryPath}`,
            claimB: `Multiple matching pages: ${candidates.map((c) => c.path).join(', ')}`,
            sourceRefs: [summaryPath],
            links: candidates.map((c) => c.path),
            conflictType: 'ambiguous_entity',
            confidence: bucketConfidence(analysis.confidence),
            body: `
# Ambiguous Entity: ${entity.name}

**Kind:** ${kind}
**Source:** [[${summaryPath.split('/').pop()?.replace(/\.md$/, '')}]]

## Candidates
${candidateList}

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}${matchNote}
${CLOSE_TAG('analysis')}
`,
          });
          log.warn('Ambiguous entity resolution', { name: entity.name, kind, candidates: candidates.length });
        }
      } catch (err) {
        if (err instanceof TransientLLMError) throw err;
        log.error('Failed to link entity', { name: entity.name, kind, error: (err as Error).message });
      }
    }

    // Update source summary with links
    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    data.links = [...new Set([...(data.links as string[] ?? []), ...linkedPaths])];
    data.ingest_status = 'linked';
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(summaryPath, updated);

    log.info('Concepts linked', {
      path: summaryPath,
      linked: linkedPaths.length,
      touched: touchedPages.length,
    });

    // Cascade: update backlinks for all touched pages
    for (const page of [summaryPath, ...touchedPages]) {
      await context.enqueue({
        type: 'update-backlinks',
        targetPath: page,
        trigger: 'cascade',
        priority: 10,
        dedupeKey: `backlinks:${page}`,
      });
    }

    // Cascade: rebuild index
    await context.enqueue({
      type: 'rebuild-index',
      trigger: 'cascade',
      priority: 10,
      dedupeKey: 'index:wiki',
    });

    // Phase 1: cascading curation. For each existing concept page that gained
    // new evidence (matched-and-merged), record the new source on the page's
    // `pending_evidence` queue and enqueue `evaluate-refresh-candidates` to
    // decide (deterministically, no LLM) whether to refresh the page now.
    if (context.config.intelligence.refresh.enabled) {
      const uniqueMerged = [...new Set(mergedPages)];
      for (const page of uniqueMerged) {
        try {
          const result = await markDirty(context.vault, {
            notePath: page,
            ref: summaryPath,
            reason: 'new-evidence',
          });
          if (result.added) {
            log.debug('marked dirty', {
              page,
              pendingCount: result.pendingCount,
            });
          }
        } catch (err) {
          log.warn('markDirty failed; continuing', {
            page,
            error: (err as Error).message,
          });
        }
        await context.enqueue({
          type: 'evaluate-refresh-candidates',
          targetPath: page,
          trigger: 'cascade',
          priority: 50,
          dedupeKey: `refresh-eval:${page}`,
        });
      }
    }
  },
};

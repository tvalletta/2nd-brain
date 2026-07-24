import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { EntityKind } from '../ingest/entity-resolver.js';
import { buildEntityIndex, resolveEntity } from '../ingest/entity-resolver.js';
import { createEntityPage } from '../ingest/entity-writer.js';
import { compileEntityPage } from './entity-compiler.js';
import { layoutFromConfig } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';
import { heuristicGate, llmGate } from '../intelligence/significance-gate.js';
import { createReviewItem } from '../review/create-review-item.js';
import { createBudgetTrackerFromConfig } from '../shared/budget.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';

const log = createLogger('compiler');

export interface CompilationResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

export interface CompilableEntity {
  name: string;
  kind: EntityKind;
  context: string;
  role?: string;
  status?: string;
  definition?: string;
  relationships: Array<{
    target: string;
    targetKind: string;
    relationship: string;
  }>;
  chunkRefs: string[];
}

export async function compileFromSource(
  sourcePath: string,
  entities: CompilableEntity[],
  context: { vault: VaultAdapter; llm: LLMClient; config: KarpathyConfig; projectRoot: string },
): Promise<CompilationResult> {
  const { vault, llm, config, projectRoot } = context;
  const layout = layoutFromConfig(config);
  const budget = createBudgetTrackerFromConfig(config, projectRoot);
  const result: CompilationResult = {
    created: [],
    updated: [],
    skipped: [],
  };

  log.info('Starting compilation', { sourcePath, entityCount: entities.length });

  const entityIndex = await buildEntityIndex(vault, layout);

  for (const entity of entities) {
    const resolution = resolveEntity(
      { name: entity.name, kind: entity.kind },
      entityIndex,
      layout,
    );

    log.debug('Entity resolution', {
      name: entity.name,
      kind: entity.kind,
      status: resolution.status,
      matchedPath: resolution.matchedPath,
    });

    if (resolution.status === 'ambiguous') {
      log.warn('Ambiguous entity match, skipping', {
        name: entity.name,
        kind: entity.kind,
        candidates: resolution.candidates?.map((c) => c.path),
      });
      result.skipped.push(entity.name);
      continue;
    }

    let existingPagePath: string | null = null;

    if (resolution.status === 'new') {
      // D4 significance gate: decide whether this brand-new entity deserves
      // a page before creating one. `candidates` is always [] here — no
      // similarity lookup is built for this call site; full duplicate/merge
      // detection across the vault is handled separately by the scheduled
      // detect-entity-dupes job. See
      // docs/superpowers/specs/2026-07-23-quality-layer-activation-design.md
      // §5.2 for why.
      let flaggedForReview: { reason: string; confidence?: number } | undefined;

      if (config.enrichment.significanceGate !== 'off') {
        const gateInput = { name: entity.name, kind: entity.kind, context: entity.context };
        const decision =
          config.enrichment.significanceGate === 'llm' && budget.tryReserve('fast')
            ? await llmGate(llm, gateInput, [])
            : heuristicGate(gateInput, []);

        if (decision.action === 'drop') {
          const threshold = config.enrichment.significanceGateDropConfidence;
          const isUncertain = decision.confidence !== undefined && decision.confidence < threshold;
          if (!isUncertain) {
            log.debug('Significance gate dropped entity', { name: entity.name, reason: decision.reason });
            result.skipped.push(entity.name);
            continue;
          }
          flaggedForReview = { reason: decision.reason, confidence: decision.confidence };
          log.debug('Significance gate uncertain, creating and flagging for review', {
            name: entity.name,
            reason: decision.reason,
            confidence: decision.confidence,
          });
        }
      }

      // Create a new page using entity-writer, then compile on top
      const createdPath = await createEntityPage(vault, resolution, {
        name: entity.name,
        kind: entity.kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs,
      }, sourcePath, layout);

      existingPagePath = createdPath;

      log.info('Created new entity page', { path: createdPath, name: entity.name });

      // Update the index so subsequent entities can find this page
      const slug = createdPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
      entityIndex.bySlug.set(slug, createdPath);
      entityIndex.byCanonicalName.set(entity.name.toLowerCase(), createdPath);

      result.created.push(createdPath);

      if (flaggedForReview) {
        await createReviewItem(vault, {
          slug: `uncertain-drop-${slug}`,
          title: `Uncertain: ${entity.name} (${entity.kind})`,
          claimA: `Significance gate suggested dropping this entity: ${flaggedForReview.reason}`,
          claimB: `Confidence ${flaggedForReview.confidence} is below the review threshold (${config.enrichment.significanceGateDropConfidence})`,
          sourceRefs: [sourcePath],
          links: [createdPath],
          conflictType: 'uncertain_entity_drop',
          body: `
# Uncertain: ${entity.name}

**Kind:** ${entity.kind}
**Page created:** [[${slug}]]
**Source:** [[${sourcePath.split('/').pop()?.replace(/\.md$/, '')}]]

## Analysis
${OPEN_TAG('analysis')}
The significance gate suggested dropping "${entity.name}" (${flaggedForReview.reason}), but confidence ${flaggedForReview.confidence} was below the review threshold, so the page was created rather than silently discarded. Review [[${slug}]] and decide whether it deserves to exist — approve to keep it, reject to remove it.
${CLOSE_TAG('analysis')}
`,
        });
      }
    } else {
      // Matched existing page
      existingPagePath = resolution.matchedPath!;
    }

    try {
      const compiledPath = await compileEntityPage(
        entity,
        existingPagePath,
        sourcePath,
        { vault, llm },
      );

      if (resolution.status === 'matched' && !result.created.includes(compiledPath)) {
        result.updated.push(compiledPath);
      }
    } catch (err) {
      log.error('Failed to compile entity page', {
        name: entity.name,
        path: existingPagePath,
        error: (err as Error).message,
      });
      result.skipped.push(entity.name);
    }
  }

  log.info('Compilation complete', {
    created: result.created.length,
    updated: result.updated.length,
    skipped: result.skipped.length,
  });

  return result;
}

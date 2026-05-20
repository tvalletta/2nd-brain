import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { compileFromSource, type CompilableEntity } from '../../compilation/compiler.js';
import type { EntityKind } from '../../ingest/entity-resolver.js';
import type { RichExtractedEntities } from '../../enrichment/entity-extractor-rich.js';
import { isNoiseEntity } from '../../enrichment/entity-filter.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:compile-entities');

export const compileEntitiesHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const sourceSummaryPath = job.targetPath;
    if (!sourceSummaryPath) throw new Error('compile-entities: no targetPath');

    const entitiesPayload = job.payload.entities as Record<string, unknown> | undefined;
    if (!entitiesPayload) throw new Error('compile-entities: no entities in payload');

    const entities = entitiesPayload as unknown as RichExtractedEntities;

    // Filter helper: blocklist + confidence gate applied before conversion
    const customBlocklist = context.config.enrichment.entityBlocklist ?? [];
    const minConfidence = context.config.enrichment.minEntityConfidence ?? 0.3;

    function shouldInclude(name: string, kind: string, confidence?: number): boolean {
      if (isNoiseEntity(name, kind, customBlocklist)) {
        log.debug('Skipping noise entity', { name, kind });
        return false;
      }
      if (confidence !== undefined && confidence < minConfidence) {
        log.debug('Skipping low-confidence entity', { name, kind, confidence });
        return false;
      }
      return true;
    }

    // 1. Convert payload entities into CompilableEntity[] array (with filtering)
    const compilable: CompilableEntity[] = [];
    let filteredOut = 0;

    for (const person of (entities.people ?? [])) {
      if (!shouldInclude(person.name, 'person', person.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: person.name,
        kind: 'person' as EntityKind,
        context: person.context ?? '',
        role: person.role,
        relationships: person.relationships ?? [],
        chunkRefs: person.chunkRefs ?? [],
      });
    }

    for (const project of (entities.projects ?? [])) {
      if (!shouldInclude(project.name, 'project', project.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: project.name,
        kind: 'project' as EntityKind,
        context: project.context ?? '',
        status: project.status,
        relationships: project.relationships ?? [],
        chunkRefs: project.chunkRefs ?? [],
      });
    }

    for (const concept of (entities.concepts ?? [])) {
      if (!shouldInclude(concept.name, 'concept', concept.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: concept.name,
        kind: 'concept' as EntityKind,
        context: '',
        definition: concept.definition,
        relationships: concept.relationships ?? [],
        chunkRefs: concept.chunkRefs ?? [],
      });
    }

    for (const topic of (entities.topics ?? [])) {
      if (!shouldInclude(topic.name, 'topic', topic.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: topic.name,
        kind: 'topic' as EntityKind,
        context: '',
        definition: topic.definition,
        relationships: topic.relationships ?? [],
        chunkRefs: topic.chunkRefs ?? [],
      });
    }

    for (const decision of (entities.decisions ?? [])) {
      if (!shouldInclude(decision.title, 'decision', decision.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: decision.title,
        kind: 'decision' as EntityKind,
        context: decision.context ?? '',
        status: decision.status,
        relationships: decision.relationships ?? [],
        chunkRefs: decision.chunkRefs ?? [],
      });
    }

    for (const tool of (entities.tools ?? [])) {
      if (!shouldInclude(tool.name, 'tool', tool.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: tool.name,
        kind: 'tool' as EntityKind,
        context: tool.context ?? '',
        relationships: tool.relationships ?? [],
        chunkRefs: tool.chunkRefs ?? [],
      });
    }

    for (const org of (entities.organizations ?? [])) {
      if (!shouldInclude(org.name, 'organization', org.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: org.name,
        kind: 'organization' as EntityKind,
        context: org.context ?? '',
        relationships: org.relationships ?? [],
        chunkRefs: org.chunkRefs ?? [],
      });
    }

    log.info('Compiling entities', {
      sourcePath: sourceSummaryPath,
      entityCount: compilable.length,
      filteredOut,
    });

    // 2. Call compileFromSource
    const result = await compileFromSource(sourceSummaryPath, compilable, {
      vault: context.vault,
      llm: context.llm,
      config: context.config,
    });

    // 3. Update source summary: set ingest_status to 'linked', update links array
    const summaryContent = await context.vault.read(sourceSummaryPath);
    const { data, body } = parseNote(summaryContent);
    const allPages = [...result.created, ...result.updated];
    data.links = [...new Set([...(data.links as string[] ?? []), ...allPages])];
    data.ingest_status = 'linked';
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(sourceSummaryPath, updated);

    log.info('Compilation complete', {
      sourcePath: sourceSummaryPath,
      created: result.created.length,
      updated: result.updated.length,
      skipped: result.skipped.length,
    });

    // 4. Cascade: enqueue 'cross-link-pages' for all created+updated pages
    if (allPages.length > 0) {
      await context.enqueue({
        type: 'cross-link-pages',
        payload: {
          pagePaths: allPages,
        },
        trigger: 'cascade',
        priority: 70,
        dedupeKey: `crosslink:${sourceSummaryPath}`,
      });
    }

    // 5. Cascade: enqueue 'rebuild-indexes'
    await context.enqueue({
      type: 'rebuild-indexes',
      trigger: 'cascade',
      priority: 15,
      dedupeKey: 'rebuild-indexes',
    });
  },
};

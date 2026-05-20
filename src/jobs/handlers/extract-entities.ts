import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { updateProtectedRegion } from '../../vault/protected-regions.js';
import { chunkDocument } from '../../ingest/chunker.js';
import { extractEntities, extractEntitiesFromChunks } from '../../enrichment/entity-extractor.js';
import { extractEntitiesRich, extractEntitiesRichFromChunks } from '../../enrichment/entity-extractor-rich.js';
import type { RichExtractedEntities } from '../../enrichment/entity-extractor-rich.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';
import type { SourceType } from '../../ingest/classifier.js';
import type { ExtractedEntities } from '../../enrichment/entity-extractor.js';

const log = createLogger('handler:extract-entities');

export const extractEntitiesHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = job.targetPath;
    if (!summaryPath) throw new Error('extract-entities: no targetPath');

    const rawPath = job.payload.rawPath as string;
    if (!rawPath) throw new Error('extract-entities: no rawPath in payload');

    // Read raw content
    const rawContent = await context.vault.read(rawPath);

    // Read source summary
    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    const sourceType = (data.source_type as SourceType) ?? 'plaintext';
    const sourceHash = (data.source_hash as string) ?? '';

    // Chunk and extract
    const chunkResult = chunkDocument(rawContent, sourceType, sourceHash, {
      maxChunkSize: context.config.enrichment.maxChunkSize,
      overlap: context.config.enrichment.chunkOverlap,
    });

    let entities: ExtractedEntities;
    const extractResult = chunkResult.chunks.length === 1
      ? await extractEntities(context.llm, chunkResult.chunks[0].content)
      : await extractEntitiesFromChunks(context.llm, chunkResult.chunks);
    if (extractResult.status === 'error') throw new Error(`Entity extraction failed: ${extractResult.error}`);
    entities = extractResult.data;

    // Format entities as wikilinked bullets
    const formattedEntities = formatEntitiesMarkdown(entities);

    // Update protected region
    let updatedBody = updateProtectedRegion(body, 'entities', formattedEntities);
    data.ingest_status = 'extracted';
    data.updated_at = nowISO();

    const updated = serializeNote(data, updatedBody);
    await context.vault.atomicWrite(summaryPath, updated);

    log.info('Entities extracted', {
      path: summaryPath,
      people: entities.people.length,
      projects: entities.projects.length,
      concepts: entities.concepts.length,
      decisions: entities.decisions.length,
    });

    // Cascade: link-concepts with extracted entities
    if (context.config.enrichment.autoCreateEntities) {
      await context.enqueue({
        type: 'link-concepts',
        targetPath: summaryPath,
        payload: {
          entities: serializeEntitiesForPayload(entities),
          sourceSummaryPath: summaryPath,
        },
        trigger: 'cascade',
        priority: 60,
        dedupeKey: `link:${sourceHash}`,
      });
    }
  },
};

function formatEntitiesMarkdown(entities: ExtractedEntities): string {
  const sections: string[] = [];

  if (entities.people.length > 0) {
    sections.push('### People');
    for (const p of entities.people) {
      const chunkInfo = p.chunkRefs.length ? ` (chunks: ${p.chunkRefs.join(', ')})` : '';
      const roleInfo = p.role ? ` — ${p.role}` : '';
      const contextInfo = p.context ? ` — ${p.context}` : '';
      sections.push(`- **${p.name}**${roleInfo}${contextInfo}${chunkInfo}`);
    }
  }

  if (entities.projects.length > 0) {
    sections.push('\n### Projects');
    for (const p of entities.projects) {
      const chunkInfo = p.chunkRefs.length ? ` (chunks: ${p.chunkRefs.join(', ')})` : '';
      const statusInfo = p.status ? ` [${p.status}]` : '';
      const contextInfo = p.context ? ` — ${p.context}` : '';
      sections.push(`- **${p.name}**${statusInfo}${contextInfo}${chunkInfo}`);
    }
  }

  if (entities.concepts.length > 0) {
    sections.push('\n### Concepts');
    for (const c of entities.concepts) {
      const chunkInfo = c.chunkRefs.length ? ` (chunks: ${c.chunkRefs.join(', ')})` : '';
      const defInfo = c.definition ? ` — ${c.definition}` : '';
      sections.push(`- **${c.name}**${defInfo}${chunkInfo}`);
    }
  }

  if (entities.decisions.length > 0) {
    sections.push('\n### Decisions');
    for (const d of entities.decisions) {
      const chunkInfo = d.chunkRefs.length ? ` (chunks: ${d.chunkRefs.join(', ')})` : '';
      const statusInfo = d.status ? ` [${d.status}]` : '';
      const dateInfo = d.date ? ` (${d.date})` : '';
      sections.push(`- **${d.title}**${statusInfo}${dateInfo}${chunkInfo}`);
    }
  }

  if (entities.open_questions.length > 0) {
    sections.push('\n### Open Questions');
    for (const q of entities.open_questions) {
      const chunkInfo = q.chunkRefs.length ? ` (chunks: ${q.chunkRefs.join(', ')})` : '';
      sections.push(`- ${q.question}${chunkInfo}`);
    }
  }

  return sections.join('\n') || 'No entities detected.';
}

function serializeEntitiesForPayload(entities: ExtractedEntities): Record<string, unknown> {
  return {
    people: entities.people.map((p) => ({ name: p.name, role: p.role, context: p.context, chunkRefs: p.chunkRefs })),
    projects: entities.projects.map((p) => ({ name: p.name, status: p.status, context: p.context, chunkRefs: p.chunkRefs })),
    concepts: entities.concepts.map((c) => ({ name: c.name, definition: c.definition, chunkRefs: c.chunkRefs })),
    decisions: entities.decisions.map((d) => ({ name: d.title, status: d.status, context: d.context, chunkRefs: d.chunkRefs })),
  };
}

// ---------------------------------------------------------------------------
// Rich variant: extracts entities WITH relationships and cascades to
// compile-entities instead of link-concepts
// ---------------------------------------------------------------------------

const richLog = createLogger('handler:extract-entities-rich');

export const extractEntitiesRichHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = job.targetPath;
    if (!summaryPath) throw new Error('extract-entities-rich: no targetPath');

    const rawPath = job.payload.rawPath as string;
    if (!rawPath) throw new Error('extract-entities-rich: no rawPath in payload');

    // Read raw content
    const rawContent = await context.vault.read(rawPath);

    // Read source summary
    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    const sourceType = (data.source_type as SourceType) ?? 'plaintext';
    const sourceHash = (data.source_hash as string) ?? '';

    // Chunk and extract
    const chunkResult = chunkDocument(rawContent, sourceType, sourceHash, {
      maxChunkSize: context.config.enrichment.maxChunkSize,
      overlap: context.config.enrichment.chunkOverlap,
    });

    let entities: RichExtractedEntities;
    const richResult = chunkResult.chunks.length === 1
      ? await extractEntitiesRich(context.llm, chunkResult.chunks[0].content)
      : await extractEntitiesRichFromChunks(context.llm, chunkResult.chunks);
    if (richResult.status === 'error') throw new Error(`Rich entity extraction failed: ${richResult.error}`);
    entities = richResult.data;

    // Format entities as wikilinked bullets (reuses the same formatting for display)
    const formattedEntities = formatRichEntitiesMarkdown(entities);

    // Update protected region
    let updatedBody = updateProtectedRegion(body, 'entities', formattedEntities);
    data.ingest_status = 'extracted';
    data.updated_at = nowISO();

    const updated = serializeNote(data, updatedBody);
    await context.vault.atomicWrite(summaryPath, updated);

    richLog.info('Rich entities extracted', {
      path: summaryPath,
      people: entities.people.length,
      projects: entities.projects.length,
      concepts: entities.concepts.length,
      topics: entities.topics.length,
      decisions: entities.decisions.length,
      tools: entities.tools.length,
      organizations: entities.organizations.length,
    });

    // Cascade: compile-entities with rich entity data
    if (context.config.enrichment.autoCreateEntities) {
      await context.enqueue({
        type: 'compile-entities',
        targetPath: summaryPath,
        payload: {
          entities: serializeRichEntitiesForPayload(entities),
          sourceSummaryPath: summaryPath,
        },
        trigger: 'cascade',
        priority: 60,
        dedupeKey: `compile:${sourceHash}`,
      });
    }
  },
};

function formatRichEntitiesMarkdown(entities: RichExtractedEntities): string {
  const sections: string[] = [];

  if (entities.people.length > 0) {
    sections.push('### People');
    for (const p of entities.people) {
      const chunkInfo = p.chunkRefs.length ? ` (chunks: ${p.chunkRefs.join(', ')})` : '';
      const roleInfo = p.role ? ` — ${p.role}` : '';
      const contextInfo = p.context ? ` — ${p.context}` : '';
      sections.push(`- **${p.name}**${roleInfo}${contextInfo}${chunkInfo}`);
    }
  }

  if (entities.projects.length > 0) {
    sections.push('\n### Projects');
    for (const p of entities.projects) {
      const chunkInfo = p.chunkRefs.length ? ` (chunks: ${p.chunkRefs.join(', ')})` : '';
      const statusInfo = p.status ? ` [${p.status}]` : '';
      const contextInfo = p.context ? ` — ${p.context}` : '';
      sections.push(`- **${p.name}**${statusInfo}${contextInfo}${chunkInfo}`);
    }
  }

  if (entities.concepts.length > 0) {
    sections.push('\n### Concepts');
    for (const c of entities.concepts) {
      const chunkInfo = c.chunkRefs.length ? ` (chunks: ${c.chunkRefs.join(', ')})` : '';
      const defInfo = c.definition ? ` — ${c.definition}` : '';
      sections.push(`- **${c.name}**${defInfo}${chunkInfo}`);
    }
  }

  if (entities.topics.length > 0) {
    sections.push('\n### Topics');
    for (const t of entities.topics) {
      const chunkInfo = t.chunkRefs.length ? ` (chunks: ${t.chunkRefs.join(', ')})` : '';
      const defInfo = t.definition ? ` — ${t.definition}` : '';
      sections.push(`- **${t.name}**${defInfo}${chunkInfo}`);
    }
  }

  if (entities.decisions.length > 0) {
    sections.push('\n### Decisions');
    for (const d of entities.decisions) {
      const chunkInfo = d.chunkRefs.length ? ` (chunks: ${d.chunkRefs.join(', ')})` : '';
      const statusInfo = d.status ? ` [${d.status}]` : '';
      const dateInfo = d.date ? ` (${d.date})` : '';
      sections.push(`- **${d.title}**${statusInfo}${dateInfo}${chunkInfo}`);
    }
  }

  if (entities.tools.length > 0) {
    sections.push('\n### Tools');
    for (const t of entities.tools) {
      const chunkInfo = t.chunkRefs.length ? ` (chunks: ${t.chunkRefs.join(', ')})` : '';
      const contextInfo = t.context ? ` — ${t.context}` : '';
      sections.push(`- **${t.name}**${contextInfo}${chunkInfo}`);
    }
  }

  if (entities.organizations.length > 0) {
    sections.push('\n### Organizations');
    for (const o of entities.organizations) {
      const chunkInfo = o.chunkRefs.length ? ` (chunks: ${o.chunkRefs.join(', ')})` : '';
      const contextInfo = o.context ? ` — ${o.context}` : '';
      sections.push(`- **${o.name}**${contextInfo}${chunkInfo}`);
    }
  }

  if (entities.open_questions.length > 0) {
    sections.push('\n### Open Questions');
    for (const q of entities.open_questions) {
      const chunkInfo = q.chunkRefs.length ? ` (chunks: ${q.chunkRefs.join(', ')})` : '';
      sections.push(`- ${q.question}${chunkInfo}`);
    }
  }

  return sections.join('\n') || 'No entities detected.';
}

function serializeRichEntitiesForPayload(entities: RichExtractedEntities): Record<string, unknown> {
  return {
    people: entities.people.map((p) => ({
      name: p.name, role: p.role, context: p.context,
      relationships: p.relationships, chunkRefs: p.chunkRefs,
    })),
    projects: entities.projects.map((p) => ({
      name: p.name, status: p.status, context: p.context,
      relationships: p.relationships, chunkRefs: p.chunkRefs,
    })),
    concepts: entities.concepts.map((c) => ({
      name: c.name, definition: c.definition,
      relationships: c.relationships, chunkRefs: c.chunkRefs,
    })),
    topics: entities.topics.map((t) => ({
      name: t.name, definition: t.definition,
      relationships: t.relationships, chunkRefs: t.chunkRefs,
    })),
    decisions: entities.decisions.map((d) => ({
      title: d.title, status: d.status, date: d.date, context: d.context,
      relationships: d.relationships, chunkRefs: d.chunkRefs,
    })),
    tools: entities.tools.map((t) => ({
      name: t.name, context: t.context,
      relationships: t.relationships, chunkRefs: t.chunkRefs,
    })),
    organizations: entities.organizations.map((o) => ({
      name: o.name, context: o.context,
      relationships: o.relationships, chunkRefs: o.chunkRefs,
    })),
    open_questions: entities.open_questions.map((q) => ({
      question: q.question, context: q.context, chunkRefs: q.chunkRefs,
    })),
  };
}

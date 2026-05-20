import { z } from 'zod';
import type { LLMClient } from './llm-client.js';
import type { EnrichmentResult } from './types.js';
import { extractEntitiesRichPrompt, extractEntitiesRichChunkPrompt } from './prompts.js';
import type { Chunk } from '../ingest/chunker.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('entity-extractor-rich');

// Use nullable().optional() for string fields since LLMs often return null
const optStr = z.string().nullable().optional().transform((v) => v ?? undefined);

const RelationshipSchema = z.object({
  target: z.string(),
  targetKind: z.string(),
  relationship: z.string(),
});

const RichExtractedEntitiesSchema = z.object({
  people: z.array(z.object({
    name: z.string(),
    role: optStr,
    context: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  projects: z.array(z.object({
    name: z.string(),
    status: optStr,
    context: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  concepts: z.array(z.object({
    name: z.string(),
    definition: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  topics: z.array(z.object({
    name: z.string(),
    definition: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  decisions: z.array(z.object({
    title: z.string(),
    status: optStr,
    date: optStr,
    context: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  tools: z.array(z.object({
    name: z.string(),
    context: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  organizations: z.array(z.object({
    name: z.string(),
    context: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    relationships: z.array(RelationshipSchema).default([]),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
  open_questions: z.array(z.object({
    question: z.string(),
    context: optStr,
    confidence: z.number().min(0).max(1).default(0.5),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
});

export type RichExtractedEntities = z.output<typeof RichExtractedEntitiesSchema>;

const EMPTY_ENTITIES: RichExtractedEntities = {
  people: [],
  projects: [],
  concepts: [],
  topics: [],
  decisions: [],
  tools: [],
  organizations: [],
  open_questions: [],
};

export async function extractEntitiesRich(
  llm: LLMClient,
  text: string,
): Promise<EnrichmentResult<RichExtractedEntities>> {
  if (!text.trim()) return { status: 'success', data: EMPTY_ENTITIES };

  try {
    const data = await llm.extractStructured(extractEntitiesRichPrompt(text), RichExtractedEntitiesSchema);
    return { status: 'success', data };
  } catch (err) {
    log.error('Rich entity extraction failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}

export async function extractEntitiesRichFromChunks(
  llm: LLMClient,
  chunks: Chunk[],
): Promise<EnrichmentResult<RichExtractedEntities>> {
  if (chunks.length === 0) return { status: 'success', data: EMPTY_ENTITIES };

  // Single chunk — use direct extraction
  if (chunks.length === 1) {
    const result = await extractEntitiesRich(llm, chunks[0].content);
    if (result.status === 'error') return result;
    return { status: 'success', data: tagChunkRefs(result.data, chunks[0].chunkId) };
  }

  try {
    // Extract from each chunk
    const perChunk: Array<{ chunkId: string; entities: RichExtractedEntities }> = [];

    for (const chunk of chunks) {
      try {
        const parsed = await llm.extractStructured(
          extractEntitiesRichChunkPrompt(chunk.content, chunk.chunkId, chunk.headingContext),
          RichExtractedEntitiesSchema,
        );
        perChunk.push({ chunkId: chunk.chunkId, entities: tagChunkRefs(parsed, chunk.chunkId) });
      } catch (err) {
        log.warn('Chunk rich entity extraction failed', { chunkId: chunk.chunkId, error: (err as Error).message });
      }
    }

    // Merge results across chunks
    return { status: 'success', data: mergeRichExtractedEntities(perChunk.map((pc) => pc.entities)) };
  } catch (err) {
    log.error('Chunked rich entity extraction failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}

function tagChunkRefs(entities: RichExtractedEntities, chunkId: string): RichExtractedEntities {
  return {
    people: entities.people.map((p) => ({ ...p, chunkRefs: p.chunkRefs.length ? p.chunkRefs : [chunkId] })),
    projects: entities.projects.map((p) => ({ ...p, chunkRefs: p.chunkRefs.length ? p.chunkRefs : [chunkId] })),
    concepts: entities.concepts.map((c) => ({ ...c, chunkRefs: c.chunkRefs.length ? c.chunkRefs : [chunkId] })),
    topics: entities.topics.map((t) => ({ ...t, chunkRefs: t.chunkRefs.length ? t.chunkRefs : [chunkId] })),
    decisions: entities.decisions.map((d) => ({ ...d, chunkRefs: d.chunkRefs.length ? d.chunkRefs : [chunkId] })),
    tools: entities.tools.map((t) => ({ ...t, chunkRefs: t.chunkRefs.length ? t.chunkRefs : [chunkId] })),
    organizations: entities.organizations.map((o) => ({ ...o, chunkRefs: o.chunkRefs.length ? o.chunkRefs : [chunkId] })),
    open_questions: entities.open_questions.map((q) => ({ ...q, chunkRefs: q.chunkRefs.length ? q.chunkRefs : [chunkId] })),
  };
}

export function mergeRichExtractedEntities(results: RichExtractedEntities[]): RichExtractedEntities {
  if (results.length === 0) return EMPTY_ENTITIES;
  if (results.length === 1) return results[0];

  return {
    people: mergeByKey(results.flatMap((r) => r.people), 'name'),
    projects: mergeByKey(results.flatMap((r) => r.projects), 'name'),
    concepts: mergeByKey(results.flatMap((r) => r.concepts), 'name'),
    topics: mergeByKey(results.flatMap((r) => r.topics), 'name'),
    decisions: mergeByKey(results.flatMap((r) => r.decisions), 'title'),
    tools: mergeByKey(results.flatMap((r) => r.tools), 'name'),
    organizations: mergeByKey(results.flatMap((r) => r.organizations), 'name'),
    open_questions: mergeByKey(results.flatMap((r) => r.open_questions), 'question'),
  };
}

interface MergeableItem {
  chunkRefs: string[];
  confidence: number;
  relationships?: Array<{ target: string; targetKind: string; relationship: string }>;
  [key: string]: unknown;
}

function mergeByKey<T extends MergeableItem>(
  items: T[],
  keyField: string,
): T[] {
  const map = new Map<string, T>();

  for (const item of items) {
    const key = String(item[keyField]).toLowerCase().trim();
    const existing = map.get(key);

    if (existing) {
      // Merge: combine contexts and chunk refs
      const merged = { ...existing };

      // Combine string fields: take longer value or fill in missing
      for (const field of ['context', 'definition', 'role', 'status', 'date'] as const) {
        const existingVal = existing[field as keyof T] as string | undefined;
        const newVal = item[field as keyof T] as string | undefined;
        if (newVal && (!existingVal || newVal.length > existingVal.length)) {
          (merged as Record<string, unknown>)[field] = newVal;
        }
      }

      // Take the higher confidence score
      merged.confidence = Math.max(existing.confidence, item.confidence);

      // Merge chunk refs (deduplicated)
      merged.chunkRefs = [...new Set([...existing.chunkRefs, ...item.chunkRefs])];

      // Merge relationships (deduplicated by target+relationship)
      if (existing.relationships && item.relationships) {
        const seen = new Set(
          existing.relationships.map((r) => `${r.target.toLowerCase()}::${r.relationship.toLowerCase()}`),
        );
        const mergedRels = [...existing.relationships];
        for (const rel of item.relationships) {
          const relKey = `${rel.target.toLowerCase()}::${rel.relationship.toLowerCase()}`;
          if (!seen.has(relKey)) {
            seen.add(relKey);
            mergedRels.push(rel);
          }
        }
        merged.relationships = mergedRels;
      } else if (item.relationships) {
        merged.relationships = [...item.relationships];
      }

      map.set(key, merged);
    } else {
      map.set(key, { ...item });
    }
  }

  return [...map.values()];
}

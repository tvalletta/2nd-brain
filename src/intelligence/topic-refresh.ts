// B2: Topic-page refresh.
//
// Keeps a single topic/concept note thorough and current:
// 1. Pull supporting chunks via B4 retrieval (top-K).
// 2. Rewrite the `current-understanding` protected region with CoD over the
//    retrieved evidence — no contradiction overwrite (Karpathy v2 rule).
// 3. Append unseen sources to a `sources` list.
// 4. Bump `last_verified`. If no contradictions surfaced, bump `stability` modestly.
// 5. Log + return a structured result for the queue.

import { z } from 'zod';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { EmbeddingStore } from '../embeddings/store.js';
import type { KarpathyConfig } from '../config/schema.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import {
  OPEN_TAG,
  CLOSE_TAG,
  updateProtectedRegion,
} from '../vault/protected-regions.js';
import { retrieve } from './retrieval.js';
import { defaultStability } from '../vault/half-life.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { extractOutlinks } from '../maintenance/backlinks.js';
import { buildEntityIndex } from '../ingest/entity-resolver.js';
import { markDirty } from '../maintenance/mark-dirty.js';
import { slugify } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('topic-refresh');

export const CURRENT_UNDERSTANDING_REGION = 'current-understanding';
export const SOURCES_REGION = 'sources';

export interface RefreshOptions {
  topK?: number;
  /** When at least one contradiction is reported by the LLM, do NOT bump stability. */
  bumpStabilityFactor?: number; // multiplicative. default 1.1, capped at 4× domain default.
  nowMs?: number;
}

export interface RefreshDeps {
  vault: VaultAdapter;
  llm: LLMClient;
  store: EmbeddingStore;
  config: KarpathyConfig;
}

const SynthesisSchema = z.object({
  current_understanding: z.string(),
  contradictions: z
    .array(z.object({ ref: z.string(), reason: z.string() }))
    .default([]),
  new_sources: z.array(z.string()).default([]),
});

export interface RefreshResult {
  notePath: string;
  retrievedCount: number;
  contradictionCount: number;
  newSourcesAdded: number;
  stabilityBefore: number | undefined;
  stabilityAfter: number;
  lastVerified: string;
  /** Phase 1: count of pending_evidence entries cleared. */
  pendingCleared: number;
  /**
   * Phase 1: count of neighbor concept pages that were mark-dirtied as part
   * of the depth-1 cascade. 0 when `cascadeDepth: 0`.
   */
  neighborsCascaded: number;
}

export async function refreshTopic(
  deps: RefreshDeps,
  notePath: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const topK = options.topK ?? 12;
  const bumpFactor = options.bumpStabilityFactor ?? 1.1;
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const raw = await deps.vault.read(notePath);
  const { data, body } = parseNote(raw);
  const fm = data as Record<string, unknown>;
  const title = typeof fm.title === 'string' ? fm.title : notePath;
  const tldr = typeof fm.tldr === 'string' ? fm.tldr : '';

  const currentUnderstanding =
    extractRegion(body, CURRENT_UNDERSTANDING_REGION) ?? '(no current understanding yet)';

  // Stage 1: retrieve supporting evidence — exclude the topic note itself.
  const queryText = [title, tldr, currentUnderstanding].filter(Boolean).join('\n');
  const hits = await retrieve({ store: deps.store, config: deps.config }, queryText, {
    topK,
    filter: (h) => h.doc_id !== notePath,
  });

  // Phase 1: capture how many pending entries we're about to clear.
  const pendingCleared = Array.isArray(fm.pending_evidence)
    ? (fm.pending_evidence as unknown[]).length
    : 0;

  if (hits.length === 0) {
    // Nothing new to integrate — still bump last_verified and clear any
    // pending_evidence (we tried; the queue would otherwise re-trigger
    // refreshes forever) so we don't keep re-trying on every decay scan.
    fm.last_verified = nowIso;
    fm.pending_evidence = [];
    fm.pending_evidence_count = 0;
    await deps.vault.atomicWrite(notePath, serializeNote(fm, body));
    return {
      notePath,
      retrievedCount: 0,
      contradictionCount: 0,
      newSourcesAdded: 0,
      stabilityBefore: typeof fm.stability === 'number' ? fm.stability : undefined,
      stabilityAfter: typeof fm.stability === 'number' ? fm.stability : 0,
      lastVerified: nowIso,
      pendingCleared,
      neighborsCascaded: 0,
    };
  }

  // Stage 2: synthesis prompt.
  const evidence = hits
    .map(
      (h, i) =>
        `[${i + 1}] (${h.doc_id}, updated ${h.updated_at})\n${h.text.slice(0, 1200)}`,
    )
    .join('\n\n');
  const prompt = `You are refreshing a topic note in a personal knowledge base.

Topic: ${title}
Current understanding (from existing note):
"""
${currentUnderstanding}
"""

New evidence (most recent retrievals):
${evidence}

Produce a JSON object with these fields:
{
  "current_understanding": "≤8 paragraphs. Chain-of-density rewrite that integrates the new evidence into the topic note. Cite sources inline as [n] matching the evidence numbers above. Do NOT overwrite or hide claims that disagree with new evidence — instead surface them as contradictions.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;

  let synthesis;
  try {
    synthesis = await deps.llm.extractStructured(prompt, SynthesisSchema);
  } catch (err) {
    // Bail without modifying the note.
    throw new Error(`topic synthesis failed for ${notePath}: ${(err as Error).message}`);
  }

  // Apply update.
  let nextBody = body;
  nextBody = upsertRegion(nextBody, CURRENT_UNDERSTANDING_REGION, synthesis.current_understanding.trim());

  const existingSources = parseSourcesRegion(extractRegion(nextBody, SOURCES_REGION) ?? '');
  const newSources = synthesis.new_sources.filter((s) => !existingSources.has(s));
  const sourcesBlock = formatSources(new Set([...existingSources, ...newSources]));
  nextBody = upsertRegion(nextBody, SOURCES_REGION, sourcesBlock);

  // Frontmatter updates.
  fm.last_verified = nowIso;
  const previousStability = typeof fm.stability === 'number' ? fm.stability : undefined;
  let nextStability = previousStability ?? defaultStability((fm.half_life_domain as string | undefined) ?? 'topic');
  if (synthesis.contradictions.length > 0) {
    // Reset stability to half on contradiction (flag for human review).
    nextStability = Math.max(7, nextStability / 2);
  } else {
    const ceiling = (defaultStability((fm.half_life_domain as string | undefined) ?? 'topic')) * 4;
    nextStability = Math.min(ceiling, nextStability * bumpFactor);
  }
  fm.stability = Math.round(nextStability);

  if (synthesis.contradictions.length > 0) {
    const existing = Array.isArray(fm.contradicts) ? (fm.contradicts as Array<Record<string, unknown>>) : [];
    fm.contradicts = [
      ...existing,
      ...synthesis.contradictions.map((c) => ({ ref: c.ref, reason: c.reason })),
    ];
  }

  // Track regions in protected_regions list.
  const regions = new Set<string>(
    Array.isArray(fm.protected_regions) ? (fm.protected_regions as string[]) : [],
  );
  regions.add(CURRENT_UNDERSTANDING_REGION);
  regions.add(SOURCES_REGION);
  fm.protected_regions = [...regions];

  // Phase 1: clear the pending_evidence queue — we've just integrated it.
  fm.pending_evidence = [];
  fm.pending_evidence_count = 0;

  await deps.vault.atomicWrite(notePath, serializeNote(fm, nextBody));
  const { layoutFromConfig } = await import('../vault/paths.js');
  await appendLogEntry(
    deps.vault,
    {
      kind: 'topic:refresh',
      message: `${notePath} ← ${hits.length} sources, ${synthesis.contradictions.length} contradictions`,
      at: nowIso,
    },
    layoutFromConfig(deps.config),
  );

  // Phase 1: cascade depth-1. Mark-dirty the direct neighbors referenced in
  // the rewritten current-understanding region. We do NOT auto-enqueue
  // refresh — the threshold gate inside `evaluate-refresh-candidates` will
  // pull them in only if their evidence (or staleness) accumulates. This
  // keeps blast radius bounded.
  let neighborsCascaded = 0;
  const cascadeDepth = deps.config.intelligence.refresh.cascadeDepth;
  if (cascadeDepth >= 1) {
    try {
      const newRegion = synthesis.current_understanding;
      const linkedNames = extractOutlinks(newRegion);
      if (linkedNames.length > 0) {
        const index = await buildEntityIndex(deps.vault);
        const seen = new Set<string>();
        for (const name of linkedNames) {
          // Resolve via slug match — same logic as resolveEntity. We accept
          // any matched path regardless of folder (concepts, projects, etc).
          const slug = slugify(name);
          const path =
            index.bySlug.get(slug) ??
            index.byCanonicalName.get(name.trim().toLowerCase()) ??
            index.byAlias.get(name.trim().toLowerCase());
          if (!path || path === notePath || seen.has(path)) continue;
          seen.add(path);
          try {
            const r = await markDirty(deps.vault, {
              notePath: path,
              ref: notePath,
              reason: 'cascade-from-refresh',
            });
            if (r.added) neighborsCascaded++;
          } catch (err) {
            log.warn('cascade markDirty failed', {
              path,
              error: (err as Error).message,
            });
          }
        }
      }
    } catch (err) {
      log.warn('cascade phase failed', { error: (err as Error).message });
    }
  }

  return {
    notePath,
    retrievedCount: hits.length,
    contradictionCount: synthesis.contradictions.length,
    newSourcesAdded: newSources.length,
    stabilityBefore: previousStability,
    stabilityAfter: fm.stability as number,
    lastVerified: nowIso,
    pendingCleared,
    neighborsCascaded,
  };
}


function extractRegion(body: string, regionId: string): string | null {
  const open = OPEN_TAG(regionId);
  const close = CLOSE_TAG(regionId);
  const oi = body.indexOf(open);
  const ci = oi >= 0 ? body.indexOf(close, oi + open.length) : -1;
  if (oi === -1 || ci === -1) return null;
  return body.slice(oi + open.length, ci).replace(/^\n/, '').replace(/\n$/, '');
}

function upsertRegion(body: string, regionId: string, content: string): string {
  return updateProtectedRegion(body, regionId, content);
}

function parseSourcesRegion(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[\[([^\]|]+)/);
    if (m) out.add(m[1].trim());
  }
  return out;
}

function formatSources(set: Set<string>): string {
  return [...set].sort().map((s) => `- [[${s}]]`).join('\n');
}

// B2: Topic-page refresh — generalized (B2b) to cover concept, topic,
// decision, and project notes via the REFRESH_TARGETS registry, instead of
// assuming every refreshable note has a `current-understanding` region.
//
// Keeps a single note's primary richness region thorough and current:
// 1. Pull supporting chunks via B4 retrieval (top-K).
// 2. Rewrite the note type's primary protected region with CoD over the
//    retrieved evidence — no contradiction overwrite (Karpathy v2 rule).
// 3. Append unseen sources to a `sources` list.
// 4. Bump `last_verified`. If no contradictions surfaced, bump `stability` modestly.
// 5. Log + return a structured result for the queue.

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
import { TransientLLMError } from '../shared/errors.js';
import { REFRESH_TARGETS, type RefreshTarget, type RefreshSynthesisResult } from './refresh-targets.js';

const log = createLogger('topic-refresh');

/**
 * Legacy constant, kept exported for backward compatibility. The dispatch
 * below now resolves the region to rewrite per note `type` via
 * REFRESH_TARGETS[noteType] instead of assuming this one region name fits
 * every refreshable type (it still happens to be correct for concept/topic).
 */
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
  const noteType = typeof fm.type === 'string' ? fm.type : 'topic';

  // Phase 1: capture how many pending entries we're about to clear. Computed
  // up front so every early-return branch below can report it accurately.
  const pendingCleared = Array.isArray(fm.pending_evidence)
    ? (fm.pending_evidence as unknown[]).length
    : 0;

  const target: RefreshTarget | undefined = (REFRESH_TARGETS as Record<string, RefreshTarget>)[noteType];

  if (!target) {
    // Unknown/unsupported type (e.g. project_spec — owned by
    // agent-synthesize-project instead). Bump last_verified and clear
    // pending_evidence so the queue doesn't spin forever, but do not touch
    // the body. Mirrors the "no evidence found" no-op branch below.
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

  const existingPrimary = extractRegion(body, target.primaryRegion) ?? '';
  const existingSecondary = target.secondaryRegion
    ? (extractRegion(body, target.secondaryRegion) ?? '')
    : undefined;

  // Stage 1: retrieve supporting evidence — exclude the note itself.
  const queryText = [title, tldr, existingPrimary, existingSecondary].filter(Boolean).join('\n');
  const hits = await retrieve({ store: deps.store, config: deps.config }, queryText, {
    topK,
    filter: (h) => h.doc_id !== notePath,
  });

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

  // Stage 2: synthesis prompt, dispatched per note type.
  const evidenceBlock = hits
    .map((h, i) => `[${i + 1}] (${h.doc_id}, updated ${h.updated_at})\n${h.text.slice(0, 1200)}`)
    .join('\n\n');
  const prompt = target.buildPrompt({ title, existingPrimary, existingSecondary, evidenceBlock });

  let synthesis: RefreshSynthesisResult;
  try {
    synthesis = await deps.llm.extractStructured(prompt, target.responseSchema);
  } catch (err) {
    // Bail without modifying the note. Preserve TransientLLMError identity so
    // the job runner's indefinite-retry lane actually sees it. Message text
    // ("topic synthesis failed for...") is kept exactly as before this
    // generalization — an existing regression test below asserts it verbatim.
    if (err instanceof TransientLLMError) throw err;
    throw new Error(`topic synthesis failed for ${notePath}: ${(err as Error).message}`);
  }

  // Apply update.
  let nextBody = body;
  nextBody = upsertRegion(nextBody, target.primaryRegion, synthesis.primary.trim());
  if (target.secondaryRegion && synthesis.secondary) {
    nextBody = upsertRegion(nextBody, target.secondaryRegion, synthesis.secondary.trim());
  }

  const existingSources = parseSourcesRegion(extractRegion(nextBody, SOURCES_REGION) ?? '');
  const newSources = synthesis.new_sources.filter((s) => !existingSources.has(s));
  const sourcesBlock = formatSources(new Set([...existingSources, ...newSources]));
  nextBody = upsertRegion(nextBody, SOURCES_REGION, sourcesBlock);

  // Frontmatter updates.
  fm.last_verified = nowIso;
  const previousStability = typeof fm.stability === 'number' ? fm.stability : undefined;
  let nextStability = previousStability ?? defaultStability((fm.half_life_domain as string | undefined) ?? noteType);
  if (synthesis.contradictions.length > 0) {
    // Reset stability to half on contradiction (flag for human review).
    nextStability = Math.max(7, nextStability / 2);
  } else {
    const ceiling = (defaultStability((fm.half_life_domain as string | undefined) ?? noteType)) * 4;
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
  regions.add(target.primaryRegion);
  if (target.secondaryRegion && synthesis.secondary) regions.add(target.secondaryRegion);
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
  // the rewritten primary region. We do NOT auto-enqueue refresh — the
  // threshold gate inside `evaluate-refresh-candidates` will pull them in
  // only if their evidence (or staleness) accumulates. This keeps blast
  // radius bounded.
  let neighborsCascaded = 0;
  const cascadeDepth = deps.config.intelligence.refresh.cascadeDepth;
  if (cascadeDepth >= 1) {
    try {
      const linkedNames = extractOutlinks(synthesis.primary);
      if (linkedNames.length > 0) {
        const index = await buildEntityIndex(deps.vault, deps.config.layout);
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

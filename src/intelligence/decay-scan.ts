// C1: Decay scan.
//
// Computes retrievability `R = exp(-Δt / S)` per note. Notes below the refresh
// threshold are enqueued for `topic:refresh`; below the archive threshold AND
// no inbound links → flagged for review. Also emits stale concept notes as
// research candidates (D1) when retrievability is very low and the note has
// confidence < 0.5.

import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { JobCreateInput } from '../jobs/types.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { defaultStability, retrievability } from '../vault/half-life.js';
import { upsertCandidate } from '../maintenance/research-queue.js';
import { layoutFromConfig } from '../vault/paths.js';

/** Folders we scan for decay (subset of wiki kinds). */
function targetFolders(layout: ReturnType<typeof layoutFromConfig>): string[] {
  return [
    `${layout.wiki}/concepts`,
    `${layout.wiki}/topics`,
    `${layout.wiki}/projects`,
    `${layout.wiki}/decisions`,
  ];
}

const REFRESHABLE_TYPES = new Set(['concept', 'topic', 'project', 'project_spec', 'decision']);
const RESEARCH_CANDIDATE_TYPES = new Set(['concept', 'topic']);

export interface DecayScanResult {
  scanned: number;
  refreshEnqueued: number;
  archiveCandidates: string[];
  researchCandidates: number;
}

export interface DecayScanDeps {
  vault: VaultAdapter;
  config: KarpathyConfig;
  enqueue: (input: JobCreateInput) => Promise<unknown>;
  /** Override `now`; used by tests. */
  nowMs?: number;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

function asNumber(v: unknown, fallback?: number): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  return fallback;
}

export async function runDecayScan(deps: DecayScanDeps): Promise<DecayScanResult> {
  const result: DecayScanResult = {
    scanned: 0,
    refreshEnqueued: 0,
    archiveCandidates: [],
    researchCandidates: 0,
  };
  const refreshThreshold = deps.config.intelligence.decay.retrievabilityRefresh;
  const archiveThreshold = deps.config.intelligence.decay.retrievabilityArchive;
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const layout = layoutFromConfig(deps.config);
  const vaultIndex = `${layout.wiki}/_index.md`;

  for (const folder of targetFolders(layout)) {
    if (!(await deps.vault.exists(folder))) continue;
    const files = await deps.vault.listMarkdownFiles(folder);
    for (const path of files) {
      if (path.endsWith('/_index.md') || path === vaultIndex) continue;
      const raw = await deps.vault.read(path);
      const { data, body } = parseNote(raw);
      const fm = data as Record<string, unknown>;
      const type = asString(fm.type) ?? '';
      if (!REFRESHABLE_TYPES.has(type)) continue;
      result.scanned += 1;

      const lastVerified = asString(fm.last_verified) ?? asString(fm.updated_at);
      const stability =
        asNumber(fm.stability) ??
        defaultStability((asString(fm.half_life_domain) as string | undefined) ?? type);
      const r = retrievability({
        lastVerifiedISO: lastVerified,
        stabilityDays: stability,
        nowMs,
      });

      // Persist the score for downstream consumers (research-queue, indexes).
      fm.retrievability = Number(r.toFixed(4));
      fm.retrievability_checked_at = nowIso;
      const inbound = countInboundLinks(body);

      if (r < archiveThreshold && inbound === 0) {
        result.archiveCandidates.push(path);
        fm.review_state = 'unreviewed';
        fm.archive_candidate = true;
      }

      if (r < refreshThreshold) {
        await deps.enqueue({
          type: 'topic-refresh',
          targetPath: path,
          trigger: 'cascade',
          priority: 75,
          dedupeKey: `topic-refresh:${path}`,
        });
        result.refreshEnqueued += 1;
      }

      // Surface low-confidence concept/topic notes as research candidates.
      if (RESEARCH_CANDIDATE_TYPES.has(type)) {
        const confidence = asString(fm.confidence);
        const lowConfidence = confidence === 'low';
        if (r < refreshThreshold && (lowConfidence || r < archiveThreshold)) {
          const slug = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
          await upsertCandidate(
            deps.vault,
            {
              slug,
              title: asString(fm.title) ?? slug,
              score: clamp01(0.6 * (1 - r) + (lowConfidence ? 0.2 : 0) + 0.2),
              reason: `Stale: retrievability ${r.toFixed(2)}${lowConfidence ? ', low confidence' : ''}.`,
              suggested: lowConfidence ? 'medium' : 'light',
              status: 'pending',
              addedAt: nowIso,
            },
            layout,
          );
          result.researchCandidates += 1;
        }
      }

      await deps.vault.atomicWrite(path, serializeNote(fm, body));
    }
  }
  return result;
}

function countInboundLinks(body: string): number {
  // Cheap heuristic; full backlinks live elsewhere. We just check whether
  // any obvious inbound markers exist within the note body itself (e.g.
  // it's referenced in a backlinks region). Detailed accounting can be
  // added once backlinks scanner exposes a query API.
  return (body.match(/%% begin:backlinks %%[\s\S]*?\[\[/g) ?? []).length;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

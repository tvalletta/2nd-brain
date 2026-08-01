// C1: Decay scan.
//
// Computes retrievability `R = exp(-Δt / S)` per note. Notes below the refresh
// threshold are enqueued for `topic:refresh`. Also emits stale concept/topic
// notes as research candidates (D1) when retrievability is below the refresh
// threshold and the note is either low-confidence or below the archive
// threshold too. (Sub-project C, G6: this file previously also flagged notes
// below the archive threshold with no inbound links via a dead, untested
// `archive_candidate` frontmatter write — removed; rot-scan's archive-queue
// feed, Sub-project C G3, is the real "detection with no action" fix for
// archival candidates now.)

import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { JobCreateInput } from '../jobs/types.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { defaultStability, retrievability } from '../vault/half-life.js';
import { upsertCandidate } from '../maintenance/research-queue.js';
import { layoutFromConfig } from '../vault/paths.js';
import { REFRESH_TARGETS, isPlaceholderContent, type RefreshTarget } from './refresh-targets.js';
import { getProtectedRegion } from '../vault/protected-regions.js';

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
  thinContentEnqueued: number;
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
    thinContentEnqueued: 0,
    researchCandidates: 0,
  };
  const refreshThreshold = deps.config.intelligence.decay.retrievabilityRefresh;
  // Sub-project C (G6) removed the dead `if (r < archiveThreshold && inbound
  // === 0)` archive_candidate write below, but `archiveThreshold` itself is
  // NOT dead config: it's still read a few lines further down, in the
  // low-confidence research-candidate gate (`r < refreshThreshold &&
  // (lowConfidence || r < archiveThreshold)`). Kept.
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

      // Persist the score for downstream consumers (research-queue, indexes,
      // and rot-scan's RotEntry.retrievability display field — that path is
      // unaffected by the G6 removal below, since it reads this same
      // fm.retrievability stamp, not the deleted archive-candidate branch).
      fm.retrievability = Number(r.toFixed(4));
      fm.retrievability_checked_at = nowIso;

      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
      // Gated on intelligence.richness.enabled: this is the thin-content
      // backfill mechanism (G2), not the underlying region-aware refresh
      // dispatch (G1) — disabling richness must fall back to the pre-B2b
      // behavior of enqueuing topic-refresh from retrievability decay alone.
      const richnessEnabled = deps.config.intelligence.richness.enabled;
      const relatedConceptsEmpty =
        richnessEnabled &&
        (type === 'concept' || type === 'topic') &&
        !(getProtectedRegion(body, 'related-concepts') ?? '').trim();
      const isThin =
        richnessEnabled &&
        ((target ? isPlaceholderContent(target, getProtectedRegion(body, target.primaryRegion)) : false) ||
          relatedConceptsEmpty);

      if ((r < refreshThreshold || isThin) && target) {
        await deps.enqueue({
          type: 'topic-refresh',
          targetPath: path,
          trigger: isThin ? 'thin-content' : 'cascade',
          priority: isThin ? 80 : 75, // thin-content backfill takes slight priority
          dedupeKey: `topic-refresh:${path}`,
        });
        result.refreshEnqueued += 1;
        if (isThin) result.thinContentEnqueued += 1;
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

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

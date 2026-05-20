// Phase 1 (cascading curation): evaluate-refresh-candidates handler.
//
// Threshold gate between mark-dirty and topic-refresh. Decides — without
// any LLM calls — whether a note's pending evidence has accumulated enough
// to warrant a refresh, or whether the note has decayed below the
// retrievability floor and should be refreshed regardless.
//
// Lane 1 (deterministic). No LLM, no embedding calls. Fast and idempotent
// (dedupeKey: `refresh-eval:${notePath}`).
//
// Outcomes:
// 1. `pending_evidence_count >= refresh.threshold` → enqueue topic-refresh
// 2. `considerRetrievability` AND `R < decay.retrievabilityRefresh`
//    AND there is at least one pending evidence → enqueue topic-refresh
// 3. otherwise → no-op (logged at debug)

import type { JobHandler } from '../types.js';
import { parseNote } from '../../vault/frontmatter.js';
import { retrievability } from '../../vault/half-life.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('evaluate-refresh-candidates');

export const evaluateRefreshCandidatesHandler: JobHandler = {
  async execute(job, ctx) {
    const notePath = job.targetPath;
    if (!notePath) {
      log.warn('evaluate-refresh-candidates: missing targetPath');
      return;
    }
    const refreshCfg = ctx.config.intelligence.refresh;
    if (!refreshCfg.enabled) return;

    if (!(await ctx.vault.exists(notePath))) {
      log.debug('note missing — skipping', { notePath });
      return;
    }

    const raw = await ctx.vault.read(notePath);
    const { data } = parseNote(raw);
    const fm = data as Record<string, unknown>;

    const pendingCount =
      typeof fm.pending_evidence_count === 'number'
        ? fm.pending_evidence_count
        : Array.isArray(fm.pending_evidence)
          ? fm.pending_evidence.length
          : 0;

    let shouldRefresh = false;
    let reason: string | undefined;

    if (pendingCount >= refreshCfg.threshold) {
      shouldRefresh = true;
      reason = `evidence-threshold:${pendingCount}>=${refreshCfg.threshold}`;
    } else if (refreshCfg.considerRetrievability && pendingCount > 0) {
      const r = retrievability({
        lastVerifiedISO:
          typeof fm.last_verified === 'string'
            ? fm.last_verified
            : typeof fm.updated_at === 'string'
              ? fm.updated_at
              : undefined,
        stabilityDays: typeof fm.stability === 'number' ? fm.stability : undefined,
      });
      const floor = ctx.config.intelligence.decay.retrievabilityRefresh;
      if (r < floor) {
        shouldRefresh = true;
        reason = `retrievability:${r.toFixed(3)}<${floor}`;
      }
    }

    if (!shouldRefresh) {
      log.debug('below threshold — no refresh', { notePath, pendingCount });
      return;
    }

    log.info('enqueuing topic-refresh', { notePath, reason, pendingCount });
    await ctx.enqueue({
      type: 'topic-refresh',
      targetPath: notePath,
      trigger: 'cascade',
      priority: 75,
      dedupeKey: `topic-refresh:${notePath}`,
      payload: { reason },
    });
  },
};

import Database from 'better-sqlite3';

/** Confirmed with Tom (spec §10, 2026-07-14): raw/ is pre-ingestion staging,
 * not curated/retrievable target content — excluded from Arm B's backfill
 * scope even though it's part of the live index's unembedded docs. */
export const BACKFILL_PREFIXES = ['Plaud/', 'Curated/sources/', 'AI Conversations/'] as const;

/** Doc_ids under the 3 confirmed scope prefixes that have no embedding row
 * under the CURRENT dominant provider_id — mirrors eval/score/coverage.ts's
 * exact "dominant provider" convention (a doc embedded only under a stale/
 * minority provider_id still counts as needing backfill for the real one). */
export function selectBackfillTargets(db: Database.Database): string[] {
  const dominant = db
    .prepare('SELECT provider_id, COUNT(DISTINCT doc_id) c FROM embeddings GROUP BY provider_id ORDER BY c DESC LIMIT 1')
    .get() as { provider_id: string } | undefined;
  const providerId = dominant?.provider_id ?? '';

  const like = (prefix: string) => prefix.replace(/[%_]/g, '\\$&') + '%';
  const clauses = BACKFILL_PREFIXES.map(() => "doc_id LIKE ? ESCAPE '\\'").join(' OR ');
  const rows = db
    .prepare(
      `SELECT doc_id FROM fts_meta
       WHERE (${clauses})
       AND doc_id NOT IN (SELECT doc_id FROM embeddings WHERE provider_id = ?)`,
    )
    .all(...BACKFILL_PREFIXES.map(like), providerId) as { doc_id: string }[];

  return rows.map((r) => r.doc_id);
}

export interface BackfillReport {
  notes_embedded: number;
  notes_failed: number;
  wall_clock_min: number;
  token_cost_estimate: number;
  db_size_before_bytes: number;
  db_size_after_bytes: number;
  db_size_delta_gb: number;
  failed_doc_ids: string[];
}

/** Assembles the backfill report with field names matching spec §6.2's
 * backfill_ledger shape exactly, so the eventual bake-off assembly step can
 * consume this file without reshaping it. */
export function buildBackfillReport(input: {
  notesEmbedded: number;
  failedDocIds: string[];
  wallClockMs: number;
  tokenCostEstimate: number;
  dbSizeBeforeBytes: number;
  dbSizeAfterBytes: number;
}): BackfillReport {
  const GIB = 1_073_741_824;
  return {
    notes_embedded: input.notesEmbedded,
    notes_failed: input.failedDocIds.length,
    wall_clock_min: +(input.wallClockMs / 60_000).toFixed(2),
    token_cost_estimate: input.tokenCostEstimate,
    db_size_before_bytes: input.dbSizeBeforeBytes,
    db_size_after_bytes: input.dbSizeAfterBytes,
    db_size_delta_gb: +((input.dbSizeAfterBytes - input.dbSizeBeforeBytes) / GIB).toFixed(2),
    failed_doc_ids: input.failedDocIds,
  };
}

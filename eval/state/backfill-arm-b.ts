import Database from 'better-sqlite3';
import { copyFileSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openVariantStore } from '../run/open-store.js';
import { chunkText } from '../../src/embeddings/store.js';
import { parseNote } from '../../src/vault/frontmatter.js';

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

/** Total docs under the 3 scope prefixes, regardless of embedded status —
 * used with `selectBackfillTargets`'s remaining-count to compute an
 * always-correct "notes_embedded" total (totalInScope - stillRemaining),
 * independent of how many invocations it took to get there. */
export function countInScopeDocs(db: Database.Database): number {
  const like = (prefix: string) => prefix.replace(/[%_]/g, '\\$&') + '%';
  const clauses = BACKFILL_PREFIXES.map(() => "doc_id LIKE ? ESCAPE '\\'").join(' OR ');
  const row = db.prepare(`SELECT COUNT(*) c FROM fts_meta WHERE (${clauses})`).get(...BACKFILL_PREFIXES.map(like)) as {
    c: number;
  };
  return row.c;
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

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONCURRENCY = 6;

/** Runs `worker` over `items` with at most `limit` in flight at once. A
 * single item's rejection is caught by the caller's own try/catch inside
 * `worker` — this helper only bounds concurrency, it does not swallow
 * errors itself. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runNext(): Promise<void> {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i]);
    return runNext();
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(lanes);
}

interface BackfillProgress {
  dbSizeBeforeBytes: number;
  wallClockMsAccumulated: number;
  tokenCostEstimateAccumulated: number;
}

async function main() {
  const { loadConfig } = await import('../../src/config/loader.js');
  const config = await loadConfig(REPO_ROOT);

  const liveDbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const copyDbPath = join(REPO_ROOT, 'eval', 'state', 'bakeoff-fullcov.sqlite');
  const progressPath = join(REPO_ROOT, 'eval', 'state', 'bakeoff-fullcov.progress.json');
  mkdirSync(join(REPO_ROOT, 'eval', 'state'), { recursive: true });

  const dbAlreadyExists = existsSync(copyDbPath);
  const progressAlreadyExists = existsSync(progressPath);

  if (dbAlreadyExists && !progressAlreadyExists) {
    throw new Error(
      `${copyDbPath} already exists but its progress ledger ${progressPath} is missing — ` +
        `this looks like a stale/foreign file, not a resumable backfill run. Delete ${copyDbPath} ` +
        `(and any -shm/-wal sidecar files) to start fresh, or restore the matching progress ledger.`,
    );
  }

  let progress: BackfillProgress;
  if (dbAlreadyExists) {
    console.log(`Resuming from existing copy at ${copyDbPath} (not overwriting with a fresh copy from ${liveDbPath})`);
    progress = JSON.parse(readFileSync(progressPath, 'utf8'));
  } else {
    console.log(`Copying ${liveDbPath} -> ${copyDbPath}`);
    copyFileSync(liveDbPath, copyDbPath);
    progress = { dbSizeBeforeBytes: statSync(copyDbPath).size, wallClockMsAccumulated: 0, tokenCostEstimateAccumulated: 0 };
    // Write the ledger immediately, not just at the end — if this run
    // crashes mid-backfill, the DB copy and its ledger must exist together
    // from the start so a retry can legitimately resume instead of hitting
    // the stale-file guard and being forced to discard partial progress.
    writeFileSync(progressPath, JSON.stringify(progress, null, 2));
  }

  const readonlyDb = new Database(copyDbPath, { readonly: true });
  const targets = selectBackfillTargets(readonlyDb);
  readonlyDb.close();
  console.log(`${targets.length} docs to backfill (scope: ${BACKFILL_PREFIXES.join(', ')})`);

  const store = openVariantStore(config, copyDbPath, {});
  let tokenCostEstimateThisRun = 0;
  let processed = 0;
  const startMs = Date.now();

  await runWithConcurrency(targets, CONCURRENCY, async (path) => {
    try {
      const raw = readFileSync(join(config.vaultPath, path), 'utf8');
      const { data, body } = parseNote(raw);
      const fm = data as Record<string, unknown>;
      const chunks = chunkText(body, 1200, 4000);
      const title = typeof fm.title === 'string' && fm.title.length > 0 ? fm.title : path;

      tokenCostEstimateThisRun += Math.ceil(body.length / 4);

      await store.upsertDoc(
        path,
        title,
        body,
        chunks.map((c) => ({
          doc_id: path,
          chunk_index: c.index,
          chunk_hash: c.hash,
          text: c.text,
          metadata: {
            type: typeof fm.type === 'string' ? fm.type : 'unknown',
            title,
          },
        })),
      );
    } catch (err) {
      console.error(`Failed to backfill ${path}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      processed += 1;
      if (processed % 500 === 0) {
        const elapsedSec = (Date.now() - startMs) / 1000;
        console.log(`${processed}/${targets.length} processed, ${elapsedSec.toFixed(0)}s elapsed, ${(processed / elapsedSec).toFixed(1)}/s`);
      }
    }
  });

  store.close();
  const wallClockMsThisRun = Date.now() - startMs;
  const dbSizeAfterBytes = statSync(copyDbPath).size;

  // Persist accumulated cost so a resumed run's report reflects the TRUE
  // total cost across every invocation, not just this one's own slice.
  progress.wallClockMsAccumulated += wallClockMsThisRun;
  progress.tokenCostEstimateAccumulated += tokenCostEstimateThisRun;
  writeFileSync(progressPath, JSON.stringify(progress, null, 2));

  // notes_embedded/failed_doc_ids are recomputed from a fresh DB query, not
  // this invocation's own in-memory tally — an absolute snapshot of what's
  // really embedded/still-failing right now, correct regardless of how many
  // invocations it took (a doc that failed earlier and succeeded on retry
  // must not double-count; a doc that keeps failing must show up as failed
  // even if a different invocation was the one that last attempted it).
  const finalDb = new Database(copyDbPath, { readonly: true });
  const totalInScope = countInScopeDocs(finalDb);
  const stillRemaining = selectBackfillTargets(finalDb);
  finalDb.close();

  const report = buildBackfillReport({
    notesEmbedded: totalInScope - stillRemaining.length,
    failedDocIds: stillRemaining,
    wallClockMs: progress.wallClockMsAccumulated,
    tokenCostEstimate: progress.tokenCostEstimateAccumulated,
    dbSizeBeforeBytes: progress.dbSizeBeforeBytes,
    dbSizeAfterBytes,
  });

  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(REPO_ROOT, 'eval', 'results', `${date}-arm-b-backfill.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote eval/results/${date}-arm-b-backfill.json`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.endsWith('backfill-arm-b.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/config/loader.js';
import { buildVariants } from './variants.js';
import { toRunHits } from './normalize.js';
import { measurePayload } from '../score/tokens.js';
import type { RunResult, HarnessRun, Variant } from './types.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function snapshot(dbPath: string): { docCount: number; newestIndexedAt: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) c, MAX(indexed_at) m FROM fts_meta').get() as { c: number; m: string };
    return { docCount: row.c, newestIndexedAt: row.m ?? '' };
  } finally { db.close(); }
}

/** Core loop: run every non-stub item through every variant (warm-median latency
 * over 3 calls), capturing normalized hits + token/char cost. Read-only: throws
 * if the index changed between start and end. */
export async function executeRun(
  items: { id: string; query: string }[],
  variants: Variant[],
  dbPath: string,
): Promise<RunResult[]> {
  const before = snapshot(dbPath);
  const results: RunResult[] = [];
  for (const variant of variants) {
    const store = variant.openStore();
    try {
      for (const item of items) {
        if (item.query.startsWith('<ABSENT-STUB')) continue;
        const lat: number[] = [];
        try {
          let res!: Awaited<ReturnType<typeof store.search>>;
          for (let i = 0; i < 3; i++) {
            const t = performance.now();
            res = await store.search(item.query, { topK: variant.topK });
            lat.push(performance.now() - t);
          }
          const returned = toRunHits(res, variant.topK);
          const { chars, tokensEst } = measurePayload(returned);
          results.push({
            itemId: item.id, variant: variant.name, query: item.query, returned,
            searchMode: res.searchMode, degradationNote: res.degradationNote,
            latencyMs: median(lat), responseChars: chars, responseTokensEst: tokensEst,
          });
        } catch (err) {
          results.push({
            itemId: item.id, variant: variant.name, query: item.query, returned: [],
            searchMode: 'keyword-only', latencyMs: 0, responseChars: 0, responseTokensEst: 0,
            error: (err as Error).message,
          });
        }
      }
    } finally { store.close(); }
  }
  const after = snapshot(dbPath);
  if (after.docCount !== before.docCount || after.newestIndexedAt !== before.newestIndexedAt) {
    throw new Error(`Index changed during run (read-only violated): before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  return results;
}

export async function runHarness(): Promise<HarnessRun> {
  const config = await loadConfig(REPO_ROOT);
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const items = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8')) as { id: string; query: string }[];
  const variants = buildVariants(config, REPO_ROOT);
  const results = await executeRun(items, variants, dbPath);
  const run: HarnessRun = {
    generatedAt: new Date().toISOString(),
    dbSnapshot: snapshot(dbPath),
    variants: variants.map((v) => v.name),
    k: variants[0]?.topK ?? 10,
    itemCount: items.length,
    results,
  };
  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(outDir, `${date}-runs.json`), JSON.stringify(run, null, 2));
  return run;
}

// CLI entry (tsx): run when invoked directly, not when imported by tests.
if (process.argv[1]?.endsWith('run-harness.ts')) {
  runHarness()
    .then((r) => console.log(`Ran ${r.results.length} (item×variant) results across [${r.variants.join(', ')}]; wrote eval/results/${r.generatedAt.slice(0, 10)}-runs.json`))
    .catch((e) => { console.error(e); process.exit(1); });
}

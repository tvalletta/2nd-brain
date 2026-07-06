import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { executeRun } from '../../eval/run/run-harness.js';
import type { Variant } from '../../eval/run/types.js';

describe('executeRun', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-run-'));
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana\n---\nyellow banana harness');
    // seed the index once
    const seed = openVariantStore(config, join(dir, 'idx.sqlite'), {});
    try { await seed.syncFTS(['wiki']); } finally { seed.close(); }
    (globalThis as any).__cfg = config;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('runs each item x variant, captures hits/latency/tokens, and guards read-only', async () => {
    const config = (globalThis as any).__cfg;
    const dbPath = join(dir, 'idx.sqlite');
    const variants: Variant[] = [
      { name: 'grep-first', keywordOnly: true, topK: 5,
        openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' } },
    ];
    const items = [{ id: 'x-001', query: 'banana' }, { id: 'x-002', query: '<ABSENT-STUB skip me>' }];
    const { results, before, after } = await executeRun(items, variants, dbPath);

    expect(results).toHaveLength(1); // absent-stub skipped
    const r = results[0];
    expect(r.itemId).toBe('x-001');
    expect(r.variant).toBe('grep-first');
    expect(r.searchMode).toBe('keyword-only');
    expect(r.returned.map((h) => h.path)).toContain('wiki/banana.md');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.responseChars).toBeGreaterThan(0);
    expect(r.responseTokensEst).toBe(Math.ceil(r.responseChars / 4));
    // Nothing mutated the index during this run, so before/after should agree.
    expect(after).toEqual(before);
  });

  it('detects an index mutation mid-run without throwing, and surfaces it in before/after', async () => {
    const config = (globalThis as any).__cfg;
    const dbPath = join(dir, 'idx.sqlite');
    const realStore = openVariantStore(config, dbPath, { keywordOnly: true });
    const origSearch = realStore.search.bind(realStore);
    let mutated = false;
    realStore.search = (async (query: string, options?: unknown) => {
      if (!mutated) {
        mutated = true;
        // Simulate a background job (intel tick / enrichment) mutating the
        // index mid-run, via a separate connection to the same db file.
        const side = new Database(dbPath);
        try {
          const row = side.prepare('SELECT doc_id FROM fts_meta LIMIT 1').get() as { doc_id: string } | undefined;
          if (row) {
            side.prepare('UPDATE fts_meta SET indexed_at = ? WHERE doc_id = ?')
              .run(new Date(Date.now() + 60_000).toISOString(), row.doc_id);
          }
        } finally { side.close(); }
      }
      return origSearch(query, options as never);
    }) as typeof realStore.search;

    const variants: Variant[] = [
      { name: 'grep-first', keywordOnly: true, topK: 5,
        openStore: () => realStore,
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' } },
    ];
    const items = [{ id: 'x-001', query: 'banana' }];

    const outcome = await executeRun(items, variants, dbPath);

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].error).toBeUndefined();
    expect(outcome.after).not.toEqual(outcome.before);
    expect(outcome.after.newestIndexedAt).not.toBe(outcome.before.newestIndexedAt);
  });
});

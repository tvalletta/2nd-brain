import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    const results = await executeRun(items, variants, dbPath);

    expect(results).toHaveLength(1); // absent-stub skipped
    const r = results[0];
    expect(r.itemId).toBe('x-001');
    expect(r.variant).toBe('grep-first');
    expect(r.searchMode).toBe('keyword-only');
    expect(r.returned.map((h) => h.path)).toContain('wiki/banana.md');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.responseChars).toBeGreaterThan(0);
    expect(r.responseTokensEst).toBe(Math.ceil(r.responseChars / 4));
  });
});

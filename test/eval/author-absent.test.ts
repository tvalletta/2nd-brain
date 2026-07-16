import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { isConfirmedAbsent } from '../../eval/dataset/author-absent.js';
import type { Variant } from '../../eval/run/types.js';
import type { HybridStore } from '../../src/search/hybrid-store.js';

describe('isConfirmedAbsent', () => {
  let dir: string;
  let dbPath: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-absent-'));
    dbPath = join(dir, 'idx.sqlite');
    config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana Notes\n---\nyellow banana harness fruit tropical');
    const seed = openVariantStore(config, dbPath, {});
    try {
      await seed.syncFTS(['wiki']);
    } finally {
      seed.close();
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeGrepFirstVariant(): Variant {
    return {
      name: 'grep-first',
      keywordOnly: true,
      topK: 1,
      openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
      profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' },
    };
  }

  it('returns false when a real match exists', async () => {
    const absent = await isConfirmedAbsent(makeGrepFirstVariant(), 'banana tropical');
    expect(absent).toBe(false);
  });

  it('returns true when no meaningful match exists', async () => {
    const absent = await isConfirmedAbsent(makeGrepFirstVariant(), 'zzznonexistentqqqxyzzy');
    expect(absent).toBe(true);
  });
});

/** Build a Variant whose store always returns exactly one hit with the given
 * `final` score, regardless of query — for testing the threshold-gating logic
 * in isolation from real FTS/embedding behavior. */
function fakeVariantWithScore(score: number): Variant {
  const fakeStore: Pick<HybridStore, 'search' | 'close'> = {
    search: async () => ({
      hits: [
        {
          docId: 'fake-doc',
          chunkIndex: 0,
          text: 'fake',
          metadata: {},
          updated_at: new Date().toISOString(),
          scores: { rrf: 0, recency: 0, final: score },
          excerpt: 'fake',
        },
      ],
      searchMode: 'keyword-only',
    }),
    close: () => {},
  };
  return {
    name: 'grep-first',
    keywordOnly: true,
    topK: 1,
    openStore: () => fakeStore as HybridStore,
    profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' },
  };
}

describe('isConfirmedAbsent (grep-first-only gating)', () => {
  it('confirms absent when grep-first alone scores below the threshold', async () => {
    const grepFirst = fakeVariantWithScore(0.0);
    const result = await isConfirmedAbsent(grepFirst, 'some query', 0.02);
    expect(result).toBe(true);
  });

  it('does not confirm absent when grep-first scores at or above the threshold', async () => {
    const grepFirst = fakeVariantWithScore(0.05);
    const result = await isConfirmedAbsent(grepFirst, 'some query', 0.02);
    expect(result).toBe(false);
  });

  it('no longer requires other variants to agree — only takes one Variant, not an array', async () => {
    // Type-level check: this must compile with a single Variant argument,
    // not an array — if the old array signature is still in place this
    // test file won't typecheck. (No runtime assertion needed beyond the
    // two above; this comment documents the intent for a human reader.)
    expect(true).toBe(true);
  });
});

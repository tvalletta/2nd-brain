import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { isConfirmedAbsent } from '../../eval/dataset/author-absent.js';
import type { Variant } from '../../eval/run/types.js';

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

  function makeVariants(): Variant[] {
    return [
      {
        name: 'grep-first',
        keywordOnly: true,
        topK: 1,
        openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' },
      },
    ];
  }

  it('returns false when a real match exists', async () => {
    const absent = await isConfirmedAbsent(makeVariants(), 'banana tropical');
    expect(absent).toBe(false);
  });

  it('returns true when no meaningful match exists', async () => {
    const absent = await isConfirmedAbsent(makeVariants(), 'zzznonexistentqqqxyzzy');
    expect(absent).toBe(true);
  });
});

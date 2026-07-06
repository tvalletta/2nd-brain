import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';

describe('openVariantStore', () => {
  let dir: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-openstore-'));
    // deterministic provider = no Ollama; always "hybrid" when not keywordOnly
    config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana\n---\nyellow banana harness fruit');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('keyword-only variant returns keyword-only search mode', async () => {
    const store = openVariantStore(config, join(dir, 'idx.sqlite'), { keywordOnly: true });
    try {
      await store.syncFTS(['wiki']); // seed the FTS index for the test only
      const res = await store.search('banana', { topK: 5 });
      expect(res.searchMode).toBe('keyword-only');
      expect(res.hits.map((h) => h.docId)).toContain('wiki/banana.md');
    } finally { store.close(); }
  });

  it('hybrid variant (deterministic provider) reports hybrid mode', async () => {
    const store = openVariantStore(config, join(dir, 'idx2.sqlite'), {});
    try {
      await store.syncFTS(['wiki']);
      const res = await store.search('banana', { topK: 5 });
      expect(res.searchMode).toBe('hybrid');
    } finally { store.close(); }
  });
});

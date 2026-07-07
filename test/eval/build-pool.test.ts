import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { buildPoolForItem } from '../../eval/pool/build-pool.js';
import type { Variant } from '../../eval/run/types.js';

describe('buildPoolForItem', () => {
  let dir: string;
  let dbPath: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-pool-'));
    dbPath = join(dir, 'idx.sqlite');
    config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana Notes\n---\nyellow banana harness fruit');
    await writeFile(join(dir, 'wiki', 'apple.md'), '---\ntitle: Apple Notes\n---\ncrunchy apple orchard');
    await writeFile(
      join(dir, 'wiki', 'mango.md'),
      '---\ntitle: Mango Notes\n---\nmango session log CONFLUENCE_PERSONAL_TOKEN="fake1234567890abcdefFAKE" leaked by accident',
    );
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
        topK: 5,
        openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' },
      },
      {
        name: 'as-deployed',
        keywordOnly: false,
        topK: 5,
        openStore: () => openVariantStore(config, dbPath, {}),
        profile: { runtimeDeps: ['ollama'], storageGbBeyondFts: 1, maintenanceJobs: ['embedding-index'], silentDegradationModes: [], codeSurface: 'high' },
      },
    ];
  }

  it('dedupes by doc_id, tags every contributing source, and looks up titles', async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const pool = await buildPoolForItem(
        { id: 'x-001', query: 'banana' },
        makeVariants(),
        db,
        [{ query: 'banana', ts: '2026-01-01T00:00:00Z', opened: ['wiki/apple.md'] }],
      );
      expect(pool.item_id).toBe('x-001');

      const banana = pool.candidates.find((c) => c.doc_id === 'wiki/banana.md');
      expect(banana).toBeDefined();
      expect(banana!.title).toBe('Banana Notes');
      expect(banana!.sources).toContain('grep-first');
      expect(banana!.sources).toContain('as-deployed');
      expect(banana!.sources).toContain('keyword-sweep');

      const apple = pool.candidates.find((c) => c.doc_id === 'wiki/apple.md');
      expect(apple).toBeDefined();
      expect(apple!.sources).toContain('behavioral');
    } finally {
      db.close();
    }
  });

  it('falls back to doc_id as title when a note is missing from the FTS index', async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const pool = await buildPoolForItem(
        { id: 'x-002', query: 'banana' },
        makeVariants(),
        db,
        [{ query: 'banana', ts: '2026-01-01T00:00:00Z', opened: ['wiki/missing-note.md'] }],
      );
      const missing = pool.candidates.find((c) => c.doc_id === 'wiki/missing-note.md');
      expect(missing).toBeDefined();
      expect(missing!.title).toBe('wiki/missing-note.md');
    } finally {
      db.close();
    }
  });

  it('redacts secret-looking material from excerpts before they land in the pool', async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const pool = await buildPoolForItem(
        { id: 'x-003', query: 'mango' },
        makeVariants(),
        db,
        [],
      );
      const mango = pool.candidates.find((c) => c.doc_id === 'wiki/mango.md');
      expect(mango).toBeDefined();
      expect(mango!.excerpt).not.toContain('fake1234567890abcdefFAKE');
      expect(mango!.excerpt).toContain('CONFLUENCE_PERSONAL_TOKEN=[REDACTED]');
    } finally {
      db.close();
    }
  });
});

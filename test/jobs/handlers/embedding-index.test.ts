import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { embeddingIndexHandler } from '../../../src/jobs/handlers/embedding-index.js';
import {
  openEmbeddingStore,
  createDeterministicProvider,
} from '../../../src/embeddings/index.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';

function makeJob(targetPath?: string): Job {
  return {
    id: 't',
    type: 'embedding-index',
    status: 'running',
    priority: 45,
    payload: {},
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
    targetPath,
  };
}

describe('embedding-index handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-emb-h-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (i) =>
        ({
          ...i,
          id: 'q',
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: 0,
          priority: i.priority ?? 50,
          payload: i.payload ?? {},
          trigger: i.trigger ?? 'cascade',
        }) as Job,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llm: {} as any,
      config,
    };
  }

  it('indexes a single note and makes it retrievable', async () => {
    const note = `---
id: c1
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---

FSRS spaced repetition stability algorithm. The retrievability decays exponentially over time.`;
    await vault.create('wiki/concepts/fsrs.md', note);

    await embeddingIndexHandler.execute(makeJob('wiki/concepts/fsrs.md'), ctx());

    const store = openEmbeddingStore({
      dbPath: join(dir, '.karpathy/state/embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    try {
      expect(store.count()).toBeGreaterThan(0);
      const hits = await store.search('FSRS algorithm');
      expect(hits[0].doc_id).toBe('wiki/concepts/fsrs.md');
      expect(hits[0].metadata.type).toBe('concept');
    } finally {
      store.close();
    }
  });

  it('replaces stale chunks when re-indexing the same note', async () => {
    await vault.create(
      'wiki/concepts/fsrs.md',
      `---
id: c2
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---

original content paragraph one.

original paragraph two.`,
    );
    await embeddingIndexHandler.execute(makeJob('wiki/concepts/fsrs.md'), ctx());

    // Rewrite with fewer paragraphs.
    await vault.write(
      'wiki/concepts/fsrs.md',
      `---
id: c2
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-02T00:00:00Z
---

revised content only.`,
    );
    await embeddingIndexHandler.execute(makeJob('wiki/concepts/fsrs.md'), ctx());

    const store = openEmbeddingStore({
      dbPath: join(dir, '.karpathy/state/embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    try {
      const rows = store.getByDoc('wiki/concepts/fsrs.md');
      expect(rows).toHaveLength(1);
      expect(rows[0].text).toContain('revised');
    } finally {
      store.close();
    }
  });

  it('indexes a folder when no targetPath is given', async () => {
    await vault.create(
      'wiki/concepts/a.md',
      `---
id: a
type: concept
title: A
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
content alpha for indexing test.`,
    );
    await vault.create(
      'wiki/concepts/b.md',
      `---
id: b
type: concept
title: B
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
content beta for indexing test.`,
    );

    const job = makeJob();
    job.payload = { folder: 'wiki/concepts' };
    await embeddingIndexHandler.execute(job, ctx());

    const store = openEmbeddingStore({
      dbPath: join(dir, '.karpathy/state/embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    try {
      expect(store.count()).toBe(2);
    } finally {
      store.close();
    }
  });

  it('chunks using the configured embeddings.maxChunkChars instead of a hardcoded cap (Fix K)', async () => {
    // One long unbroken paragraph (no blank lines) so chunkText's hardSplit
    // path is exercised. maxChunkChars (1500) is deliberately kept ABOVE the
    // handler's fixed targetChars (1200, unchanged) — same relative
    // ordering as production defaults (2048 > 1200) — since chunkText's
    // buffering re-joins hard-split pieces up to targetChars first; a
    // maxChars below targetChars is not a configuration this handler uses.
    const longParagraph = 'word '.repeat(800).trim(); // ~4000 chars, no paragraph breaks
    const note = `---
id: long
type: concept
title: Long
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---

${longParagraph}`;
    await vault.create('wiki/concepts/long.md', note);

    const customConfig = KarpathyConfigSchema.parse({
      vaultPath: dir,
      embeddings: { maxChunkChars: 1500 },
    });
    const customCtx: JobContext = {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (i) =>
        ({
          ...i,
          id: 'q',
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: 0,
          priority: i.priority ?? 50,
          payload: i.payload ?? {},
          trigger: i.trigger ?? 'cascade',
        }) as Job,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llm: {} as any,
      config: customConfig,
    };

    await embeddingIndexHandler.execute(makeJob('wiki/concepts/long.md'), customCtx);

    const store = openEmbeddingStore({
      dbPath: join(dir, '.karpathy/state/embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    try {
      const rows = store.getByDoc('wiki/concepts/long.md');
      expect(rows.length).toBeGreaterThan(1); // the ~4000-char paragraph must have been split
      expect(rows.every((r) => r.text.length <= 1500)).toBe(true);
    } finally {
      store.close();
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { syncFtsIndexHandler } from '../../../src/jobs/handlers/sync-fts-index.js';
import { openFTSIndex } from '../../../src/search/fts-index.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';

function makeJob(payload: Record<string, unknown> = {}): Job {
  return {
    id: 't',
    type: 'sync-fts-index',
    status: 'running',
    priority: 100,
    payload,
    trigger: 'timer',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('sync-fts-index handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-sync-fts-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeCtx(): JobContext {
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

  function readIndexedDocs(): string[] {
    const db = new Database(join(dir, '.karpathy/state/embeddings.sqlite'), { readonly: true });
    try {
      const rows = db.prepare('SELECT doc_id FROM fts_meta').all() as Array<{ doc_id: string }>;
      return rows.map((r) => r.doc_id);
    } finally {
      db.close();
    }
  }

  it('full sync indexes every markdown file in the configured folders', async () => {
    await vault.create(
      'wiki/concepts/fsrs.md',
      '---\ntitle: FSRS\n---\nspaced repetition algorithm content',
    );
    await vault.create(
      'wiki/projects/karpathy.md',
      '---\ntitle: Karpathy\n---\nproject hub content',
    );
    await syncFtsIndexHandler.execute(makeJob(), makeCtx());

    const indexed = readIndexedDocs();
    expect(indexed).toContain('wiki/concepts/fsrs.md');
    expect(indexed).toContain('wiki/projects/karpathy.md');
  });

  it('detects modified files via mtime on subsequent syncs', async () => {
    await vault.create(
      'wiki/concepts/a.md',
      '---\ntitle: A\n---\nfirst version content text',
    );
    await syncFtsIndexHandler.execute(makeJob(), makeCtx());

    // Modify content + bump mtime forward.
    await vault.write(
      'wiki/concepts/a.md',
      '---\ntitle: A\n---\nsecond version content text',
    );
    const future = new Date(Date.now() + 5000);
    await utimes(join(dir, 'wiki/concepts/a.md'), future, future);

    await syncFtsIndexHandler.execute(makeJob(), makeCtx());

    // Confirm the new text is searchable via the FTS index.
    const db = new Database(join(dir, '.karpathy/state/embeddings.sqlite'));
    db.pragma('journal_mode = WAL');
    const fts = openFTSIndex(db, { vaultRoot: dir });
    try {
      const hits = fts.query('"second"', 5);
      expect(hits.map((h) => h.docId)).toContain('wiki/concepts/a.md');
      expect(fts.query('"first"', 5).map((h) => h.docId)).not.toContain('wiki/concepts/a.md');
    } finally {
      db.close();
    }
  });

  it('removes deleted files on sync', async () => {
    await vault.create('wiki/x.md', '---\ntitle: X\n---\nx content');
    await syncFtsIndexHandler.execute(makeJob(), makeCtx());
    expect(readIndexedDocs()).toContain('wiki/x.md');

    await vault.delete('wiki/x.md');
    await syncFtsIndexHandler.execute(makeJob(), makeCtx());
    expect(readIndexedDocs()).not.toContain('wiki/x.md');
  });

  it('single-file mode upserts only the named file', async () => {
    await vault.create('wiki/single.md', '---\ntitle: Single\n---\nsingle file content');
    await syncFtsIndexHandler.execute(makeJob({ file: 'wiki/single.md' }), makeCtx());
    expect(readIndexedDocs()).toContain('wiki/single.md');
  });

  it('single-file delete payload removes the named file', async () => {
    await vault.create('wiki/temp.md', '---\ntitle: Temp\n---\ntemp content');
    await syncFtsIndexHandler.execute(makeJob(), makeCtx());
    expect(readIndexedDocs()).toContain('wiki/temp.md');

    await syncFtsIndexHandler.execute(makeJob({ deletedFile: 'wiki/temp.md' }), makeCtx());
    expect(readIndexedDocs()).not.toContain('wiki/temp.md');
  });
});

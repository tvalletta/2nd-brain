import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobQueue } from '../../src/jobs/queue.js';
import { enqueueAndPersist } from '../../src/mcp/context.js';

// Fix J: `ctx.enqueueJob()` (src/mcp/context.ts) previously called
// `queue.enqueue()` without a following `queue.flush()`, so a job was only
// ever mutated into in-memory state and never reached job-queue.json —
// watcher-triggered `sync-fts-index` jobs were silently dropped the moment
// the MCP server process exited. `enqueueAndPersist` is the extracted fix,
// exercised directly here (real `createJobQueue`, real disk I/O) without
// needing to boot a full `MCPContext`, which requires a real global config.
describe('enqueueAndPersist (Fix J)', () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-context-'));
    queuePath = join(tempDir, 'job-queue.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists an enqueued job to job-queue.json', async () => {
    const queue = createJobQueue(queuePath);

    await enqueueAndPersist(queue, {
      type: 'sync-fts-index',
      payload: { file: 'wiki/concepts/glossary.md' },
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:wiki/concepts/glossary.md',
    });

    const raw = await readFile(queuePath, 'utf-8');
    const jobs = JSON.parse(raw) as Array<{ type: string; dedupeKey?: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('sync-fts-index');
    expect(jobs[0].dedupeKey).toBe('sync-fts-index:wiki/concepts/glossary.md');
  });

  it('does not double-enqueue a pending job with the same dedupeKey across calls that reload the file', async () => {
    const first = createJobQueue(queuePath);
    await enqueueAndPersist(first, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:dupe.md',
    });

    // A fresh JobQueue instance backed by the same file, mirroring a second
    // watcher callback (or a second MCP server process) enqueuing against
    // the same on-disk queue.
    const second = createJobQueue(queuePath);
    await enqueueAndPersist(second, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:dupe.md',
    });

    const raw = await readFile(queuePath, 'utf-8');
    const jobs = JSON.parse(raw) as Array<{ dedupeKey?: string }>;
    expect(jobs).toHaveLength(1);
  });

  it('persists multiple distinct jobs across separate enqueueAndPersist calls', async () => {
    const queue = createJobQueue(queuePath);
    await enqueueAndPersist(queue, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:a.md',
    });
    await enqueueAndPersist(queue, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:b.md',
    });

    const raw = await readFile(queuePath, 'utf-8');
    const jobs = JSON.parse(raw) as Array<{ dedupeKey?: string }>;
    expect(jobs).toHaveLength(2);
  });
});

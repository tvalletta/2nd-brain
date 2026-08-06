import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobQueue, type JobQueue } from '../../src/jobs/queue.js';
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

// Whole-branch review finding: in the shared MCP daemon, every session and
// the watcher share ONE `MCPContext` and thus ONE `JobQueue` instance.
// `enqueueAndPersist`'s unlocked `load()` -> `enqueue()` -> `flush()` can
// interleave across concurrent callers against that single instance: one
// caller's `load()` replaces the shared in-memory `jobs` array, silently
// discarding another caller's not-yet-flushed `enqueue()`. This suite proves
// the race (pre-fix) and that a per-queue-instance mutex closes it (post-fix)
// without breaking the chain when one call rejects.
describe('enqueueAndPersist concurrency (per-queue-instance serialization)', () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-context-concurrency-'));
    queuePath = join(tempDir, 'job-queue.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists all N jobs from N concurrent calls against one queue instance', async () => {
    const queue = createJobQueue(queuePath);
    const N = 20;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        enqueueAndPersist(queue, {
          type: 'sync-fts-index',
          trigger: 'file-watcher',
          priority: 100,
          dedupeKey: `sync-fts-index:concurrent-${i}.md`,
        }),
      ),
    );

    // Re-load from disk with a *fresh* queue instance so the assertion is
    // against what actually persisted, not the shared in-memory `jobs` array.
    const reloaded = createJobQueue(queuePath);
    await reloaded.load();
    const jobs = await reloaded.list();
    const dedupeKeys = new Set(jobs.map((j) => j.dedupeKey));

    expect(jobs).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(dedupeKeys.has(`sync-fts-index:concurrent-${i}.md`)).toBe(true);
    }
  });

  it('keeps the chain alive across a rejecting call: later queued calls still persist, and the rejecting call itself rejects', async () => {
    const realQueue = createJobQueue(queuePath);
    const flakyQueue: JobQueue = {
      ...realQueue,
      async enqueue(input) {
        if (input.dedupeKey === 'sync-fts-index:boom.md') {
          throw new Error('boom');
        }
        return realQueue.enqueue(input);
      },
    };

    // Fired without awaiting in between so all three are in flight together,
    // mirroring concurrent watcher/session callers against one instance.
    const before = enqueueAndPersist(flakyQueue, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:before.md',
    });
    const boom = enqueueAndPersist(flakyQueue, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:boom.md',
    });
    const after = enqueueAndPersist(flakyQueue, {
      type: 'sync-fts-index',
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: 'sync-fts-index:after.md',
    });

    await expect(boom).rejects.toThrow('boom');
    await expect(before).resolves.toBeUndefined();
    await expect(after).resolves.toBeUndefined();

    const raw = await readFile(queuePath, 'utf-8');
    const jobs = JSON.parse(raw) as Array<{ dedupeKey?: string }>;
    const dedupeKeys = jobs.map((j) => j.dedupeKey);

    expect(dedupeKeys).toContain('sync-fts-index:before.md');
    expect(dedupeKeys).toContain('sync-fts-index:after.md');
    expect(dedupeKeys).not.toContain('sync-fts-index:boom.md');
  });
});

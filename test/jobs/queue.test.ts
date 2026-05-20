import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobQueue } from '../../src/jobs/queue.js';

describe('JobQueue', () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-queue-'));
    queuePath = join(tempDir, 'queue.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('enqueues and dequeues a job', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index', priority: 10 });
    expect(job.id).toBeTruthy();
    expect(job.status).toBe('pending');

    const dequeued = await queue.dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(job.id);
    expect(dequeued!.status).toBe('running');
  });

  it('returns null when queue is empty', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.dequeue();
    expect(job).toBeNull();
  });

  it('deduplicates jobs with same dedupeKey', async () => {
    const queue = createJobQueue(queuePath);
    const job1 = await queue.enqueue({ type: 'update-backlinks', dedupeKey: 'bl:test' });
    const job2 = await queue.enqueue({ type: 'update-backlinks', dedupeKey: 'bl:test' });
    expect(job1.id).toBe(job2.id); // Same job returned
    expect(queue.size()).toBe(1);
  });

  it('does not deduplicate different dedupeKeys', async () => {
    const queue = createJobQueue(queuePath);
    await queue.enqueue({ type: 'update-backlinks', dedupeKey: 'bl:a' });
    await queue.enqueue({ type: 'update-backlinks', dedupeKey: 'bl:b' });
    expect(queue.size()).toBe(2);
  });

  it('respects priority ordering', async () => {
    const queue = createJobQueue(queuePath);
    await queue.enqueue({ type: 'detect-contradictions', priority: 80 });
    await queue.enqueue({ type: 'update-backlinks', priority: 10 });
    await queue.enqueue({ type: 'summarize-source', priority: 50 });

    const first = await queue.dequeue();
    expect(first!.type).toBe('update-backlinks');
    const second = await queue.dequeue();
    expect(second!.type).toBe('summarize-source');
    const third = await queue.dequeue();
    expect(third!.type).toBe('detect-contradictions');
  });

  it('respects debounce window', async () => {
    const queue = createJobQueue(queuePath);
    await queue.enqueue({ type: 'update-backlinks', debounceMs: 60000 });

    const job = await queue.dequeue();
    expect(job).toBeNull(); // Not ready yet
  });

  it('completes a job', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });
    await queue.dequeue();
    await queue.complete(job.id);

    const listed = await queue.list({ status: 'completed' });
    expect(listed).toHaveLength(1);
    expect(listed[0].completedAt).toBeTruthy();
  });

  it('retries a failed job up to maxRetries', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index', maxRetries: 2 });

    // First attempt
    await queue.dequeue();
    await queue.fail(job.id, 'error 1');
    const afterFail1 = await queue.list({ status: 'pending' });
    expect(afterFail1).toHaveLength(1);

    // Second attempt
    await queue.dequeue();
    await queue.fail(job.id, 'error 2');
    const afterFail2 = await queue.list({ status: 'pending' });
    expect(afterFail2).toHaveLength(1);

    // Third attempt — exceeds maxRetries
    await queue.dequeue();
    await queue.fail(job.id, 'error 3');
    const afterFail3 = await queue.list({ status: 'failed' });
    expect(afterFail3).toHaveLength(1);
  });

  it('persists and loads from disk', async () => {
    const queue1 = createJobQueue(queuePath);
    await queue1.enqueue({ type: 'rebuild-index', priority: 10 });
    await queue1.enqueue({ type: 'update-backlinks', priority: 20 });
    await queue1.flush();

    const queue2 = createJobQueue(queuePath);
    await queue2.load();
    expect(queue2.size()).toBe(2);
  });
});

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

describe('JobQueue — transient retry lane', () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-queue-'));
    queuePath = join(tempDir, 'queue.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('never marks a transiently-failing job as failed, and leaves retryCount untouched', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index', maxRetries: 3 });

    for (let i = 0; i < 10; i++) {
      await queue.fail(job.id, 'simulated outage', { transient: true });
    }

    const [stored] = await queue.list();
    expect(stored.status).toBe('pending');
    expect(stored.retryCount).toBe(0);
    expect(stored.transientRetryCount).toBe(10);
    expect(stored.transientSince).toBeTruthy();
  });

  it('caps backoff at backoffCeilingMs', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });

    for (let i = 0; i < 20; i++) {
      await queue.fail(job.id, 'simulated outage', { transient: true, backoffCeilingMs: 5000 });
    }

    const [stored] = await queue.list();
    // 20 doublings would be enormous uncapped; confirm it's pinned at the 5s ceiling (+ up to 25% jitter).
    const delay = stored.retryAfter! - Date.now();
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThanOrEqual(5000 * 1.25 + 50);
  });

  it('keeps the existing bounded path unchanged for non-transient failures', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index', maxRetries: 2 });

    await queue.fail(job.id, 'bad request');
    await queue.fail(job.id, 'bad request');
    await queue.fail(job.id, 'bad request');

    const [stored] = await queue.list();
    expect(stored.status).toBe('failed');
    expect(stored.transientRetryCount).toBe(0);
  });

  it('markAlerted stamps transientAlertSentAt', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });
    expect(job.transientAlertSentAt).toBeUndefined();

    await queue.markAlerted(job.id);

    const [stored] = await queue.list();
    expect(stored.transientAlertSentAt).toBeTruthy();
  });

  it('Fix F: caps transient retries at maxTransientRetries, then marks the job terminally failed', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });

    for (let i = 0; i < 3; i++) {
      await queue.fail(job!.id, 'simulated outage', { transient: true, maxTransientRetries: 3 });
    }
    const afterThree = await queue.list();
    expect(afterThree[0].status).toBe('pending'); // at the cap, not yet exceeding it
    expect(afterThree[0].transientRetryCount).toBe(3);

    await queue.fail(job!.id, 'simulated outage', { transient: true, maxTransientRetries: 3 });
    const afterFour = await queue.list();
    expect(afterFour[0].status).toBe('failed'); // exceeded the cap — no longer retried forever
    expect(afterFour[0].transientRetryCount).toBe(4);
    expect(afterFour[0].completedAt).toBeTruthy();
  });

  it('Fix F: defaults maxTransientRetries to 20 when the caller does not pass one', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });

    for (let i = 0; i < 20; i++) {
      await queue.fail(job!.id, 'simulated outage', { transient: true });
    }
    expect((await queue.list())[0].status).toBe('pending');

    await queue.fail(job!.id, 'simulated outage', { transient: true });
    expect((await queue.list())[0].status).toBe('failed');
  });
});

describe('JobQueue — active job cap (Fix H)', () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-queue-'));
    queuePath = join(tempDir, 'queue.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('refuses to enqueue once the active (pending+running) count reaches maxActiveJobs', async () => {
    const queue = createJobQueue(queuePath, { maxActiveJobs: 2 });
    const job1 = await queue.enqueue({ type: 'rebuild-index' });
    const job2 = await queue.enqueue({ type: 'update-backlinks' });
    expect(job1).not.toBeNull();
    expect(job2).not.toBeNull();

    const job3 = await queue.enqueue({ type: 'lint-wiki' });
    expect(job3).toBeNull();
    expect(queue.size()).toBe(2);
  });

  it('still allows dedup lookups to return the existing job even at capacity', async () => {
    const queue = createJobQueue(queuePath, { maxActiveJobs: 1 });
    const job1 = await queue.enqueue({ type: 'rebuild-index', dedupeKey: 'idx:full' });
    expect(job1).not.toBeNull();

    // Same dedupeKey — must return the existing job, not be refused by the cap.
    const job2 = await queue.enqueue({ type: 'rebuild-index', dedupeKey: 'idx:full' });
    expect(job2).not.toBeNull();
    expect(job2!.id).toBe(job1!.id);
    expect(queue.size()).toBe(1);
  });

  it('defaults maxActiveJobs to 1000 when not provided', async () => {
    const queue = createJobQueue(queuePath);
    for (let i = 0; i < 5; i++) {
      const job = await queue.enqueue({ type: 'rebuild-index', dedupeKey: `job-${i}` });
      expect(job).not.toBeNull();
    }
    expect(queue.size()).toBe(5);
  });
});

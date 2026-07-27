import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobQueue } from '../../src/jobs/queue.js';
import { createFileLock } from '../../src/jobs/lock.js';
import { createJobRunner } from '../../src/jobs/runner.js';
import { createNoopClient } from '../../src/enrichment/llm-client.js';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { JobHandler, JobType } from '../../src/jobs/types.js';
import { TransientLLMError } from '../../src/shared/errors.js';

vi.mock('../../src/intelligence/slack-notify.js', () => ({
  sendSlackNotification: vi.fn(async () => true),
}));
import { sendSlackNotification } from '../../src/intelligence/slack-notify.js';

describe('JobRunner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-runner-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function runnerDefaults() {
    return {
      llm: createNoopClient(),
      vault: createFsAdapter(tempDir),
      config: KarpathyConfigSchema.parse({ vaultPath: tempDir, projectRoot: tempDir }),
    };
  }

  it('runs all pending jobs to completion', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const lock = createFileLock(join(tempDir, 'locks'));
    const executed: string[] = [];

    const testHandler: JobHandler = {
      async execute(job) {
        executed.push(job.type);
      },
    };

    const handlers = new Map<JobType, JobHandler>();
    handlers.set('rebuild-index', testHandler);
    handlers.set('update-backlinks', testHandler);

    await queue.enqueue({ type: 'rebuild-index', priority: 10 });
    await queue.enqueue({ type: 'update-backlinks', priority: 20 });

    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: tempDir,
      projectRoot: tempDir,
      ...runnerDefaults(),
    });

    const count = await runner.runAll();
    expect(count).toBe(2);
    expect(executed).toEqual(['rebuild-index', 'update-backlinks']);
  });

  it('retries failed jobs after backoff delay', async () => {
    vi.useFakeTimers();
    try {
      const queue = createJobQueue(join(tempDir, 'queue.json'));
      const lock = createFileLock(join(tempDir, 'locks'));
      let callCount = 0;

      const flakyHandler: JobHandler = {
        async execute() {
          callCount++;
          if (callCount === 1) throw new Error('transient failure');
        },
      };

      const handlers = new Map<JobType, JobHandler>();
      handlers.set('rebuild-index', flakyHandler);

      await queue.enqueue({ type: 'rebuild-index', maxRetries: 3 });

      const runner = createJobRunner({
        queue,
        lock,
        handlers,
        vaultPath: tempDir,
        projectRoot: tempDir,
        ...runnerDefaults(),
      });

      // First run: fails and sets backoff
      await runner.runAll();
      expect(callCount).toBe(1);

      // Advance past the backoff delay (1s for first retry)
      vi.advanceTimersByTime(2000);

      // Second run: retried job succeeds
      await runner.runAll();
      expect(callCount).toBe(2);

      const completed = await queue.list({ status: 'completed' });
      expect(completed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 0 when queue is empty', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const lock = createFileLock(join(tempDir, 'locks'));

    const runner = createJobRunner({
      queue,
      lock,
      handlers: new Map(),
      vaultPath: tempDir,
      projectRoot: tempDir,
      ...runnerDefaults(),
    });

    const count = await runner.runAll();
    expect(count).toBe(0);
  });

  it('retries a TransientLLMError job indefinitely instead of marking it failed, and sends exactly one stuck-job alert', async () => {
    vi.useFakeTimers();
    try {
      vi.clearAllMocks();
      const queue = createJobQueue(join(tempDir, 'queue.json'));
      const lock = createFileLock(join(tempDir, 'locks'));

      const outageHandler: JobHandler = {
        async execute() {
          throw new TransientLLMError('simulated outage');
        },
      };
      const handlers = new Map<JobType, JobHandler>();
      handlers.set('rebuild-index', outageHandler);

      await queue.enqueue({ type: 'rebuild-index', maxRetries: 3 }); // old bounded ceiling — must not apply here

      const config = KarpathyConfigSchema.parse({
        vaultPath: tempDir,
        projectRoot: tempDir,
        notifications: { slack: { enabled: true, webhookUrl: 'https://example.com/webhook' } },
        jobs: { transientRetry: { alertAfterMs: 0, backoffCeilingMs: 60_000 } },
      });

      const runner = createJobRunner({
        queue, lock, handlers, vaultPath: tempDir, projectRoot: tempDir,
        llm: createNoopClient(), vault: createFsAdapter(tempDir), config,
      });

      // Fail 5 times in a row — well past the job's own maxRetries: 3.
      for (let i = 0; i < 5; i++) {
        await runner.runAll();
        vi.advanceTimersByTime(120_000);
      }

      const jobs = await queue.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('pending'); // never 'failed', unlike the bounded path
      expect(jobs[0].transientRetryCount).toBe(5);
      expect(jobs[0].retryCount).toBe(0); // untouched
      expect(sendSlackNotification).toHaveBeenCalledTimes(1); // one alert, not five
    } finally {
      vi.useRealTimers();
    }
  });
});

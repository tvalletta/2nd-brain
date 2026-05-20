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
});

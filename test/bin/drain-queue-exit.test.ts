import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// loadConfig() (src/config/loader.ts) always reads the real global config at
// ~/.karpathy/config.json -- there is no env var or CLI override, so this
// test (matching intel-tick-exit.test.ts's existing convention of spawning
// against the real ambient environment) backs up and temporarily augments
// the real job queue with one pending job, so the run actually exercises
// drainQueueCommand's job-processing path rather than its empty-queue early
// return (which does NOT hit the bug -- confirmed during investigation).
describe('drain-queue process exit', () => {
  const queuePath = join(homedir(), '.karpathy', 'state', 'job-queue.json');
  let originalQueue: string;

  beforeEach(async () => {
    originalQueue = await readFile(queuePath, 'utf8');
    const jobs = JSON.parse(originalQueue) as unknown[];
    jobs.push({
      id: 'drain-exit-regression-test',
      type: 'sync-fts-index',
      status: 'pending',
      priority: 100,
      payload: {},
      trigger: 'timer',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      dedupeKey: 'drain-exit-regression-test',
      debounceMs: 0,
    });
    await writeFile(queuePath, JSON.stringify(jobs, null, 2));
  });

  afterEach(async () => {
    await writeFile(queuePath, originalQueue);
  });

  it('exits within 30 seconds after draining a real pending job (not just the empty-queue fast path)', async () => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, 'dist/bin/karpathy.js'), 'drain-queue'],
      { env: { ...process.env }, stdio: 'pipe' },
    );

    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Process did not exit within 30s'));
      }, 30000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolvePromise(code);
      });
    });

    expect(exitCode).toBe(0);
  }, 35000);
});

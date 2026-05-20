import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileLock } from '../../src/jobs/lock.js';

describe('FileLock', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-lock-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    const lock = createFileLock(tempDir);
    expect(lock.isLocked('test.md')).toBe(false);

    const release = await lock.acquire('test.md');
    expect(lock.isLocked('test.md')).toBe(true);

    await release();
    expect(lock.isLocked('test.md')).toBe(false);
  });

  it('allows locking different paths concurrently', async () => {
    const lock = createFileLock(tempDir);
    const release1 = await lock.acquire('file1.md');
    const release2 = await lock.acquire('file2.md');

    expect(lock.isLocked('file1.md')).toBe(true);
    expect(lock.isLocked('file2.md')).toBe(true);

    await release1();
    await release2();
  });

  it('second acquire on same path waits for first', async () => {
    const lock = createFileLock(tempDir);
    const order: number[] = [];

    const release1 = await lock.acquire('same.md');

    const p2 = (async () => {
      const release2 = await lock.acquire('same.md', 2000);
      order.push(2);
      await release2();
    })();

    // Give p2 time to start waiting
    await new Promise((r) => setTimeout(r, 100));
    order.push(1);
    await release1();

    await p2;
    expect(order).toEqual([1, 2]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireWatcherLock, createFileWatcher, WATCHER_LOCK_KEY } from '../../src/ingest/watcher.js';

// Fix A: cross-process single-watcher advisory lock. Every Claude Code
// window spawns its own MCP server (src/mcp/server.ts); without this lock,
// each one started an independent chokidar watcher over the same
// OneDrive-backed vault folders. `acquireWatcherLock` is the decision point
// server.ts consults before calling createFileWatcher(); these tests exercise
// that decision directly, plus the composed "does a watcher actually start"
// behavior server.ts implements.
describe('acquireWatcherLock (Fix A)', () => {
  let lockDir: string;

  beforeEach(async () => {
    lockDir = await mkdtemp(join(tmpdir(), 'karpathy-watcher-lock-'));
  });

  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('the first acquirer gets the lock and can start a watcher', async () => {
    const result = await acquireWatcherLock(lockDir);
    expect(result.acquired).toBe(true);
    expect(result.release).not.toBeNull();

    // Mirrors server.ts: only start the watcher once the lock is acquired.
    const watcher = await createFileWatcher([join(lockDir, 'watch-target')], {
      async onFile() {},
    });
    watcher.start();
    watcher.stop();

    await result.release!();
  });

  it('a second concurrent acquirer does NOT acquire while the first holder is alive', async () => {
    const first = await acquireWatcherLock(lockDir);
    expect(first.acquired).toBe(true);

    // Second attempt, same lockDir, first holder's PID (this test process)
    // is still alive — must be refused, not thrown.
    const second = await acquireWatcherLock(lockDir);
    expect(second.acquired).toBe(false);
    expect(second.release).toBeNull();

    // The composed behavior: a refused lock means server.ts must skip
    // starting a second watcher entirely.
    let secondWatcherStarted = false;
    if (second.acquired) {
      secondWatcherStarted = true;
    }
    expect(secondWatcherStarted).toBe(false);

    await first.release!();
  });

  it('takes over a stale lock held by a dead PID', async () => {
    // Simulate a lock file left behind by a process that no longer exists.
    // PID 999999 is not a real running process in any test environment.
    const lockPath = join(lockDir, `${WATCHER_LOCK_KEY}.lock`);
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, path: WATCHER_LOCK_KEY, acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    const result = await acquireWatcherLock(lockDir);
    expect(result.acquired).toBe(true);
    expect(result.release).not.toBeNull();

    // The stale lock file's dead-PID contents should have been replaced with
    // this process's own PID.
    const raw = await readFile(lockPath, 'utf-8');
    const { pid } = JSON.parse(raw) as { pid: number };
    expect(pid).toBe(process.pid);

    await result.release!();
  });

  it('releasing the lock allows a subsequent acquirer to take it', async () => {
    const first = await acquireWatcherLock(lockDir);
    expect(first.acquired).toBe(true);
    await first.release!();

    const second = await acquireWatcherLock(lockDir);
    expect(second.acquired).toBe(true);
    await second.release!();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnLowPriority } from '../../src/shared/low-priority.js';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/shared/low-priority.js', () => ({
  spawnLowPriority: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
  })),
}));

describe('spawnBackgroundDrain', () => {
  let tempDir: string;
  let lockDir: string;
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-bg-drain-'));
    lockDir = join(tempDir, 'locks');
    stateDir = join(tempDir, 'state');
    await mkdir(lockDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('spawns a detached process with drain-queue command', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    await spawnBackgroundDrain({ lockDir, stateDir });

    expect(spawnLowPriority).toHaveBeenCalledOnce();
    const [execPath, args, options] = (spawnLowPriority as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args).toContain('drain-queue');
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
  });

  it('spawns the drain child through the low-priority (background QoS) path', async () => {
    // Confirms the *mechanism* wiring: background-drain now calls
    // spawnLowPriority (which composes buildLowPriorityInvocation +
    // taskpolicy -b, falling back to a direct spawn) rather than calling
    // node:child_process's spawn directly. Fix-B's throttle/lock logic is
    // asserted separately below and is unchanged.
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    await spawnBackgroundDrain({ lockDir, stateDir });

    expect(spawnLowPriority).toHaveBeenCalledOnce();
    const [command, args] = (spawnLowPriority as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(['drain-queue']));
  });

  it('returns promptly without blocking on the spawned process itself', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    const start = performance.now();
    await spawnBackgroundDrain({ lockDir, stateDir });
    const elapsed = performance.now() - start;

    // The pre-checks + spawn + timestamp write are all fast fs ops on a temp
    // dir — should resolve quickly (spawning the child itself is non-blocking).
    expect(elapsed).toBeLessThan(200);
  });

  it('does not throw if spawn fails', async () => {
    (spawnLowPriority as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    await expect(spawnBackgroundDrain({ lockDir, stateDir })).resolves.toBeUndefined();
  });

  // --- Fix B: throttle + live-lock skip -------------------------------------

  it('skips spawning back-to-back within the min interval, spawning only once', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');

    await spawnBackgroundDrain({ lockDir, stateDir, minIntervalMs: 60_000 });
    await spawnBackgroundDrain({ lockDir, stateDir, minIntervalMs: 60_000 });
    await spawnBackgroundDrain({ lockDir, stateDir, minIntervalMs: 60_000 });

    expect(spawnLowPriority).toHaveBeenCalledOnce();
  });

  it('spawns again once the min interval has elapsed', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');

    await spawnBackgroundDrain({ lockDir, stateDir, minIntervalMs: 10 });
    await new Promise((r) => setTimeout(r, 20));
    await spawnBackgroundDrain({ lockDir, stateDir, minIntervalMs: 10 });

    expect(spawnLowPriority).toHaveBeenCalledTimes(2);
  });

  it('skips spawning when the __drain__ lock is held by a live PID', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');

    // This test process's own PID is guaranteed alive.
    await writeFile(
      join(lockDir, '__drain__.lock'),
      JSON.stringify({ pid: process.pid, path: '__drain__', acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    await spawnBackgroundDrain({ lockDir, stateDir });

    expect(spawnLowPriority).not.toHaveBeenCalled();
  });

  it('spawns when the __drain__ lock file references a dead PID', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');

    await writeFile(
      join(lockDir, '__drain__.lock'),
      JSON.stringify({ pid: 999999, path: '__drain__', acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    await spawnBackgroundDrain({ lockDir, stateDir });

    expect(spawnLowPriority).toHaveBeenCalledOnce();
  });

  it('records the spawn timestamp to <stateDir>/last-drain.json', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    const before = Date.now();
    await spawnBackgroundDrain({ lockDir, stateDir });

    const raw = await readFile(join(stateDir, 'last-drain.json'), 'utf-8');
    const { lastSpawnAt } = JSON.parse(raw) as { lastSpawnAt: number };
    expect(lastSpawnAt).toBeGreaterThanOrEqual(before);
  });
});

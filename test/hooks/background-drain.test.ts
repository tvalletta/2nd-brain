import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
  })),
}));

describe('spawnBackgroundDrain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns a detached process with drain-queue command', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    spawnBackgroundDrain();

    expect(spawn).toHaveBeenCalledOnce();
    const [execPath, args, options] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args).toContain('drain-queue');
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
  });

  it('returns immediately without blocking', async () => {
    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    const start = performance.now();
    spawnBackgroundDrain();
    const elapsed = performance.now() - start;

    // Should return in under 50ms (spawning is non-blocking)
    expect(elapsed).toBeLessThan(50);
  });

  it('does not throw if spawn fails', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const { spawnBackgroundDrain } = await import('../../src/hooks/background-drain.js');
    expect(() => spawnBackgroundDrain()).not.toThrow();
  });
});

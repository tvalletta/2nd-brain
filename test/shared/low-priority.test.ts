import { describe, it, expect, vi, beforeEach } from 'vitest';

const accessSyncMock = vi.fn();
const spawnMock = vi.fn(() => ({ pid: 4321, unref: vi.fn() }));
const setPriorityMock = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: (...args: unknown[]) => accessSyncMock(...args),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    setPriority: (...args: unknown[]) => setPriorityMock(...args),
  };
});

describe('low-priority', () => {
  beforeEach(() => {
    accessSyncMock.mockReset();
    spawnMock.mockClear();
    setPriorityMock.mockReset();
  });

  describe('taskpolicyAvailable', () => {
    it('returns true when a candidate taskpolicy path is accessible', async () => {
      accessSyncMock.mockImplementation(() => undefined);
      const { taskpolicyAvailable } = await import('../../src/shared/low-priority.js');
      expect(taskpolicyAvailable()).toBe(true);
    });

    it('returns false when no candidate path is accessible', async () => {
      accessSyncMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { taskpolicyAvailable } = await import('../../src/shared/low-priority.js');
      expect(taskpolicyAvailable()).toBe(false);
    });
  });

  describe('buildLowPriorityInvocation', () => {
    it('wraps in taskpolicy -b when available', async () => {
      const { buildLowPriorityInvocation } = await import('../../src/shared/low-priority.js');
      const inv = buildLowPriorityInvocation('node', ['x.js'], true);
      expect(inv).toEqual({ command: 'taskpolicy', args: ['-b', '--', 'node', 'x.js'] });
    });

    it('falls back to direct invocation when taskpolicy missing', async () => {
      const { buildLowPriorityInvocation } = await import('../../src/shared/low-priority.js');
      const inv = buildLowPriorityInvocation('node', ['x.js'], false);
      expect(inv).toEqual({ command: 'node', args: ['x.js'] });
    });

    it('defaults availableOverride to taskpolicyAvailable() when omitted', async () => {
      accessSyncMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { buildLowPriorityInvocation } = await import('../../src/shared/low-priority.js');
      const inv = buildLowPriorityInvocation('node', ['x.js']);
      expect(inv).toEqual({ command: 'node', args: ['x.js'] });
    });
  });

  describe('spawnLowPriority', () => {
    it('spawns via taskpolicy -b when available', async () => {
      accessSyncMock.mockImplementation(() => undefined);
      const { spawnLowPriority } = await import('../../src/shared/low-priority.js');
      spawnLowPriority('node', ['x.js'], { detached: true });
      expect(spawnMock).toHaveBeenCalledWith(
        'taskpolicy',
        ['-b', '--', 'node', 'x.js'],
        { detached: true },
      );
    });

    it('spawns directly when taskpolicy is unavailable', async () => {
      accessSyncMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { spawnLowPriority } = await import('../../src/shared/low-priority.js');
      spawnLowPriority('node', ['x.js'], { detached: true });
      expect(spawnMock).toHaveBeenCalledWith('node', ['x.js'], { detached: true });
    });

    it('returns the ChildProcess produced by node spawn', async () => {
      accessSyncMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { spawnLowPriority } = await import('../../src/shared/low-priority.js');
      const child = spawnLowPriority('node', ['x.js'], {});
      expect(child.pid).toBe(4321);
    });
  });

  describe('applySelfLowPriority', () => {
    it('calls os.setPriority(0, nice) with the given nice value', async () => {
      const { applySelfLowPriority } = await import('../../src/shared/low-priority.js');
      applySelfLowPriority(10);
      expect(setPriorityMock).toHaveBeenCalledWith(0, 10);
    });

    it('defaults to nice 5 when omitted', async () => {
      const { applySelfLowPriority } = await import('../../src/shared/low-priority.js');
      applySelfLowPriority();
      expect(setPriorityMock).toHaveBeenCalledWith(0, 5);
    });

    it('never throws when os.setPriority throws', async () => {
      setPriorityMock.mockImplementation(() => {
        throw new Error('EPERM');
      });
      const { applySelfLowPriority } = await import('../../src/shared/low-priority.js');
      expect(() => applySelfLowPriority()).not.toThrow();
    });
  });
});

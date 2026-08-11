import { describe, it, expect, vi } from 'vitest';
import { createSchedulerChildRunner } from '../../src/mcp/scheduler-child.js';
import { EventEmitter } from 'node:events';

function fakeChild() {
  const e: any = new EventEmitter();
  e.exitCode = null;
  e.killed = false;
  e.pid = 4242;
  e.unref = () => {};
  e.kill = vi.fn((sig) => {
    e.killed = true;
    e.exitCode = null;
    return true;
  });
  return e;
}

describe('createSchedulerChildRunner', () => {
  it('spawns `intel tick` as a detached low-prio child on tick()', () => {
    const spawn = vi.fn(() => fakeChild());
    const r = createSchedulerChildRunner({ scriptPath: '/x/karpathy.js', projectRoot: '/proj', maxRuntimeMs: 1000, spawn });
    r.tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, o] = spawn.mock.calls[0];
    expect(args).toEqual(['/x/karpathy.js', 'intel', 'tick', '--project-root', '/proj']);
    expect(o).toMatchObject({ detached: true, stdio: 'ignore', cwd: '/proj' });
  });

  it('overlap guard: does not spawn while the previous child still runs', () => {
    const spawn = vi.fn(() => fakeChild());
    const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 100000, spawn });
    r.tick();
    r.tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('runaway cap: kills a child past maxRuntime and spawns fresh', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    let t = 0;
    const now = () => t;
    const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 5000, spawn, now });
    r.tick(); // spawns at t=0
    t = 6000;
    r.tick(); // past cap → kill + respawn
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('tick() is non-blocking (returns synchronously without awaiting the child)', () => {
    const spawn = vi.fn(() => fakeChild());
    const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 1000, spawn });
    expect(r.tick()).toBeUndefined(); // fire-and-forget
  });

  it('clears tracking when the child exits', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 1000, spawn });
    r.tick();
    expect(r.current()).not.toBeNull();
    child.exitCode = 0;
    child.emit('exit', 0);
    expect(r.current()).toBeNull();
  });

  it('does not throw uncaught on a spawn-level "error" event, and clears tracking', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 1000, spawn, log });
    r.tick();
    expect(r.current()).not.toBeNull();
    expect(() => child.emit('error', new Error('ENOENT: spawn failed'))).not.toThrow();
    expect(r.current()).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      'scheduler child spawn error',
      expect.objectContaining({ error: expect.stringContaining('ENOENT') }),
    );
  });

  it('an "error" event from a stale (already-replaced) child does not clear current tracking', () => {
    const staleChild = fakeChild();
    const freshChild = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(staleChild).mockReturnValueOnce(freshChild);
    let t = 0;
    const now = () => t;
    const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 5000, spawn, now });
    r.tick(); // spawns staleChild at t=0
    t = 6000;
    r.tick(); // past cap -> kills staleChild, spawns freshChild
    expect(r.current()?.child).toBe(freshChild);
    // A late 'error' event from the already-replaced staleChild must not
    // clear tracking for the current (fresh) child.
    staleChild.emit('error', new Error('late error from stale child'));
    expect(r.current()?.child).toBe(freshChild);
  });
});

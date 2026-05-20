import { describe, it, expect } from 'vitest';
import { mergeHooks } from '../../src/bin/karpathy.js';

describe('mergeHooks', () => {
  const karpathyHooks: Record<string, unknown[]> = {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node /path/karpathy.js hook session-start', timeout: 10 }] },
    ],
    PostToolUse: [
      { hooks: [{ type: 'command', command: 'node /path/karpathy.js hook post-tool-use', timeout: 5, async: true }] },
    ],
  };

  it('preserves non-Karpathy hooks', () => {
    const existing: Record<string, unknown[]> = {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node my-other-tool.js start', timeout: 5 }] },
      ],
    };

    const result = mergeHooks(existing, karpathyHooks);

    // Should have both: the existing hook and the Karpathy hook
    expect(result.SessionStart).toHaveLength(2);
    expect(result.SessionStart[0]).toEqual(existing.SessionStart[0]);
    expect(result.SessionStart[1]).toEqual(karpathyHooks.SessionStart[0]);
  });

  it('replaces old Karpathy hooks on reinstall', () => {
    const existing: Record<string, unknown[]> = {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node /old/path/karpathy.js hook session-start', timeout: 5 }] },
        { hooks: [{ type: 'command', command: 'node my-other-tool.js start', timeout: 5 }] },
      ],
    };

    const result = mergeHooks(existing, karpathyHooks);

    // Old Karpathy hook should be replaced, other hook preserved
    expect(result.SessionStart).toHaveLength(2);
    expect(result.SessionStart[0]).toEqual(existing.SessionStart[1]); // other tool preserved
    expect(result.SessionStart[1]).toEqual(karpathyHooks.SessionStart[0]); // new Karpathy hook
  });

  it('handles empty existing hooks', () => {
    const result = mergeHooks({}, karpathyHooks);

    expect(result.SessionStart).toHaveLength(1);
    expect(result.PostToolUse).toHaveLength(1);
  });

  it('preserves hooks for events not in Karpathy hooks', () => {
    const existing: Record<string, unknown[]> = {
      CustomEvent: [
        { hooks: [{ type: 'command', command: 'echo custom', timeout: 5 }] },
      ],
    };

    const result = mergeHooks(existing, karpathyHooks);

    expect(result.CustomEvent).toEqual(existing.CustomEvent);
    expect(result.SessionStart).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { parseProjectRootArg } from '../../src/mcp/server-args.js';

describe('parseProjectRootArg', () => {
  it('returns the path after --project-root', () => {
    expect(parseProjectRootArg(['--project-root', '/some/path'])).toBe('/some/path');
  });

  it('returns undefined when flag absent', () => {
    expect(parseProjectRootArg([])).toBeUndefined();
  });

  it('returns undefined when --project-root has no value', () => {
    expect(parseProjectRootArg(['--project-root'])).toBeUndefined();
  });
});

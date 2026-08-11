import { describe, it, expect } from 'vitest';
import { shouldTrip } from '../../src/mcp/watchdog-worker.js';

describe('shouldTrip', () => {
  it('trips only when the heartbeat is older than the timeout', () => {
    expect(shouldTrip(1000, 1000 + 30001, 30000)).toBe(true);
    expect(shouldTrip(1000, 1000 + 30000, 30000)).toBe(false);
    expect(shouldTrip(1000, 1000 + 100, 30000)).toBe(false);
  });

  it('importing the module does not start the worker loop (workerData is null in main thread)', () => {
    // no throw, no hang — the entry is guarded
    expect(typeof shouldTrip).toBe('function');
  });
});

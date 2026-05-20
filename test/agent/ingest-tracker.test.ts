import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIngestTracker } from '../../src/agent/ingest-tracker.js';

describe('ingest-tracker', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-tracker-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('records incremental ingest and returns count', async () => {
    const tracker = createIngestTracker(tempDir);

    const r1 = await tracker.recordIncremental('auth-redesign', 'raw/session-001.md', 5);
    expect(r1.count).toBe(1);
    expect(r1.thresholdReached).toBe(false);

    const r2 = await tracker.recordIncremental('auth-redesign', 'raw/session-002.md', 5);
    expect(r2.count).toBe(2);
    expect(r2.thresholdReached).toBe(false);
  });

  it('triggers threshold when count reaches limit', async () => {
    const tracker = createIngestTracker(tempDir);

    for (let i = 1; i < 5; i++) {
      const r = await tracker.recordIncremental('proj', `raw/s${i}.md`, 5);
      expect(r.thresholdReached).toBe(false);
    }

    const r5 = await tracker.recordIncremental('proj', 'raw/s5.md', 5);
    expect(r5.thresholdReached).toBe(true);
    expect(r5.count).toBe(5);
  });

  it('tracks sources since last synthesis', async () => {
    const tracker = createIngestTracker(tempDir);

    await tracker.recordIncremental('proj', 'raw/s1.md', 10);
    await tracker.recordIncremental('proj', 'raw/s2.md', 10);

    const state = await tracker.getProjectState('proj');
    expect(state).not.toBeNull();
    expect(state!.sourcesSinceLastSynthesis).toContain('raw/s1.md');
    expect(state!.sourcesSinceLastSynthesis).toContain('raw/s2.md');
  });

  it('deduplicates source paths', async () => {
    const tracker = createIngestTracker(tempDir);

    await tracker.recordIncremental('proj', 'raw/s1.md', 10);
    await tracker.recordIncremental('proj', 'raw/s1.md', 10);

    const state = await tracker.getProjectState('proj');
    expect(state!.sourcesSinceLastSynthesis).toHaveLength(1);
    expect(state!.incrementalCount).toBe(2); // Count still increments
  });

  it('resets on full synthesis', async () => {
    const tracker = createIngestTracker(tempDir);

    await tracker.recordIncremental('proj', 'raw/s1.md', 5);
    await tracker.recordIncremental('proj', 'raw/s2.md', 5);
    await tracker.recordIncremental('proj', 'raw/s3.md', 5);

    await tracker.recordFullSynthesis('proj');

    const state = await tracker.getProjectState('proj');
    expect(state!.incrementalCount).toBe(0);
    expect(state!.sourcesSinceLastSynthesis).toHaveLength(0);
    expect(state!.lastFullSynthesis).toBeTruthy();
  });

  it('tracks multiple projects independently', async () => {
    const tracker = createIngestTracker(tempDir);

    await tracker.recordIncremental('proj-a', 'raw/a1.md', 5);
    await tracker.recordIncremental('proj-a', 'raw/a2.md', 5);
    await tracker.recordIncremental('proj-b', 'raw/b1.md', 5);

    const stateA = await tracker.getProjectState('proj-a');
    const stateB = await tracker.getProjectState('proj-b');
    expect(stateA!.incrementalCount).toBe(2);
    expect(stateB!.incrementalCount).toBe(1);
  });

  it('returns null for unknown project', async () => {
    const tracker = createIngestTracker(tempDir);
    const state = await tracker.getProjectState('nonexistent');
    expect(state).toBeNull();
  });

  it('getAll returns complete state', async () => {
    const tracker = createIngestTracker(tempDir);

    await tracker.recordIncremental('proj-a', 'raw/a1.md', 5);
    await tracker.recordIncremental('proj-b', 'raw/b1.md', 5);

    const all = await tracker.getAll();
    expect(Object.keys(all.projects)).toHaveLength(2);
    expect(all.projects['proj-a']).toBeTruthy();
    expect(all.projects['proj-b']).toBeTruthy();
  });
});

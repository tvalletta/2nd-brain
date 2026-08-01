import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { writeResearchQueue } from '../../src/maintenance/research-queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { runHealthCheck } from '../../src/intelligence/health-check.js';

describe('checkResearchQueue (via runHealthCheck) — non-default layout.system (G0)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-health-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports real counts under a non-default layout.system (regression: used to always report 0/0/0)', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      projectRoot: dir,
      layout: { system: 'Curated/_system' },
    });
    const vault = createFsAdapter(dir);
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'raptor', title: 'RAPTOR', score: 0.5, reason: 'r', suggested: 'light', decision: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'done', title: 'Done', score: 0.4, reason: 'r', suggested: 'light', decision: 'light', status: 'completed', addedAt: '2026-05-01T00:00:00.000Z', completedAt: '2026-06-01T00:00:00.000Z', completedDepth: 'light' },
      ],
    }, config.layout);

    const report = await runHealthCheck({ projectRoot: dir, config });

    const check = report.checks.find((c) => c.id === 'research-queue');
    expect(check?.message).toBe('Research queue: 1 pending, 1 approved, 1 completed');
    expect(report.metrics.researchPending).toBe(1);
    expect(report.metrics.researchApproved).toBe(1);
    expect(report.metrics.researchCompleted).toBe(1);
  });

  it('reports 0/0/0 when config is null (vault not reachable) — unaffected regression', async () => {
    const report = await runHealthCheck({ projectRoot: dir, config: null });
    expect(report.metrics.researchPending).toBe(0);
    expect(report.metrics.researchApproved).toBe(0);
    expect(report.metrics.researchCompleted).toBe(0);
  });
});

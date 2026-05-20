import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { evaluateRefreshCandidatesHandler } from '../../../src/jobs/handlers/evaluate-refresh-candidates.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(targetPath: string): Job {
  return {
    id: 'test-job',
    type: 'evaluate-refresh-candidates',
    status: 'running',
    priority: 50,
    targetPath,
    payload: {},
    trigger: 'cascade',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('evaluate-refresh-candidates handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];
  const notePath = 'wiki/concepts/fsrs.md';

  function makeCtx(overrides: Partial<Record<string, unknown>> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => {
        enqueued.push(input);
        return { ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0, priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade' } as Job;
      },
      // Handler is deterministic — these aren't called.
      llm: {} as never,
      config,
    };
  }

  async function writeNote(fields: Record<string, unknown>) {
    const fm = {
      id: 'concept-fsrs',
      type: 'concept',
      title: 'FSRS',
      status: 'active',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
      ...fields,
    };
    await vault.create(notePath, serializeNote(fm, 'body'));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-eval-refresh-'));
    vault = createFsAdapter(dir);
    enqueued = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('enqueues topic-refresh when pending_evidence_count >= threshold', async () => {
    await writeNote({ pending_evidence_count: 3 });
    await evaluateRefreshCandidatesHandler.execute(makeJob(notePath), makeCtx());
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe('topic-refresh');
    expect(enqueued[0].targetPath).toBe(notePath);
    expect(enqueued[0].dedupeKey).toBe(`topic-refresh:${notePath}`);
    const reason = (enqueued[0].payload as { reason: string }).reason;
    expect(reason).toMatch(/evidence-threshold/);
  });

  it('does not enqueue when pending_evidence_count is below threshold', async () => {
    await writeNote({ pending_evidence_count: 2 });
    await evaluateRefreshCandidatesHandler.execute(makeJob(notePath), makeCtx());
    expect(enqueued).toHaveLength(0);
  });

  it('falls back to retrievability when below threshold but stale', async () => {
    // last_verified far in the past + low stability → retrievability ≈ 0.
    await writeNote({
      pending_evidence_count: 1,
      last_verified: '2020-01-01T00:00:00.000Z',
      stability: 5,
    });
    await evaluateRefreshCandidatesHandler.execute(makeJob(notePath), makeCtx());
    expect(enqueued).toHaveLength(1);
    const reason = (enqueued[0].payload as { reason: string }).reason;
    expect(reason).toMatch(/retrievability/);
  });

  it('does not consult retrievability when pending evidence is empty', async () => {
    // Stale but no pending evidence — decay-scan owns this case, not us.
    await writeNote({
      pending_evidence_count: 0,
      last_verified: '2020-01-01T00:00:00.000Z',
      stability: 5,
    });
    await evaluateRefreshCandidatesHandler.execute(makeJob(notePath), makeCtx());
    expect(enqueued).toHaveLength(0);
  });

  it('is a no-op when refresh is disabled', async () => {
    await writeNote({ pending_evidence_count: 99 });
    await evaluateRefreshCandidatesHandler.execute(
      makeJob(notePath),
      makeCtx({ intelligence: { refresh: { enabled: false } } }),
    );
    expect(enqueued).toHaveLength(0);
  });

  it('skips silently when the note does not exist', async () => {
    // No note written.
    await evaluateRefreshCandidatesHandler.execute(makeJob(notePath), makeCtx());
    expect(enqueued).toHaveLength(0);
  });
});

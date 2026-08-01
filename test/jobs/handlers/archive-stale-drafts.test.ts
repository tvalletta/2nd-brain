import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { archiveStaleDraftsHandler } from '../../../src/jobs/handlers/archive-stale-drafts.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(): Job {
  return {
    id: 'test-archive-stale-drafts', type: 'archive-stale-drafts', status: 'running', priority: 90,
    payload: {}, trigger: 'timer', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('archive-stale-drafts handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-asd-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('outputs/source-summaries');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeDraft(path: string, createdAt: string, status = 'draft'): Promise<void> {
    await vault.create(
      path,
      serializeNote(
        {
          // `id` embeds the per-test temp dir (unique per `beforeEach`) rather
          // than just `path`, so two tests that happen to reuse the same
          // relative path + createdAt + status still produce byte-distinct
          // serialized frontmatter. Without this, gray-matter's internal
          // parse cache (keyed by the literal file-content string, see
          // node_modules/gray-matter's `matter.cache`) would hand back the
          // SAME cached `data` object to both tests — and since the handler
          // mutates `data` in place, one test's archival would silently leak
          // into the other's "before" state. Confirmed this exact collision
          // by reproducing it locally before adding this guard.
          id: `${dir}:${path}`, type: 'source_summary', title: path, status,
          source_type: 'transcript', source_path: 'raw/x.md', ingest_status: 'detected',
          created_at: createdAt, updated_at: createdAt,
        },
        'body.',
      ),
    );
  }

  // --- (b) THE single most important test in this task -----------------------
  it('is a genuine no-op (zero mutations) when staleDraftArchiveEnabled is false (the default), even though the master enabled flag defaults to true', async () => {
    await makeDraft('outputs/source-summaries/old.md', '2026-01-01T00:00:00Z');
    const ctx = makeCtx();
    // Sanity-check the exact flag combination this test is exercising.
    expect(ctx.config.intelligence.lifecycle.enabled).toBe(true);
    expect(ctx.config.intelligence.lifecycle.staleDraftArchiveEnabled).toBe(false);

    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/old.md'));
    expect(data.status).toBe('draft');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
    // updated_at must be byte-for-byte unchanged — proof the file was never rewritten.
    expect(data.updated_at).toBe('2026-01-01T00:00:00Z');
    expect(await vault.exists('log.md')).toBe(false);
  });

  // --- (c) master enabled flag off, even with staleDraftArchiveEnabled on ----
  it('is a no-op when the master intelligence.lifecycle.enabled flag is false, even if staleDraftArchiveEnabled is true', async () => {
    await makeDraft('outputs/source-summaries/old-master-off.md', '2026-01-01T00:00:00Z');
    const ctx = makeCtx({
      intelligence: { lifecycle: { enabled: false, staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } },
    });
    expect(ctx.config.intelligence.lifecycle.enabled).toBe(false);
    expect(ctx.config.intelligence.lifecycle.staleDraftArchiveEnabled).toBe(true);

    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/old-master-off.md'));
    expect(data.status).toBe('draft');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
    expect(data.updated_at).toBe('2026-01-01T00:00:00Z');
    expect(await vault.exists('log.md')).toBe(false);
  });

  // --- (a) the happy path: both flags on ---------------------------------
  it('archives a draft source_summary past staleDraftArchiveDays when BOTH enabled and staleDraftArchiveEnabled are true', async () => {
    await makeDraft('outputs/source-summaries/old.md', '2026-01-01T00:00:00Z');
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    expect(ctx.config.intelligence.lifecycle.enabled).toBe(true);
    expect(ctx.config.intelligence.lifecycle.staleDraftArchiveEnabled).toBe(true);

    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/old.md'));
    expect(data.status).toBe('archived');
    expect(data.archived_at).toBeDefined();
    expect(data.archived_reason).toContain('stale-draft');
    expect(data.archived_reason).toContain('detected');
  });

  // --- (d) a draft younger than the threshold is untouched -----------------
  it('does not archive a draft younger than staleDraftArchiveDays', async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await makeDraft('outputs/source-summaries/recent.md', recent);
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/recent.md'));
    expect(data.status).toBe('draft');
  });

  // --- (e) already-active/archived/rejected sources are untouched regardless of age
  it.each(['active', 'archived', 'rejected'] as const)(
    'does not touch a source_summary that is already status: %s, regardless of age',
    async (status) => {
      await makeDraft(`outputs/source-summaries/done-${status}.md`, '2020-01-01T00:00:00Z', status);
      const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
      await archiveStaleDraftsHandler.execute(makeJob(), ctx);

      const { data } = parseNote(await vault.read(`outputs/source-summaries/done-${status}.md`));
      expect(data.status).toBe(status);
    },
  );

  // --- (f) the log line fires only when archived > 0 ------------------------
  it('logs a lifecycle:archive-stale-drafts entry only when at least one note is archived', async () => {
    await makeDraft('outputs/source-summaries/old.md', '2026-01-01T00:00:00Z');
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const log = await vault.read('log.md');
    expect(log).toContain('lifecycle:archive-stale-drafts');
    expect(log).toContain('1 stale draft source(s) archived');
  });

  it('does not log when nothing is archived', async () => {
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    expect(await vault.exists('log.md')).toBe(false);
  });
});

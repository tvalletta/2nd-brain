import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  openEmbeddingStore,
  createDeterministicProvider,
} from '../../src/embeddings/index.js';
import { runWeeklyDigest } from '../../src/intelligence/digest.js';
import { isoWeek } from '../../src/intelligence/iso-week.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

function fakeLLM(label: string, summary: string): LLMClient {
  return {
    async complete() {
      return JSON.stringify({ label, summary });
    },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse({ label, summary });
    },
  };
}

describe('weekly digest (B1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-dig-'));
    vault = createFsAdapter(dir);
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('isoWeek returns correct ISO week', () => {
    expect(isoWeek(new Date('2026-01-05'))).toBe('2026-W02');
    expect(isoWeek(new Date('2026-05-06'))).toBe('2026-W19');
  });

  it('clusters recent chunks into a digest with strong-signal trend', async () => {
    // Seed 4 highly-similar chunks (same content) and 4 unrelated chunks.
    const recent = '2026-05-05T00:00:00Z';
    for (let i = 0; i < 6; i++) {
      await store.upsert([
        {
          doc_id: `wiki/sessions/fsrs-${i}.md`,
          chunk_index: 0,
          chunk_hash: `f${i}`,
          text: 'fsrs spaced repetition stability difficulty retrievability scheduling',
          metadata: { type: 'session_summary', updated_at: recent },
        },
      ]);
    }
    for (let i = 0; i < 6; i++) {
      await store.upsert([
        {
          doc_id: `wiki/sessions/cooking-${i}.md`,
          chunk_index: 0,
          chunk_hash: `c${i}`,
          text: 'sauteing onions garlic butter herbs salt pepper recipe technique',
          metadata: { type: 'session_summary', updated_at: recent },
        },
      ]);
    }

    const llm = fakeLLM('FSRS / spaced repetition', 'Multiple sessions discussed FSRS internals.');
    const result = await runWeeklyDigest(
      { vault, llm, store },
      {
        windowDays: 7,
        minClusterSize: 3,
        maxClusters: 5,
        nowMs: Date.parse('2026-05-06T00:00:00Z'),
        joinThreshold: 0.5,
      },
    );

    expect(result.totalChunks).toBe(12);
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    const c0 = result.clusters[0];
    expect(c0.size).toBeGreaterThanOrEqual(3);
    expect(c0.label).toBe('FSRS / spaced repetition');
    expect(c0.trend === 'strong' || c0.trend === 'weak').toBe(true);

    const digest = await vault.read(result.digestPath);
    expect(digest).toContain('Hot topics — 2026-W19');
    expect(digest).toContain('FSRS / spaced repetition');
    expect(digest).toContain('wiki/sessions/fsrs-0');

    // Verify log + digest index were created.
    const log = await vault.read('log.md');
    expect(log).toContain('digest:weekly');
    const idx = await vault.read('wiki/digests/_index.md');
    expect(idx).toContain('2026-W19');
  });

  it('returns empty cluster list when no recent chunks', async () => {
    const llm = fakeLLM('x', 'y');
    const result = await runWeeklyDigest(
      { vault, llm, store },
      { windowDays: 7, minClusterSize: 3, maxClusters: 5, nowMs: Date.parse('2026-05-06T00:00:00Z') },
    );
    expect(result.totalChunks).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  describe('labelCluster fallback (via runWeeklyDigest)', () => {
    const FSRS_TEXT = 'fsrs spaced repetition stability difficulty retrievability scheduling';

    async function seedFsrsCluster() {
      const recent = '2026-05-05T00:00:00Z';
      for (let i = 0; i < 6; i++) {
        await store.upsert([
          {
            doc_id: `wiki/sessions/fsrs-${i}.md`,
            chunk_index: 0,
            chunk_hash: `f${i}`,
            text: FSRS_TEXT,
            metadata: { type: 'session_summary', updated_at: recent },
          },
        ]);
      }
    }

    it('rejects with the original TransientLLMError instead of falling back to a synthesized label', async () => {
      await seedFsrsCluster();
      const transientError = new TransientLLMError('VPN down');
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured() {
          throw transientError;
        },
      };

      let caught: unknown;
      try {
        await runWeeklyDigest(
          { vault, llm, store },
          {
            windowDays: 7,
            minClusterSize: 3,
            maxClusters: 5,
            nowMs: Date.parse('2026-05-06T00:00:00Z'),
            joinThreshold: 0.5,
          },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(transientError);
      expect(caught).toBeInstanceOf(TransientLLMError);
    });

    it('falls back to a token-frequency label on a non-transient error (unchanged behavior)', async () => {
      await seedFsrsCluster();
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured() {
          throw new Error('LLM call failed');
        },
      };

      const result = await runWeeklyDigest(
        { vault, llm, store },
        {
          windowDays: 7,
          minClusterSize: 3,
          maxClusters: 5,
          nowMs: Date.parse('2026-05-06T00:00:00Z'),
          joinThreshold: 0.5,
        },
      );

      expect(result.clusters.length).toBe(1);
      // All seeded chunks share byte-identical text, so the token-frequency
      // tally and its insertion-order tie-break are independent of which
      // members `representativeMembers` picks or in what order.
      expect(result.clusters[0].label).toBe('fsrs / spaced / repetition');
      expect(result.clusters[0].summary).toBe(FSRS_TEXT);
    });
  });
});

describe('weekly digest — allSince windowing (Fix C)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let db: Database.Database;
  let store: ReturnType<typeof openEmbeddingStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-dig-fixc-'));
    vault = createFsAdapter(dir);
    db = new Database(join(dir, 'embeddings.sqlite'));
    db.pragma('journal_mode = WAL');
    store = openEmbeddingStore({ db, provider: createDeterministicProvider() });
  });

  afterEach(async () => {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('excludes chunks older than the window via the SQL-pushed cutoff, same as the old JS-filter path', async () => {
    const FSRS_TEXT = 'fsrs spaced repetition stability difficulty retrievability scheduling';
    // 5 chunks inside the 7-day window, 5 chunks well outside it.
    for (let i = 0; i < 5; i++) {
      await store.upsert([
        {
          doc_id: `wiki/sessions/recent-${i}.md`,
          chunk_index: 0,
          chunk_hash: `r${i}`,
          text: FSRS_TEXT,
          metadata: { type: 'session_summary' },
        },
      ]);
    }
    for (let i = 0; i < 5; i++) {
      await store.upsert([
        {
          doc_id: `wiki/sessions/stale-${i}.md`,
          chunk_index: 0,
          chunk_hash: `s${i}`,
          text: FSRS_TEXT,
          metadata: { type: 'session_summary' },
        },
      ]);
    }
    const nowMs = Date.parse('2026-05-06T00:00:00Z');
    const cutoffIso = new Date(nowMs - 7 * 86400_000).toISOString();
    const staleIso = new Date(nowMs - 30 * 86400_000).toISOString();
    db.prepare(
      `UPDATE embeddings SET updated_at = ? WHERE doc_id LIKE 'wiki/sessions/stale-%'`,
    ).run(staleIso);
    // Recent rows get stamped just inside the window.
    const recentIso = new Date(nowMs - 1 * 86400_000).toISOString();
    db.prepare(
      `UPDATE embeddings SET updated_at = ? WHERE doc_id LIKE 'wiki/sessions/recent-%'`,
    ).run(recentIso);

    // Sanity: this is exactly the equivalence the store-level test proves —
    // restated here against the real caller (runWeeklyDigest) so a future
    // regression in how digest.ts wires the cutoff is caught even if the
    // store-level test still passes.
    const expectedRecent = store
      .all()
      .filter((r) => new Date(r.updated_at).getTime() >= new Date(cutoffIso).getTime());
    expect(expectedRecent).toHaveLength(5);

    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse({ label: 'FSRS', summary: 'FSRS cluster' });
      },
    };

    const result = await runWeeklyDigest(
      { vault, llm, store },
      { windowDays: 7, minClusterSize: 3, maxClusters: 5, nowMs, joinThreshold: 0.5 },
    );

    expect(result.totalChunks).toBe(5);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].size).toBe(5);
    const allSourcedPaths = result.clusters[0].topPaths;
    expect(allSourcedPaths.every((p) => p.startsWith('wiki/sessions/recent-'))).toBe(true);
  });
});

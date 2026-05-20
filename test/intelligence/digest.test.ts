import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  openEmbeddingStore,
  createDeterministicProvider,
} from '../../src/embeddings/index.js';
import { runWeeklyDigest } from '../../src/intelligence/digest.js';
import { isoWeek } from '../../src/intelligence/iso-week.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

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
});

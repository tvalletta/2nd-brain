import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  openEmbeddingStore,
  createDeterministicProvider,
} from '../../src/embeddings/index.js';
import { proposeResearch } from '../../src/intelligence/research-propose.js';
import {
  parseSlackReply,
  applyDecisions,
  formatQueueDigest,
} from '../../src/intelligence/slack-notify.js';
import { executeResearch } from '../../src/intelligence/research-execute.js';
import { heuristicGate } from '../../src/intelligence/significance-gate.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { readResearchQueue, writeResearchQueue } from '../../src/maintenance/research-queue.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function fakeLLM(payload: unknown): LLMClient {
  return {
    async complete() {
      return JSON.stringify(payload);
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(payload);
    },
  };
}

describe('research-propose (D1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-prop-'));
    vault = createFsAdapter(dir);
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    await vault.ensureFolder('wiki/topics');
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('ranks candidates by gap_score and writes the queue', async () => {
    await vault.create(
      'wiki/topics/fsrs.md',
      `---
id: fsrs
type: topic
title: FSRS
created_at: 2025-09-01T00:00:00Z
updated_at: 2025-09-01T00:00:00Z
last_verified: 2025-09-01T00:00:00Z
stability: 30
half_life_domain: ai-research
confidence: low
---
body.`,
    );
    // Seed the embedding store with multiple recent mentions of FSRS.
    for (let i = 0; i < 5; i++) {
      await store.upsert([
        {
          doc_id: `wiki/sessions/s${i}.md`,
          chunk_index: 0,
          chunk_hash: `h${i}`,
          text: 'discussion of FSRS spaced repetition algorithm and stability',
          metadata: { type: 'session_summary' },
        },
      ]);
    }

    const result = await proposeResearch(
      { vault, config, store },
      { nowMs: Date.parse('2026-05-06T00:00:00Z') },
    );

    expect(result.scanned).toBe(1);
    expect(result.proposed).toBe(1);
    expect(result.topCandidates[0].slug).toBe('fsrs');
    expect(result.topCandidates[0].score).toBeGreaterThan(0.4);

    const queue = await readResearchQueue(vault);
    expect(queue.candidates).toHaveLength(1);
  });
});

describe('research-propose auto-drain (G1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-drain-'));
    vault = createFsAdapter(dir);
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    await vault.ensureFolder('wiki/topics');
    // Backing pages for every slug this describe block seeds into the queue
    // below. Required as of G3's orphan-purge (Task 5): a queue candidate
    // with no backing page in wiki/concepts or wiki/topics is now purged
    // *before* the drain loop ever sees it. Without these, every test here
    // would actually be exercising orphan-purge rather than the
    // decision/autoDrainEnabled filtering it claims to test.
    for (const [slug, title] of [
      ['fsrs', 'FSRS'],
      ['raptor', 'RAPTOR'],
      ['undecided', 'Undecided'],
    ]) {
      await vault.create(
        `wiki/topics/${slug}.md`,
        `---\nid: ${slug}\ntype: topic\ntitle: ${title}\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nbody.`,
      );
    }
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not enqueue anything when autoDrainEnabled is false (default), even with decided pending candidates', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => ({}) as never);

    await proposeResearch({ vault, config, store, enqueue }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues exactly one research-execute job per decided pending candidate when autoDrainEnabled is true, skipping "skip" and undecided candidates', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'raptor', title: 'RAPTOR', score: 0.5, reason: 'r', suggested: 'light', decision: 'skip', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'undecided', title: 'Undecided', score: 0.4, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => ({}) as never);

    await proposeResearch({ vault, config, store, enqueue }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      type: 'research-execute',
      payload: { slug: 'fsrs', depth: 'medium' },
      priority: 80,
      trigger: 'cascade',
      dedupeKey: 'research-execute:fsrs',
    });
  });

  it('logs research:drain only when something was actually drained', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    await proposeResearch(
      { vault, config, store, enqueue: async () => ({}) as never },
      { nowMs: Date.parse('2026-07-01T00:00:00Z') },
    );

    const log = await vault.read('log.md');
    expect(log).toContain('research:drain');
    expect(log).toContain('1 decided candidate(s) drained');
  });

  it('does not log research:drain on a no-op cycle (no decided pending candidates)', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'undecided', title: 'Undecided', score: 0.4, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    await proposeResearch(
      { vault, config, store, enqueue: async () => ({}) as never },
      { nowMs: Date.parse('2026-07-01T00:00:00Z') },
    );

    const log = await vault.read('log.md');
    expect(log).not.toContain('research:drain');
  });
});

describe('research-propose orphan purge + confidenceGap (G3/G4/G5)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-purge-'));
    vault = createFsAdapter(dir);
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    await vault.ensureFolder('wiki/topics');
    await vault.ensureFolder('wiki/concepts');
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('never proposes a wiki/concepts/*.md page even if type: concept (regression proving the dead scan is truly removed)', async () => {
    await vault.create(
      'wiki/concepts/dead-scan.md',
      `---
id: dead-scan
type: concept
title: Dead scan
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
body.`,
    );
    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(result.scanned).toBe(0);
    expect(result.topCandidates.find((c) => c.slug === 'dead-scan')).toBeUndefined();
  });

  it('purges a carried-forward candidate whose backing page no longer exists in either folder', async () => {
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'orphaned', title: 'Orphaned', score: 0.5, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-05-01T00:00:00.000Z' },
      ],
    });

    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(result.topCandidates.find((c) => c.slug === 'orphaned')).toBeUndefined();
    const queue = await readResearchQueue(vault);
    expect(queue.candidates.find((c) => c.slug === 'orphaned')).toBeUndefined();

    const log = await vault.read('log.md');
    expect(log).toContain('research:orphans-purged');
    expect(log).toContain('orphaned');
  });

  it('keeps a carried-forward candidate whose backing wiki/topics page still exists', async () => {
    await vault.create(
      'wiki/topics/still-real.md',
      `---
id: still-real
type: topic
title: Still real
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
body.`,
    );
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'still-real', title: 'Still real', score: 0.5, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-05-01T00:00:00.000Z' },
      ],
    });

    // Below the entry threshold on its own (no embedding-store mentions), so
    // it only survives via the carry-forward path, not fresh re-detection --
    // proving the *carry-forward* orphan check specifically (not just that
    // scanning finds it).
    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(result.topCandidates.find((c) => c.slug === 'still-real')).toBeDefined();
  });

  it('keeps a completed candidate regardless of whether its backing page still exists', async () => {
    await writeResearchQueue(vault, {
      candidates: [
        {
          slug: 'archived-elsewhere', title: 'Archived elsewhere', score: 0.5, reason: 'r', suggested: 'light',
          status: 'completed', addedAt: '2026-05-01T00:00:00.000Z', completedAt: '2026-06-25T00:00:00.000Z', completedDepth: 'light',
        },
      ],
    });

    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(result.topCandidates.find((c) => c.slug === 'archived-elsewhere')).toBeDefined();
  });

  it('logs research:queue-capped only when candidates are actually dropped by queueCap', async () => {
    const cappedConfig = KarpathyConfigSchema.parse({ vaultPath: '/tmp', intelligence: { research: { queueCap: 1 } } });
    // Backing pages required: as of G3's orphan-purge, a carried-forward
    // candidate with no backing page is dropped *before* the cap logic ever
    // runs, which would make this test pass for the wrong reason (purge,
    // not cap).
    await vault.create(
      'wiki/topics/keep-me.md',
      `---\nid: keep-me\ntype: topic\ntitle: Keep me\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nbody.`,
    );
    await vault.create(
      'wiki/topics/drop-me.md',
      `---\nid: drop-me\ntype: topic\ntitle: Drop me\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nbody.`,
    );
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'keep-me', title: 'Keep me', score: 0.9, reason: 'r', suggested: 'heavy', status: 'pending', addedAt: '2026-06-25T00:00:00.000Z' },
        { slug: 'drop-me', title: 'Drop me', score: 0.8, reason: 'r', suggested: 'heavy', status: 'pending', addedAt: '2026-06-25T00:00:00.000Z' },
      ],
    });

    const result = await proposeResearch({ vault, config: cappedConfig, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(result.proposed).toBe(1);
    const log = await vault.read('log.md');
    expect(log).toContain('research:queue-capped');
    expect(log).toContain('drop-me');
  });

  it('a topic note with no confidence field scores identically to one explicitly marked confidence: medium (G4 regression)', async () => {
    // half_life_domain: ai-research is present on BOTH notes identically --
    // it exists only to lift both scores above the 0.2 low-signal skip
    // threshold (via the domain-heat signal) so the confidenceGap
    // comparison below is actually exercised. Without it, both notes'
    // otherwise-identical (no mentions, no active project, plain 'topic'
    // domain) score falls to ~0.17 under either the buggy or fixed
    // confidenceGap value, and both get silently dropped by
    // `score < 0.2 && stats.count === 0` before ever reaching
    // topCandidates -- which would make this regression test pass (or
    // fail) for the wrong reason.
    await vault.create(
      'wiki/topics/no-confidence.md',
      `---
id: no-confidence
type: topic
title: No confidence
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
half_life_domain: ai-research
---
body.`,
    );
    await vault.create(
      'wiki/topics/medium-confidence.md',
      `---
id: medium-confidence
type: topic
title: Medium confidence
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
half_life_domain: ai-research
confidence: medium
---
body.`,
    );

    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    const noConf = result.topCandidates.find((c) => c.slug === 'no-confidence');
    const medConf = result.topCandidates.find((c) => c.slug === 'medium-confidence');
    expect(noConf).toBeDefined();
    expect(medConf).toBeDefined();
    // Both notes are otherwise identical (no mentions, no active-project
    // membership, no half_life_domain, same recency), so before G4 an unset
    // confidence would score 0.7 * 0.15 = 0.105 higher than the medium note.
    expect(noConf!.score).toBe(medConf!.score);
  });
});

describe('Slack reply parsing (D2)', () => {
  it('parses positional decisions', () => {
    const out = parseSlackReply('1 heavy, 2 medium, 3 light');
    expect(out).toEqual([
      { match: { index: 1 }, depth: 'heavy' },
      { match: { index: 2 }, depth: 'medium' },
      { match: { index: 3 }, depth: 'light' },
    ]);
  });

  it('parses leading-keyword form (skip 4 5)', () => {
    expect(parseSlackReply('skip 4 5')).toEqual([
      { match: { index: 4 }, depth: 'skip' },
      { match: { index: 5 }, depth: 'skip' },
    ]);
  });

  it('parses slug-based form', () => {
    expect(parseSlackReply('fsrs heavy, raptor medium')).toEqual([
      { match: { slug: 'fsrs' }, depth: 'heavy' },
      { match: { slug: 'raptor' }, depth: 'medium' },
    ]);
  });

  it('applyDecisions sets candidate.decision', () => {
    const candidates = [
      { slug: 'fsrs', title: 'FSRS', score: 0.9, reason: '', suggested: 'heavy', status: 'pending', addedAt: 't' },
      { slug: 'raptor', title: 'RAPTOR', score: 0.5, reason: '', suggested: 'medium', status: 'pending', addedAt: 't' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[];
    applyDecisions(candidates, parseSlackReply('1 heavy, raptor light'));
    expect(candidates[0].decision).toBe('heavy');
    expect(candidates[1].decision).toBe('light');
  });

  it('formats queue digest with top 5 and instructions', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      slug: `s${i}`,
      title: `Title ${i}`,
      score: 0.9 - i * 0.05,
      reason: 'because',
      suggested: 'medium' as const,
      status: 'pending' as const,
      addedAt: 't',
    }));
    const out = formatQueueDigest({ totalPending: 7, topCandidates: candidates, queuePath: 'wiki/_system/research-queue.md' });
    expect(out).toContain('7 pending');
    expect(out).toContain('Title 0');
    expect(out).toContain('Title 4');
    expect(out).not.toContain('Title 5');
    expect(out).toContain('Reply with picks');
  });
});

describe('research executor (D3)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-exec-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a concept page and marks queue completed', async () => {
    const llm = fakeLLM({
      tldr: 'FSRS — modern spaced repetition scheduler.',
      body: '## What it is\nFSRS is an algorithm.\n\n## Why it matters\nReal benefits.\n\n## How it works\nStability + difficulty.\n\n## Alternatives\nSM-2.\n\n## Recent changes\nv5 in 2024.',
      claims: [{ claim: 'FSRS outperforms SM-2', confidence: 'high' }],
      contradictions: [],
      coverage: { 'what-is': true, 'why-it-matters': true, 'how-it-works': true, alternatives: true, 'recent-changes': true },
    });

    const result = await executeResearch({ vault, llm, config }, 'fsrs', {
      depth: 'medium',
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.notePath).toBe('wiki/concepts/fsrs.md');
    expect(result.depth).toBe('medium');
    expect(result.totalQueries).toBeGreaterThan(0);

    const note = await vault.read(result.notePath);
    const { data, body } = parseNote(note);
    expect(data.last_verified).toBeDefined();
    expect(data.tldr).toContain('FSRS');
    expect(data.last_research_depth).toBe('medium');
    expect(body).toContain('## What it is');
    expect(body).toContain('%% begin:tldr %%');
    expect(body).toContain('%% begin:research %%');

    const queue = await readResearchQueue(vault);
    const completed = queue.candidates.find((c) => c.slug === 'fsrs');
    expect(completed?.status).toBe('completed');
    expect(completed?.completedDepth).toBe('medium');
  });
});

describe('significance gate (D4)', () => {
  it('drops too-short or stop-word names', () => {
    expect(heuristicGate({ name: 'X', kind: 'concept' }, []).action).toBe('drop');
    expect(heuristicGate({ name: 'thing', kind: 'concept' }, []).action).toBe('drop');
  });

  it('keeps real names', () => {
    expect(heuristicGate({ name: 'FSRS', kind: 'concept' }, []).action).toBe('keep');
  });

  it('merges into near-duplicate match of same kind', () => {
    const out = heuristicGate({ name: 'FSRS', kind: 'concept' }, [
      { slug: 'fsrs', name: 'FSRS', kind: 'concept', similarity: 0.95 },
    ]);
    expect(out.action).toBe('merge');
    if (out.action === 'merge') expect(out.intoSlug).toBe('fsrs');
  });

  it('does not merge across kinds', () => {
    const out = heuristicGate({ name: 'FSRS', kind: 'concept' }, [
      { slug: 'fsrs-tool', name: 'FSRS', kind: 'tool', similarity: 0.95 },
    ]);
    expect(out.action).toBe('keep');
  });
});

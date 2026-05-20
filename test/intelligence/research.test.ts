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
import { proposeResearch } from '../../src/intelligence/research-propose.js';
import {
  parseSlackReply,
  applyDecisions,
  formatQueueDigest,
} from '../../src/intelligence/slack-notify.js';
import { executeResearch } from '../../src/intelligence/research-execute.js';
import { heuristicGate } from '../../src/intelligence/significance-gate.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { readResearchQueue } from '../../src/maintenance/research-queue.js';
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
    await vault.ensureFolder('wiki/concepts');
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('ranks candidates by gap_score and writes the queue', async () => {
    await vault.create(
      'wiki/concepts/fsrs.md',
      `---
id: fsrs
type: concept
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

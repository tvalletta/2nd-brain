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
import { refreshTopic } from '../../src/intelligence/topic-refresh.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

interface FakeResponse {
  primary: string;
  secondary?: string;
  contradictions: { ref: string; reason: string }[];
  new_sources: string[];
}

function fakeLLM(response: FakeResponse): LLMClient {
  return {
    async complete() {
      return JSON.stringify(response);
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(response);
    },
  };
}

describe('topic-refresh (B2)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-tref-'));
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

  it('integrates new evidence and bumps last_verified + stability', async () => {
    const topicPath = 'wiki/topics/recency-aware-rag.md';
    await vault.create(
      topicPath,
      `---
id: t1
type: topic
title: Recency-aware RAG
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
last_verified: 2026-04-01T00:00:00Z
stability: 30
half_life_domain: topic
---
# Recency-aware RAG

%% begin:current-understanding %%
Initial framing — combine cosine sim with time decay.
%% end:current-understanding %%
`,
    );

    await store.upsert([
      {
        doc_id: 'wiki/sessions/2026-04-15.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'cross-encoder reranking with recency prior boosts freshness on transcripts',
        metadata: { type: 'session_summary' },
      },
      {
        doc_id: 'wiki/sessions/2026-04-20.md',
        chunk_index: 0,
        chunk_hash: 'h2',
        text: 'recency aware rag two-stage retrieval bi-encoder cross-encoder',
        metadata: { type: 'session_summary' },
      },
    ]);

    const llm = fakeLLM({
      primary:
        'Recency-aware RAG combines bi-encoder + cross-encoder + a recency prior. Two-stage retrieval is now table stakes [1][2].',
      contradictions: [],
      new_sources: ['wiki/sessions/2026-04-15.md', 'wiki/sessions/2026-04-20.md'],
    });

    const result = await refreshTopic({ vault, llm, store, config }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });

    expect(result.retrievedCount).toBe(2);
    expect(result.contradictionCount).toBe(0);
    expect(result.newSourcesAdded).toBe(2);
    expect(result.stabilityAfter).toBeGreaterThan(result.stabilityBefore!);

    const updated = await vault.read(topicPath);
    const { data, body } = parseNote(updated);
    expect(body).toContain('Two-stage retrieval');
    expect(body).toContain('%% begin:sources %%');
    expect(body).toContain('wiki/sessions/2026-04-15');
    expect(data.last_verified).toBeDefined();
    expect(Array.isArray(data.protected_regions)).toBe(true);
  });

  it('halves stability and records contradictions when the LLM reports them', async () => {
    const topicPath = 'wiki/topics/x.md';
    await vault.create(
      topicPath,
      `---
id: t2
type: topic
title: X
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 60
half_life_domain: topic
---
# X
%% begin:current-understanding %%
old understanding
%% end:current-understanding %%
`,
    );
    await store.upsert([
      { doc_id: 'wiki/sessions/c.md', chunk_index: 0, chunk_hash: 'h', text: 'conflicting evidence', metadata: { type: 'session_summary' } },
    ]);
    const llm = fakeLLM({
      primary: 'updated with caveats',
      contradictions: [{ ref: '[1]', reason: 'reverses prior claim' }],
      new_sources: [],
    });

    const result = await refreshTopic({ vault, llm, store, config }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });
    expect(result.contradictionCount).toBe(1);
    expect(result.stabilityAfter).toBeLessThan(60);

    const { data } = parseNote(await vault.read(topicPath));
    expect(Array.isArray(data.contradicts) && (data.contradicts as unknown[]).length).toBe(1);
  });

  it('Phase 1: clears pending_evidence and cascades depth-1 to linked neighbors', async () => {
    const topicPath = 'wiki/topics/recency-aware-rag.md';
    // Create a neighbor concept page that the rewritten region will link to.
    await vault.ensureFolder('wiki/concepts');
    await vault.create(
      'wiki/concepts/cross-encoder.md',
      `---
id: c1
type: concept
title: Cross Encoder
status: active
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Cross Encoder
`,
    );
    await vault.create(
      topicPath,
      `---
id: t4
type: topic
title: Recency-aware RAG
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
pending_evidence:
  - ref: wiki/sources/2026-04-15.md
    at: 2026-04-15T00:00:00Z
  - ref: wiki/sources/2026-04-20.md
    at: 2026-04-20T00:00:00Z
pending_evidence_count: 2
---
# Recency-aware RAG
%% begin:current-understanding %%
Initial framing.
%% end:current-understanding %%
`,
    );
    await store.upsert([
      { doc_id: 'wiki/sources/2026-04-15.md', chunk_index: 0, chunk_hash: 'h1', text: 'cross encoder reranking helps' },
    ]);

    const llm = fakeLLM({
      primary: 'Two-stage retrieval pairs a bi-encoder with a [[Cross Encoder]] reranker [1].',
      contradictions: [],
      new_sources: ['wiki/sources/2026-04-15.md'],
    });

    const result = await refreshTopic({ vault, llm, store, config }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });

    expect(result.pendingCleared).toBe(2);
    expect(result.neighborsCascaded).toBe(1);

    // Topic note: pending_evidence cleared.
    const { data: topicFm } = parseNote(await vault.read(topicPath));
    expect(topicFm.pending_evidence_count).toBe(0);
    expect((topicFm.pending_evidence as unknown[])).toEqual([]);

    // Neighbor: marked dirty with this topic as the ref.
    const { data: neighborFm } = parseNote(await vault.read('wiki/concepts/cross-encoder.md'));
    expect(neighborFm.pending_evidence_count).toBe(1);
    const pending = neighborFm.pending_evidence as { ref: string; reason: string }[];
    expect(pending[0].ref).toBe(topicPath);
    expect(pending[0].reason).toBe('cascade-from-refresh');
  });

  it('Phase 1: cascades to a neighbor resolved under a non-default vault layout', async () => {
    const customConfig = KarpathyConfigSchema.parse({
      vaultPath: '/tmp',
      layout: { wiki: 'Curated/wiki' },
    });
    const topicPath = 'Curated/wiki/topics/recency-aware-rag.md';
    await vault.ensureFolder('Curated/wiki/concepts');
    await vault.create(
      'Curated/wiki/concepts/cross-encoder.md',
      `---
id: c3
type: concept
title: Cross Encoder
status: active
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Cross Encoder
`,
    );
    await vault.create(
      topicPath,
      `---
id: t6
type: topic
title: Recency-aware RAG
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
pending_evidence:
  - ref: wiki/sources/2026-04-15.md
    at: 2026-04-15T00:00:00Z
pending_evidence_count: 1
---
# Recency-aware RAG
%% begin:current-understanding %%
Initial framing.
%% end:current-understanding %%
`,
    );
    await store.upsert([
      { doc_id: 'wiki/sources/2026-04-15.md', chunk_index: 0, chunk_hash: 'h1', text: 'cross encoder reranking helps' },
    ]);

    const llm = fakeLLM({
      primary: 'Two-stage retrieval pairs a bi-encoder with a [[Cross Encoder]] reranker [1].',
      contradictions: [],
      new_sources: ['wiki/sources/2026-04-15.md'],
    });

    const result = await refreshTopic({ vault, llm, store, config: customConfig }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });

    expect(result.neighborsCascaded).toBe(1);
    const { data: neighborFm } = parseNote(await vault.read('Curated/wiki/concepts/cross-encoder.md'));
    expect(neighborFm.pending_evidence_count).toBe(1);
  });

  it('Phase 1: cascadeDepth=0 disables the neighbor cascade', async () => {
    const topicPath = 'wiki/topics/x2.md';
    await vault.ensureFolder('wiki/concepts');
    await vault.create(
      'wiki/concepts/foo.md',
      `---
id: c2
type: concept
title: Foo
status: active
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Foo
`,
    );
    await vault.create(
      topicPath,
      `---
id: t5
type: topic
title: X2
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
---
# X2
%% begin:current-understanding %%
old
%% end:current-understanding %%
`,
    );
    await store.upsert([
      { doc_id: 'wiki/sources/a.md', chunk_index: 0, chunk_hash: 'h', text: 'evidence' },
    ]);
    const llm = fakeLLM({
      primary: 'See [[Foo]] for details.',
      contradictions: [],
      new_sources: [],
    });

    const noCascadeConfig = KarpathyConfigSchema.parse({
      vaultPath: '/tmp',
      intelligence: { refresh: { cascadeDepth: 0 } },
    });
    const result = await refreshTopic(
      { vault, llm, store, config: noCascadeConfig },
      topicPath,
      { nowMs: Date.parse('2026-05-01T00:00:00Z') },
    );

    expect(result.neighborsCascaded).toBe(0);
    const { data: neighborFm } = parseNote(await vault.read('wiki/concepts/foo.md'));
    expect(neighborFm.pending_evidence_count ?? 0).toBe(0);
  });

  it('still bumps last_verified when no chunks retrieved', async () => {
    const topicPath = 'wiki/topics/empty.md';
    await vault.create(
      topicPath,
      `---
id: t3
type: topic
title: Empty
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
last_verified: 2026-04-01T00:00:00Z
stability: 60
---
# Empty
`,
    );
    const llm = fakeLLM({ primary: '', contradictions: [], new_sources: [] });
    const result = await refreshTopic({ vault, llm, store, config }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });
    expect(result.retrievedCount).toBe(0);
    expect(result.lastVerified.startsWith('2026-05-01')).toBe(true);
  });

  describe('generalized region dispatch (B2b)', () => {
    it('decision: reads outcome as primary and context as secondary, and rewrites outcome', async () => {
      const decisionPath = 'wiki/decisions/adopt-litellm.md';
      await vault.ensureFolder('wiki/decisions');
      await vault.create(
        decisionPath,
        `---
id: d1
type: decision
title: Adopt LiteLLM proxy
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
stability: 30
half_life_domain: decisions
---
# Adopt LiteLLM proxy

## Context
%% begin:context %%
Needed multi-provider fallback.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sessions/a.md', chunk_index: 0, chunk_hash: 'h1', text: 'LiteLLM proxy shipped and is routing traffic in production' },
      ]);

      const llm = fakeLLM({
        primary: 'The LiteLLM proxy shipped and now routes all traffic in production [1].',
        contradictions: [],
        new_sources: ['wiki/sessions/a.md'],
      });

      const result = await refreshTopic({ vault, llm, store, config }, decisionPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      expect(result.retrievedCount).toBe(1);
      const { body } = parseNote(await vault.read(decisionPath));
      expect(body).toContain('The LiteLLM proxy shipped');
      expect(body).toContain('Needed multi-provider fallback.'); // context untouched (no secondary in response)
    });

    it('project: reads overview as primary and rewrites it', async () => {
      const hubPath = 'wiki/projects/second-brain/_index.md';
      await vault.ensureFolder('wiki/projects/second-brain');
      await vault.create(
        hubPath,
        `---
id: p1
type: project
title: Second Brain
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
stability: 30
---
# Second Brain

## Overview
%% begin:overview %%
Pending enrichment.
%% end:overview %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sessions/b.md', chunk_index: 0, chunk_hash: 'h2', text: 'Second Brain is a local-first knowledge system built on an Obsidian vault' },
      ]);

      const llm = fakeLLM({
        primary: 'Second Brain is a local-first knowledge system built on an Obsidian vault [1].',
        contradictions: [],
        new_sources: ['wiki/sessions/b.md'],
      });

      await refreshTopic({ vault, llm, store, config }, hubPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      const { body } = parseNote(await vault.read(hubPath));
      expect(body).toContain('local-first knowledge system built on an Obsidian vault');
      expect(body).not.toContain('Pending enrichment.');
    });

    it('an unmapped type (e.g. project_spec) bumps last_verified and clears pending_evidence without touching the body or calling the LLM', async () => {
      const specPath = 'wiki/projects/second-brain/technical.md';
      await vault.ensureFolder('wiki/projects/second-brain');
      await vault.create(
        specPath,
        `---
id: s1
type: project_spec
title: Second Brain technical
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
pending_evidence:
  - ref: wiki/sources/x.md
    at: 2026-04-01T00:00:00Z
pending_evidence_count: 1
---
# Second Brain technical
%% begin:content %%
Some agent-authored content.
%% end:content %%
`,
      );

      let called = false;
      const llm: LLMClient = {
        async complete() { called = true; return ''; },
        async extractStructured() { called = true; throw new Error('should not be called'); },
      };

      const result = await refreshTopic({ vault, llm, store, config }, specPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      expect(called).toBe(false);
      expect(result.retrievedCount).toBe(0);
      expect(result.pendingCleared).toBe(1);

      const { data, body } = parseNote(await vault.read(specPath));
      expect(body).toContain('Some agent-authored content.');
      expect(data.pending_evidence_count).toBe(0);
      expect(data.last_verified).toBeDefined();
    });

    it('G4: renders resolved neighbors into related-concepts for a topic note', async () => {
      const topicPath = 'wiki/topics/recency-aware-rag.md';
      await vault.ensureFolder('wiki/concepts');
      await vault.create(
        'wiki/concepts/cross-encoder.md',
        `---
id: c1
type: concept
title: Cross Encoder
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Cross Encoder
`,
      );
      await vault.create(
        topicPath,
        `---
id: t7
type: topic
title: Recency-aware RAG
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
---
# Recency-aware RAG
%% begin:current-understanding %%
Initial framing.
%% end:current-understanding %%

## Connected Concepts
%% begin:related-concepts %%
%% end:related-concepts %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sources/a.md', chunk_index: 0, chunk_hash: 'h1', text: 'cross encoder reranking helps' },
      ]);

      const llm = fakeLLM({
        primary: 'Two-stage retrieval pairs a bi-encoder with a [[Cross Encoder]] reranker [1].',
        contradictions: [],
        new_sources: ['wiki/sources/a.md'],
      });

      await refreshTopic({ vault, llm, store, config }, topicPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      const { body, data } = parseNote(await vault.read(topicPath));
      expect(body).toContain('%% begin:related-concepts %%\n- [[wiki/concepts/cross-encoder]]\n%% end:related-concepts %%');
      expect(data.protected_regions as string[]).toContain('related-concepts');
    });

    it('G4: writes the "no connected concepts" sentinel when zero neighbors resolve', async () => {
      const topicPath = 'wiki/topics/isolated.md';
      await vault.create(
        topicPath,
        `---
id: t8
type: topic
title: Isolated Topic
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
---
# Isolated Topic
%% begin:current-understanding %%
old
%% end:current-understanding %%

%% begin:related-concepts %%
%% end:related-concepts %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sources/b.md', chunk_index: 0, chunk_hash: 'h2', text: 'unrelated evidence with no wikilinks' },
      ]);

      const llm = fakeLLM({
        primary: 'A self-contained rewrite with no links to any other note [1].',
        contradictions: [],
        new_sources: [],
      });

      await refreshTopic({ vault, llm, store, config }, topicPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      const { body } = parseNote(await vault.read(topicPath));
      expect(body).toContain('_No connected concepts identified in the current synthesis._');
    });
  });

  describe('synthesis failure', () => {
    async function setUpTopicWithEvidence(topicPath: string) {
      await vault.create(
        topicPath,
        `---
id: t-synth
type: topic
title: Synthesis Failure Topic
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
---
# Synthesis Failure Topic
%% begin:current-understanding %%
old understanding
%% end:current-understanding %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sessions/s.md', chunk_index: 0, chunk_hash: 'h', text: 'some new evidence', metadata: { type: 'session_summary' } },
      ]);
    }

    it('rejects with the original TransientLLMError when the synthesis call fails transiently (identity-preserving)', async () => {
      const topicPath = 'wiki/topics/synth-transient.md';
      await setUpTopicWithEvidence(topicPath);

      const transientError = new TransientLLMError('VPN down');
      const llm: LLMClient = {
        async complete() { throw transientError; },
        async extractStructured() { throw transientError; },
      };

      let caught: unknown;
      try {
        await refreshTopic({ vault, llm, store, config }, topicPath, {
          nowMs: Date.parse('2026-05-01T00:00:00Z'),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(transientError);
      expect(caught).toBeInstanceOf(TransientLLMError);

      // The note must be left unmodified — refreshTopic bails before writing.
      const { data } = parseNote(await vault.read(topicPath));
      expect(data.last_verified).toBeUndefined();
    });

    it('wraps a plain Error with the existing message (unchanged behavior)', async () => {
      const topicPath = 'wiki/topics/synth-plain.md';
      await setUpTopicWithEvidence(topicPath);

      const llm: LLMClient = {
        async complete() { throw new Error('model exploded'); },
        async extractStructured() { throw new Error('model exploded'); },
      };

      let caught: unknown;
      try {
        await refreshTopic({ vault, llm, store, config }, topicPath, {
          nowMs: Date.parse('2026-05-01T00:00:00Z'),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TransientLLMError);
      expect((caught as Error).message).toBe(`topic synthesis failed for ${topicPath}: model exploded`);
    });
  });
});

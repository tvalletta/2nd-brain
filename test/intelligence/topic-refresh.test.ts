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

interface FakeResponse {
  current_understanding: string;
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
      current_understanding:
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
      current_understanding: 'updated with caveats',
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
      current_understanding: 'Two-stage retrieval pairs a bi-encoder with a [[Cross Encoder]] reranker [1].',
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
      current_understanding: 'See [[Foo]] for details.',
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
    const llm = fakeLLM({ current_understanding: '', contradictions: [], new_sources: [] });
    const result = await refreshTopic({ vault, llm, store, config }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });
    expect(result.retrievedCount).toBe(0);
    expect(result.lastVerified.startsWith('2026-05-01')).toBe(true);
  });
});

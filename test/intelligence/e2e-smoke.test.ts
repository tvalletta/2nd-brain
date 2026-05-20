// E2E smoke test wiring the intelligence pipeline together end-to-end:
//   1. Index two notes (embedding-index handler)
//   2. Search → expect related notes
//   3. Run weekly digest → expect a digest file
//   4. Run decay scan → expect refresh enqueued for stale note
//   5. Rebuild vault index → expect new index.md
//
// All offline (deterministic embedding provider, fake LLM).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { embeddingIndexHandler } from '../../src/jobs/handlers/embedding-index.js';
import { digestWeeklyHandler } from '../../src/jobs/handlers/digest-weekly.js';
import { decayScanHandler } from '../../src/jobs/handlers/decay-scan.js';
import { rebuildVaultArtifactsHandler } from '../../src/jobs/handlers/rebuild-vault-artifacts.js';
import { openStoreFromConfig } from '../../src/embeddings/factory.js';
import { retrieve } from '../../src/intelligence/retrieval.js';
import type { Job, JobContext, JobCreateInput } from '../../src/jobs/types.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function fakeLLM(): LLMClient {
  return {
    async complete() {
      return 'fake summary';
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      // Try to satisfy the most common shapes seen by handlers in this test.
      return schema.parse({
        label: 'Cluster',
        summary: 'Cluster summary',
        current_understanding: 'updated',
        contradictions: [],
        new_sources: [],
      });
    },
  };
}

function makeJob(type: Job['type'], targetPath?: string, payload: Record<string, unknown> = {}): Job {
  return {
    id: `${type}-${Math.random()}`,
    type,
    status: 'running',
    priority: 50,
    payload,
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
    targetPath,
  };
}

describe('intelligence pipeline — E2E smoke', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-e2e-'));
    vault = createFsAdapter(dir);
    enqueued = [];
    await vault.ensureFolder('wiki/concepts');
    await vault.ensureFolder('wiki/sessions');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (i) => {
        enqueued.push(i);
        return {
          ...i,
          id: 'q',
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: 0,
          priority: i.priority ?? 50,
          payload: i.payload ?? {},
          trigger: i.trigger ?? 'cascade',
        } as Job;
      },
      llm: fakeLLM(),
      config,
    };
  }

  it('runs ingest → embed → search → digest → decay-scan end-to-end', async () => {
    // 1. Seed two concept notes + several session notes about FSRS.
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
---
# FSRS

FSRS is a spaced repetition scheduler with stability and difficulty parameters
that govern retrievability.`,
    );
    await vault.create(
      'wiki/concepts/raptor.md',
      `---
id: raptor
type: concept
title: RAPTOR
created_at: 2026-04-15T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
last_verified: 2026-04-15T00:00:00Z
stability: 90
half_life_domain: ai-research
---
RAPTOR is a hierarchical retrieval algorithm using clustering and recursive summarization.`,
    );
    for (let i = 0; i < 5; i++) {
      await vault.create(
        `wiki/sessions/fsrs-${i}.md`,
        `---
id: s${i}
type: session_summary
title: Session ${i}
created_at: 2026-05-01T00:00:00Z
updated_at: 2026-05-01T00:00:00Z
session_id: s${i}
---
discussion of fsrs spaced repetition stability difficulty algorithm`,
      );
    }

    // 2. Index each note.
    const c = ctx();
    const allPaths = [
      'wiki/concepts/fsrs.md',
      'wiki/concepts/raptor.md',
      ...Array.from({ length: 5 }, (_, i) => `wiki/sessions/fsrs-${i}.md`),
    ];
    for (const p of allPaths) {
      await embeddingIndexHandler.execute(makeJob('embedding-index', p), c);
    }

    // 3. Verify retrieval works.
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    const store = openStoreFromConfig(config, dir);
    try {
      const hits = await retrieve({ store, config }, 'fsrs spaced repetition', { topK: 3 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].doc_id).toMatch(/fsrs/);

      // 4. Run weekly digest.
      await digestWeeklyHandler.execute(makeJob('digest-weekly'), c);
      const digestFiles = await vault.listMarkdownFiles('wiki/digests');
      const non_index = digestFiles.filter((f) => !f.endsWith('/_index.md'));
      expect(non_index.length).toBeGreaterThan(0);

      // 5. Run decay scan — FSRS is stale (last_verified 2025-09-01, S=30).
      await decayScanHandler.execute(makeJob('decay-scan'), c);
      expect(enqueued.find((e) => e.type === 'topic-refresh' && e.targetPath?.includes('fsrs'))).toBeDefined();

      // 6. Rebuild vault root index and verify both concepts appear.
      await rebuildVaultArtifactsHandler.execute(makeJob('rebuild-vault-artifacts'), c);
      const index = await vault.read('index.md');
      expect(index).toContain('FSRS');
      expect(index).toContain('RAPTOR');

      // 7. log.md should contain at least the digest entry.
      const log = await vault.read('log.md');
      expect(log).toContain('digest:weekly');
    } finally {
      store.close();
    }
  });
});

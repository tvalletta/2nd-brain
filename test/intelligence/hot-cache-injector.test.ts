import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { injectHotCache } from '../../src/intelligence/hot-cache-injector.js';
import { writeResearchQueue } from '../../src/maintenance/research-queue.js';

describe('hot-cache injector', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-inject-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes empty-state messages when no digest and no queue', async () => {
    const hotCache = createHotCacheManager(join(dir, 'CLAUDE.md'));
    const result = await injectHotCache(vault, hotCache);
    expect(result.digestPath).toBeNull();
    expect(result.topicsWritten).toBe(0);
    expect(result.pendingWritten).toBe(0);
    const claude = await vault.read('CLAUDE.md');
    expect(claude).toContain('No weekly digest yet');
    expect(claude).toContain('No pending research candidates');
  });

  it('pins clusters from the most recent digest', async () => {
    await vault.ensureFolder('wiki/digests');
    const olderDigest = `---
type: index
title: Old
---

# Hot topics — 2026-W18

## Old cluster

*4 chunks · 30% share · strong signal*

old summary.
`;
    const newerDigest = `---
type: index
title: New
---

# Hot topics — 2026-W19

## FSRS / spaced repetition

*5 chunks · 25.0% share · strong signal*

About FSRS.

## Recency RAG

*3 chunks · 15.0% share · weak signal*

About recency.
`;
    await vault.create('wiki/digests/2026-W18.md', olderDigest);
    await vault.create('wiki/digests/2026-W19.md', newerDigest);

    const hotCache = createHotCacheManager(join(dir, 'CLAUDE.md'));
    const result = await injectHotCache(vault, hotCache);
    expect(result.digestPath).toBe('wiki/digests/2026-W19.md');
    expect(result.topicsWritten).toBe(2);

    const claude = await vault.read('CLAUDE.md');
    expect(claude).toContain('FSRS / spaced repetition');
    expect(claude).toContain('Recency RAG');
    expect(claude).not.toContain('Old cluster');
    expect(claude).toContain('2026-W19');
    expect(claude).toContain('strong signal');
  });

  it('pins top pending research candidates', async () => {
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.85, reason: '6 mentions', suggested: 'medium', status: 'pending', addedAt: '2026-05-07T00:00:00Z' },
        { slug: 'raptor', title: 'RAPTOR', score: 0.71, reason: '3 mentions', suggested: 'light', status: 'pending', addedAt: '2026-05-07T00:00:00Z' },
        // Already-decided ones must not appear in pending list:
        { slug: 'ddg', title: 'DDG', score: 0.5, reason: 'completed', suggested: 'light', decision: 'light', status: 'completed', addedAt: '2026-04-01T00:00:00Z', completedAt: '2026-05-01T00:00:00Z', completedDepth: 'light' },
      ],
    });

    const hotCache = createHotCacheManager(join(dir, 'CLAUDE.md'));
    const result = await injectHotCache(vault, hotCache);
    expect(result.pendingWritten).toBe(2);

    const claude = await vault.read('CLAUDE.md');
    // The queue persists slug; title is rendered from the parsed slug.
    expect(claude.toLowerCase()).toContain('fsrs');
    expect(claude.toLowerCase()).toContain('raptor');
    expect(claude.toLowerCase()).not.toContain('ddg');
    expect(claude).toContain('approve_research');
  });

  it('keeps the existing CLAUDE.md content outside the regions intact', async () => {
    await vault.create(
      'CLAUDE.md',
      '# Project README\n\n%% begin:hot-topics %%\nold content\n%% end:hot-topics %%\n\n## Manual notes\n\nUser stuff.\n',
    );
    const hotCache = createHotCacheManager(join(dir, 'CLAUDE.md'));
    await injectHotCache(vault, hotCache);
    const claude = await vault.read('CLAUDE.md');
    expect(claude).toContain('# Project README');
    expect(claude).toContain('## Manual notes');
    expect(claude).toContain('User stuff');
    expect(claude).not.toContain('old content');
  });
});

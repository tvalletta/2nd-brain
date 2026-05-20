import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHotCacheManager } from '../../src/session/hot-cache.js';

const SAMPLE_CLAUDE_MD = `# Karpathy Second Memory

## Active Context
%% begin:active-context %%
Current project: Karpathy
%% end:active-context %%

## Recent Sessions
%% begin:recent-sessions %%
- 2026-04-10: Did some work ([[session-2026-04-10-001]])
%% end:recent-sessions %%

## Key Entities
%% begin:key-entities %%
[[Alice]] — Product lead
%% end:key-entities %%

## Quick Links
%% begin:quick-links %%
[[indexes/wiki-index]]
%% end:quick-links %%
`;

describe('HotCacheManager', () => {
  let tempDir: string;
  let claudeMdPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-cache-'));
    claudeMdPath = join(tempDir, 'CLAUDE.md');
    await writeFile(claudeMdPath, SAMPLE_CLAUDE_MD, 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads existing CLAUDE.md', async () => {
    const cache = createHotCacheManager(claudeMdPath);
    const content = await cache.read();
    expect(content).toContain('# Karpathy Second Memory');
  });

  it('gets a protected region', async () => {
    const cache = createHotCacheManager(claudeMdPath);
    const context = await cache.getRegion('active-context');
    expect(context).toContain('Current project: Karpathy');
  });

  it('updates a protected region', async () => {
    const cache = createHotCacheManager(claudeMdPath);
    await cache.updateRegion('active-context', 'Current project: Second Memory');
    await cache.flush();

    const cache2 = createHotCacheManager(claudeMdPath);
    const updated = await cache2.getRegion('active-context');
    expect(updated).toContain('Second Memory');
  });

  it('appends session to recent-sessions (LIFO, capped)', async () => {
    const cache = createHotCacheManager(claudeMdPath);
    await cache.appendSession({
      date: '2026-04-11',
      summary: 'Built job system',
      noteLink: 'session-2026-04-11-001',
    });
    await cache.flush();

    const cache2 = createHotCacheManager(claudeMdPath);
    const sessions = await cache2.getRegion('recent-sessions');
    expect(sessions).toContain('2026-04-11: Built job system');
    // New entry should be first
    expect(sessions!.indexOf('2026-04-11')).toBeLessThan(sessions!.indexOf('2026-04-10'));
  });

  it('adds entity without duplicates', async () => {
    const cache = createHotCacheManager(claudeMdPath);
    await cache.addEntity({ name: 'Alice', link: 'Alice', description: 'Product lead' });
    await cache.addEntity({ name: 'Bob', link: 'Bob', description: 'Engineer' });
    await cache.flush();

    const cache2 = createHotCacheManager(claudeMdPath);
    const entities = await cache2.getRegion('key-entities');
    // Alice was already there — should not be duplicated
    expect((entities!.match(/Alice/g) ?? []).length).toBe(1);
    expect(entities).toContain('[[Bob]]');
  });

  it('toContext returns full file content', async () => {
    const cache = createHotCacheManager(claudeMdPath);
    const ctx = await cache.toContext();
    expect(ctx).toContain('# Karpathy Second Memory');
    expect(ctx).toContain('begin:active-context');
  });
});

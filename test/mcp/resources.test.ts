import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { handleResourceRead, RESOURCE_DEFINITIONS } from '../../src/mcp/resources.js';
import type { MCPContext } from '../../src/mcp/context.js';

describe('MCP Resources', () => {
  let tempDir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-res-'));
    const vault = createFsAdapter(tempDir);

    await mkdir(join(tempDir, 'wiki'), { recursive: true });
    await writeFile(join(tempDir, 'CLAUDE.md'), '# Hot Cache\nRecent work here.', 'utf-8');
    await writeFile(join(tempDir, 'wiki/_index.md'), '# Wiki Index\n- [[alice]]', 'utf-8');

    ctx = {
      config: {
        vaultPath: tempDir,
        projectRoot: tempDir,
        hotCachePath: 'CLAUDE.md',
        stateDir: '.karpathy/state',
        lockDir: '.karpathy/locks',
        logDir: '.karpathy/logs',
        llm: { provider: 'bedrock' as const, region: 'us-west-2', model: 'test', maxTokens: 100 },
        ingest: { watchEnabled: false, watchPaths: [], debounceMs: 0 },
        maintenance: { autoBacklinks: false, autoIndexes: false, reviewEnabled: false },
      },
      vault,
      sessionLog: createSessionLogManager(vault),
      hotCache: createHotCacheManager(join(tempDir, 'CLAUDE.md')),
      usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
      runDeterministicJobs: async () => 0,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists all resources', () => {
    expect(RESOURCE_DEFINITIONS).toHaveLength(7);
    const uris = RESOURCE_DEFINITIONS.map((r) => r.uri);
    expect(uris).toContain('vault://hot-cache');
    expect(uris).toContain('vault://index');
    expect(uris).toContain('vault://entities');
    expect(uris).toContain('vault://projects');
    expect(uris).toContain('vault://decisions');
    expect(uris).toContain('vault://review-queue');
    expect(uris).toContain('vault://recent-changes');
  });

  it('reads hot-cache resource', async () => {
    const result = await handleResourceRead({ uri: 'vault://hot-cache' }, ctx);
    expect(result.contents[0].text).toContain('Hot Cache');
  });

  it('reads index resource', async () => {
    const result = await handleResourceRead({ uri: 'vault://index' }, ctx);
    expect(result.contents[0].text).toContain('Wiki Index');
  });

  it('reads entities resource with frontmatter', async () => {
    await mkdir(join(tempDir, 'wiki/entities'), { recursive: true });
    await writeFile(
      join(tempDir, 'wiki/entities/alice.md'),
      '---\ntitle: Alice Smith\nkind: person\nstatus: active\n---\n# Alice Smith',
      'utf-8',
    );
    const result = await handleResourceRead({ uri: 'vault://entities' }, ctx);
    expect(result.contents[0].text).toContain('Alice Smith');
    expect(result.contents[0].text).toContain('kind: person');
  });

  it('reads projects resource', async () => {
    await mkdir(join(tempDir, 'wiki/projects'), { recursive: true });
    await writeFile(
      join(tempDir, 'wiki/projects/phoenix.md'),
      '---\ntitle: Phoenix\nstatus: active\n---\n# Phoenix',
      'utf-8',
    );
    const result = await handleResourceRead({ uri: 'vault://projects' }, ctx);
    expect(result.contents[0].text).toContain('Phoenix');
  });

  it('reads decisions resource', async () => {
    await mkdir(join(tempDir, 'wiki/decisions'), { recursive: true });
    await writeFile(
      join(tempDir, 'wiki/decisions/use-postgres.md'),
      '---\ntitle: Use PostgreSQL\nstatus: decided\ndate: 2026-01-15\n---\n# Use PostgreSQL',
      'utf-8',
    );
    const result = await handleResourceRead({ uri: 'vault://decisions' }, ctx);
    expect(result.contents[0].text).toContain('Use PostgreSQL');
    expect(result.contents[0].text).toContain('status: decided');
  });

  it('reads review-queue resource', async () => {
    await mkdir(join(tempDir, 'review'), { recursive: true });
    await writeFile(
      join(tempDir, 'review/ambiguous-foo.md'),
      '---\ntitle: Ambiguous Foo\nconflict_type: ambiguous_entity\nresolution_state: open\n---\n# Ambiguous Foo',
      'utf-8',
    );
    const result = await handleResourceRead({ uri: 'vault://review-queue' }, ctx);
    expect(result.contents[0].text).toContain('Ambiguous Foo');
    expect(result.contents[0].text).toContain('resolution_state: open');
  });

  it('reads recent-changes resource', async () => {
    await mkdir(join(tempDir, 'wiki/entities'), { recursive: true });
    await writeFile(
      join(tempDir, 'wiki/entities/bob.md'),
      '---\ntitle: Bob\nupdated_at: "2026-04-14T10:00:00Z"\n---\n# Bob',
      'utf-8',
    );
    const result = await handleResourceRead({ uri: 'vault://recent-changes' }, ctx);
    expect(result.contents[0].text).toContain('bob');
    expect(result.contents[0].text).toContain('2026-04-14');
  });

  it('handles empty folders gracefully', async () => {
    const result = await handleResourceRead({ uri: 'vault://entities' }, ctx);
    expect(result.contents[0].text).toContain('No files found');
  });

  it('handles unknown resource URI', async () => {
    const result = await handleResourceRead({ uri: 'vault://unknown' }, ctx);
    expect(result.contents[0].text).toContain('Unknown resource');
  });
});

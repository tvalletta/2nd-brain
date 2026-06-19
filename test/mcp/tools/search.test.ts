import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../../src/session/session-log.js';
import { createHotCacheManager } from '../../../src/session/hot-cache.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { handle as handleSearch, definition } from '../../../src/mcp/tools/search.js';
import type { MCPContext } from '../../../src/mcp/context.js';

function makeCtx(tempDir: string): MCPContext {
  const vault = createFsAdapter(tempDir);
  const config = KarpathyConfigSchema.parse({
    vaultPath: tempDir,
    projectRoot: tempDir,
    embeddings: { provider: 'deterministic' },
  });
  return {
    config,
    vault,
    sessionLog: createSessionLogManager(vault, config.layout),
    hotCache: createHotCacheManager(join(tempDir, 'CLAUDE.md')),
    usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
    enqueueJob: async () => undefined,
    runDeterministicJobs: async () => 0,
  };
}

async function seedNote(dir: string, path: string, fm: Record<string, unknown>, body: string): Promise<void> {
  const fullDir = join(dir, path.split('/').slice(0, -1).join('/'));
  await mkdir(fullDir, { recursive: true });
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  await writeFile(join(dir, path), `---\n${yaml}\n---\n${body}`, 'utf-8');
}

describe('search MCP tool', () => {
  let dir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-mcp-search-'));
    ctx = makeCtx(dir);
    for (const f of ['wiki/concepts', 'wiki/projects', 'wiki/sessions', 'wiki/_system']) {
      await mkdir(join(dir, f), { recursive: true });
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes a definition with the expected shape', () => {
    expect(definition.name).toBe('search');
    expect(definition.description).toMatch(/Hybrid keyword/);
    expect(definition.inputSchema.properties.query).toBeDefined();
    expect(definition.inputSchema.properties.path).toBeDefined();
  });

  it('runs a text query end-to-end and returns a hybrid response', async () => {
    await seedNote(
      dir,
      'wiki/concepts/fsrs.md',
      { id: 'c1', type: 'concept', title: 'FSRS', updated_at: new Date().toISOString() },
      'spaced repetition retention forecasting algorithm',
    );
    await seedNote(
      dir,
      'wiki/concepts/raptor.md',
      { id: 'c2', type: 'concept', title: 'RAPTOR', updated_at: new Date().toISOString() },
      'recursive abstraction processing tree organized retrieval',
    );

    // Populate FTS via the unified store directly (faster than running the job).
    const { openHybridStoreFromConfig } = await import('../../../src/search/factory.js');
    const store = openHybridStoreFromConfig(ctx.config, dir);
    try {
      await store.syncFTS(['wiki']);
    } finally {
      store.close();
    }

    const result = await handleSearch({ query: 'spaced repetition' }, ctx);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.search_mode).toBe('hybrid');
    expect(Array.isArray(parsed.results)).toBe(true);
    const ids = parsed.results.map((r: { path: string }) => r.path);
    expect(ids).toContain('wiki/concepts/fsrs.md');
  });

  it('errors when neither query nor path is supplied', async () => {
    const result = await handleSearch({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Provide either/);
  });

  it('errors when scope=project but projectSlug is missing', async () => {
    const result = await handleSearch({ query: 'x', scope: 'project' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/projectSlug is required/);
  });

  it('errors when path does not exist', async () => {
    const result = await handleSearch({ path: 'wiki/missing.md' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Note not found/);
  });

  it('uses the path-anchor flow and excludes the anchor doc from results', async () => {
    await seedNote(
      dir,
      'wiki/concepts/fsrs.md',
      { id: 'c1', type: 'concept', title: 'FSRS', tldr: 'spaced repetition stability', updated_at: new Date().toISOString() },
      'spaced repetition retention forecasting',
    );
    await seedNote(
      dir,
      'wiki/concepts/sm2.md',
      { id: 'c2', type: 'concept', title: 'SM-2', updated_at: new Date().toISOString() },
      'spaced repetition stability classic algorithm',
    );

    const { openHybridStoreFromConfig } = await import('../../../src/search/factory.js');
    const store = openHybridStoreFromConfig(ctx.config, dir);
    try {
      await store.syncFTS(['wiki']);
    } finally {
      store.close();
    }

    const result = await handleSearch({ path: 'wiki/concepts/fsrs.md' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    const ids = parsed.results.map((r: { path: string }) => r.path);
    expect(ids).not.toContain('wiki/concepts/fsrs.md');
  });

  it('detail=full returns body and frontmatter', async () => {
    await seedNote(
      dir,
      'wiki/concepts/fsrs.md',
      { id: 'c1', type: 'concept', title: 'FSRS', updated_at: new Date().toISOString() },
      'spaced-repetition body text here',
    );
    const { openHybridStoreFromConfig } = await import('../../../src/search/factory.js');
    const store = openHybridStoreFromConfig(ctx.config, dir);
    try {
      await store.syncFTS(['wiki']);
    } finally {
      store.close();
    }

    const result = await handleSearch({ query: 'spaced-repetition', detail: 'full' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results[0].body).toMatch(/spaced-repetition body text/);
    expect(parsed.results[0].frontmatter.title).toBe('FSRS');
  });

  it('zero results returns a hint instead of an error', async () => {
    const result = await handleSearch({ query: 'totally-unindexed-zzz' }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toEqual([]);
    expect(parsed.hint).toMatch(/populate-fts|broaden/);
  });

  it('returns keyword-only mode with degradation_note when Ollama provider is down', async () => {
    // Build a ctx whose config declares provider=ollama so the hybrid store
    // will probe availability before fanning out semantic queries.
    const vault = createFsAdapter(dir);
    const ollamaConfig = KarpathyConfigSchema.parse({
      vaultPath: dir,
      projectRoot: dir,
      // Point at an unreachable address so isOllamaAvailable() returns false.
      embeddings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 },
    });
    const ollamaCtx: MCPContext = {
      ...ctx,
      config: ollamaConfig,
      vault,
    };

    await seedNote(
      dir,
      'wiki/concepts/decay.md',
      { id: 'c1', type: 'concept', title: 'Decay', updated_at: new Date().toISOString() },
      'exponential decay retrievability stability',
    );

    // Populate FTS so keyword results are available.
    const { openHybridStoreFromConfig } = await import('../../../src/search/factory.js');
    const store = openHybridStoreFromConfig(ollamaConfig, dir);
    try {
      await store.syncFTS(['wiki']);
    } finally {
      store.close();
    }

    const result = await handleSearch({ query: 'decay retrievability' }, ollamaCtx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // search_mode must be keyword-only since Ollama is unreachable.
    expect(parsed.search_mode).toBe('keyword-only');
    expect(parsed.degradation_note).toMatch(/Ollama/i);
    // FTS results still come through — keyword search is fully functional.
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
  });
});

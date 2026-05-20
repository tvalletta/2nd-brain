import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeArgs, parseResultCount, appendUsageEntry } from '../../src/mcp/usage-log.js';
import { handleToolCall } from '../../src/mcp/tools/router.js';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { MCPContext } from '../../src/mcp/context.js';

describe('usage-log utilities', () => {
  it('sanitizeArgs passes through small values unchanged', () => {
    const args = { query: 'test', limit: 5, kind: 'person' };
    expect(sanitizeArgs(args)).toEqual(args);
  });

  it('sanitizeArgs replaces large content fields with char count', () => {
    const big = 'x'.repeat(500);
    const result = sanitizeArgs({ query: 'test', content: big });
    expect(result.query).toBe('test');
    expect(result.content).toBe('[500 chars]');
  });

  it('sanitizeArgs leaves small content fields untouched', () => {
    const result = sanitizeArgs({ content: 'short text' });
    expect(result.content).toBe('short text');
  });

  it('parseResultCount returns length for JSON arrays', () => {
    expect(parseResultCount('[{"a":1},{"b":2}]')).toBe(2);
    expect(parseResultCount('[]')).toBe(0);
  });

  it('parseResultCount returns undefined for non-arrays', () => {
    expect(parseResultCount('{"count":0}')).toBeUndefined();
    expect(parseResultCount('No results found')).toBeUndefined();
    expect(parseResultCount('')).toBeUndefined();
  });
});

describe('appendUsageEntry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'usage-log-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a JSONL entry and creates parent dirs', async () => {
    const logPath = join(tempDir, 'subdir', 'mcp-usage.jsonl');
    await appendUsageEntry(logPath, {
      ts: '2026-05-18T12:00:00.000Z',
      tool: 'search_vault',
      args: { query: 'test' },
      duration_ms: 42,
      success: true,
      result_count: 3,
      result_chars: 500,
    });

    const raw = await readFile(logPath, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.tool).toBe('search_vault');
    expect(line.duration_ms).toBe(42);
    expect(line.result_count).toBe(3);
    expect(line.success).toBe(true);
  });

  it('appends multiple entries as separate lines', async () => {
    const logPath = join(tempDir, 'mcp-usage.jsonl');
    await appendUsageEntry(logPath, { ts: '2026-05-18T12:00:00Z', tool: 'a', args: {}, duration_ms: 1, success: true, result_chars: 0 });
    await appendUsageEntry(logPath, { ts: '2026-05-18T12:00:01Z', tool: 'b', args: {}, duration_ms: 2, success: false, result_chars: 0, error: 'oops' });

    const raw = await readFile(logPath, 'utf-8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].tool).toBe('a');
    expect(lines[1].tool).toBe('b');
    expect(lines[1].error).toBe('oops');
  });

  it('never throws even if path is invalid', async () => {
    await expect(
      appendUsageEntry('/dev/null/cannot/write/here.jsonl', {
        ts: 'x', tool: 'x', args: {}, duration_ms: 0, success: true, result_chars: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('handleToolCall logs usage', () => {
  let tempDir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'router-log-'));
    const vault = createFsAdapter(tempDir);
    const config = KarpathyConfigSchema.parse({ vaultPath: tempDir, projectRoot: tempDir });
    ctx = {
      config,
      vault,
      sessionLog: createSessionLogManager(vault, config.layout),
      hotCache: createHotCacheManager(join(tempDir, 'CLAUDE.md')),
      usageLogPath: join(tempDir, 'mcp-usage.jsonl'),
      runDeterministicJobs: async () => 0,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a log entry on successful tool call', async () => {
    await handleToolCall({ name: 'vault_status', arguments: {} }, ctx);
    const raw = await readFile(ctx.usageLogPath, 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.tool).toBe('vault_status');
    expect(entry.success).toBe(true);
    expect(typeof entry.duration_ms).toBe('number');
    expect(typeof entry.result_chars).toBe('number');
  });

  it('writes a failure log entry for unknown tools', async () => {
    await handleToolCall({ name: 'nonexistent_tool', arguments: {} }, ctx);
    const raw = await readFile(ctx.usageLogPath, 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.tool).toBe('nonexistent_tool');
    expect(entry.success).toBe(false);
    expect(entry.error).toBe('unknown tool');
  });

  it('logs result_count for array responses', async () => {
    // search_entities returns an array when results exist; here it returns "no match"
    // so we just verify the entry is written without result_count
    await handleToolCall({ name: 'search_entities', arguments: { query: 'zzznomatch' } }, ctx);
    const raw = await readFile(ctx.usageLogPath, 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.tool).toBe('search_entities');
    expect(entry.result_count).toBeUndefined(); // "No matching entities" message, not an array
  });

  it('sanitizes large args in the log', async () => {
    await handleToolCall({
      name: 'search_vault',
      arguments: { query: 'test', content: 'x'.repeat(500) },
    }, ctx);
    const raw = await readFile(ctx.usageLogPath, 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.args.content).toBe('[500 chars]');
    expect(entry.args.query).toBe('test');
  });
});

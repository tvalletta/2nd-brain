import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { MCPContext } from '../../src/mcp/context.js';
import { createMcpServer } from '../../src/mcp/create-server.js';
import { TOOL_DEFINITIONS } from '../../src/mcp/tools/index.js';
import { RESOURCE_DEFINITIONS } from '../../src/mcp/resources.js';

// Minimal-but-real MCPContext: same construction pattern as
// test/mcp/tools.test.ts's makeCtx, so this exercises the same config
// defaulting (including `layout`) that production code path uses.
function makeFakeCtx(tempDir: string): MCPContext {
  const vault = createFsAdapter(tempDir);
  const config = KarpathyConfigSchema.parse({ vaultPath: tempDir, projectRoot: tempDir });
  return {
    config,
    vault,
    sessionLog: createSessionLogManager(vault, config.layout),
    hotCache: createHotCacheManager(join(tempDir, config.hotCachePath)),
    usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
    enqueueJob: async () => {},
    runDeterministicJobs: async () => 0,
  };
}

describe('createMcpServer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-create-server-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a Server instance', () => {
    const ctx = makeFakeCtx(tempDir);
    const server = createMcpServer(ctx);
    expect(server).toBeInstanceOf(Server);
  });

  it('wires all four request handlers so tools/list and resources/list round-trip over an in-memory transport', async () => {
    const ctx = makeFakeCtx(tempDir);
    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const tools = await client.listTools();
      expect(tools.tools).toEqual(TOOL_DEFINITIONS);

      const resources = await client.listResources();
      expect(resources.resources).toEqual(RESOURCE_DEFINITIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

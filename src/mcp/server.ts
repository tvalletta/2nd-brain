import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMCPContext } from './context.js';
import { TOOL_DEFINITIONS } from './tools/index.js';
import { handleToolCall } from './tools/router.js';
import { RESOURCE_DEFINITIONS, handleResourceRead } from './resources.js';
import { buildInstructions } from './instructions.js';
import { scanRawDirectory } from '../ingest/scanner.js';
import { createFileWatcher } from '../ingest/watcher.js';
import { ingestFile } from '../ingest/pipeline.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('mcp-server');

// Resolve project root from this file's location so the server works
// regardless of the working directory Claude Code spawns it from.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

// Create context first so we can derive instructions from the actual runtime layout.
const ctx = await createMCPContext(projectRoot);

const server = new Server(
  { name: 'karpathy', version: '0.1.0' },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: buildInstructions(ctx.config.layout),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  handleToolCall(request.params, ctx),
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCE_DEFINITIONS,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
  handleResourceRead(request.params, ctx),
);

const transport = new StdioServerTransport();
await server.connect(transport);

log.info('Karpathy MCP server started', { vault: ctx.config.vaultPath });

// Background: scan raw/ for un-ingested files (layout-aware)
scanRawDirectory(ctx.vault, ctx.config.layout).then((result) => {
  if (result.ingested > 0) {
    log.info('Startup ingest complete', { ...result });
  }
}).catch((err) => {
  log.error('Startup ingest failed', { error: (err as Error).message });
});

// Background: watch raw/ for new files and auto-ingest
if (ctx.config.ingest.watchEnabled) {
  const { join } = await import('node:path');
  const watchPaths = ctx.config.ingest.watchPaths.map((p) => join(ctx.config.vaultPath, p));
  const watcher = await createFileWatcher(watchPaths, async (filePath) => {
    try {
      const result = await ingestFile(filePath, ctx.vault, ctx.config.layout);
      log.info('Auto-ingested new file', { rawPath: result.rawPath, summary: result.sourceSummaryPath });
    } catch (err) {
      log.error('Auto-ingest failed', { filePath, error: (err as Error).message });
    }
  });
  watcher.start();

  // Clean up watcher on server close
  server.onclose = () => {
    watcher.stop();
  };
}

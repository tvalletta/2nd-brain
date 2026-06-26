import { resolve } from 'node:path';
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
import { parseProjectRootArg } from './server-args.js';

const log = createLogger('mcp-server');

// Resolve project root. Prefer the --project-root CLI flag so the server
// always opens the correct SQLite DB regardless of which project window
// Claude Code happens to be in when it spawns this process. Falls back to
// process.cwd() for backwards compatibility with direct / hook invocations.
const projectRoot = parseProjectRootArg(process.argv.slice(2)) ?? resolve(process.cwd());

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

// Exit when the parent (Claude Code) closes the stdio pipe or sends a signal.
// Without these handlers, an active file watcher keeps the event loop alive
// indefinitely, causing orphaned processes to accumulate across sessions.
const shutdown = (reason: string) => {
  log.info('MCP server shutting down', { reason });
  process.exit(0);
};
process.stdin.on('close', () => shutdown('stdin-close'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Background: scan raw/ for un-ingested files (layout-aware)
scanRawDirectory(ctx.vault, ctx.config.layout).then((result) => {
  if (result.ingested > 0) {
    log.info('Startup ingest complete', { ...result });
  }
}).catch((err) => {
  log.error('Startup ingest failed', { error: (err as Error).message });
});

// Background: watch raw/ for new files and auto-ingest. Also enqueue
// per-file FTS sync events for any markdown change/delete inside the vault
// — keeps the keyword index live during long-running MCP sessions.
if (ctx.config.ingest.watchEnabled) {
  const { join, relative } = await import('node:path');
  const watchPaths = ctx.config.ingest.watchPaths.map((p) => join(ctx.config.vaultPath, p));

  const enqueueFtsSync = async (filePath: string, deleted = false) => {
    if (!filePath.endsWith('.md')) return;
    const rel = relative(ctx.config.vaultPath, filePath);
    if (rel.startsWith('..')) return;
    await ctx.enqueueJob({
      type: 'sync-fts-index',
      payload: deleted ? { deletedFile: rel } : { file: rel },
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: `sync-fts-index:${rel}`,
    });
  };

  const watcher = await createFileWatcher(watchPaths, {
    async onFile(filePath) {
      try {
        const result = await ingestFile(filePath, ctx.vault, ctx.config.layout);
        log.info('Auto-ingested new file', {
          rawPath: result.rawPath,
          summary: result.sourceSummaryPath,
        });
      } catch (err) {
        log.error('Auto-ingest failed', { filePath, error: (err as Error).message });
      }
      await enqueueFtsSync(filePath);
    },
    async onChange(filePath) {
      await enqueueFtsSync(filePath);
    },
    async onUnlink(filePath) {
      await enqueueFtsSync(filePath, true);
    },
  });
  watcher.start();

  // Clean up watcher on server close
  server.onclose = () => {
    watcher.stop();
  };
}

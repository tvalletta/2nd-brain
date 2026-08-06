import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMCPContext } from './context.js';
import { createMcpServer } from './create-server.js';
import { scanRawDirectory } from '../ingest/scanner.js';
import { startVaultWatcher, type VaultWatcherHandle } from './vault-watcher.js';
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

const server = createMcpServer(ctx);

const transport = new StdioServerTransport();
await server.connect(transport);

log.info('Karpathy MCP server started', { vault: ctx.config.vaultPath });

// Fix A: at most one MCP server instance watches the vault at a time. Every
// Claude Code window spawns its own server; without this lock, N concurrent
// windows each ran a redundant chokidar watcher over the same OneDrive-
// backed folders. Populated below iff this instance actually acquires the
// lock and starts a watcher; consulted by shutdown() to release the lock
// and stop the watcher together.
let watcherHandle: VaultWatcherHandle | null = null;

// Exit when the parent (Claude Code) closes the stdio pipe or sends a signal.
// Without these handlers, an active file watcher keeps the event loop alive
// indefinitely, causing orphaned processes to accumulate across sessions.
const shutdown = async (reason: string) => {
  log.info('MCP server shutting down', { reason });
  if (watcherHandle) {
    watcherHandle.stop();
    const handle = watcherHandle;
    watcherHandle = null;
    try {
      await handle.release();
    } catch (err) {
      log.warn('Failed to release watcher lock', { error: (err as Error).message });
    }
  }
  process.exit(0);
};
process.stdin.on('close', () => { void shutdown('stdin-close'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

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
//
// Fix A: gated behind the single-watcher lock (extracted into
// `startVaultWatcher`, shared with the upcoming HTTP daemon). If another
// live MCP server instance already holds it, this instance skips starting
// a watcher entirely and relies on the lock-holder plus the every-5-min
// launchd `intel tick` FTS sync — no functionality is lost, just the
// redundant watcher process.
watcherHandle = await startVaultWatcher(ctx);
if (watcherHandle) {
  // Clean up watcher + release the lock on server close. server.onclose
  // can fire independently of the stdin/signal paths; route it through
  // the same shutdown() so the watcher lock is never left held by a dead
  // process longer than necessary.
  server.onclose = () => {
    void shutdown('server-onclose');
  };
}

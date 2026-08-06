import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { resolveLockDir } from '../../src/config/defaults.js';
import { acquireWatcherLock, type WatcherLockResult } from '../../src/ingest/watcher.js';
import type { MCPContext } from '../../src/mcp/context.js';
import { startVaultWatcher } from '../../src/mcp/vault-watcher.js';

// Same MCPContext construction pattern as test/mcp/create-server.test.ts's
// makeFakeCtx — a minimal-but-real context exercising the same config
// defaulting (including `layout`) production code goes through.
function makeFakeCtx(tempDir: string, watchEnabled: boolean): MCPContext {
  const vault = createFsAdapter(tempDir);
  const config = KarpathyConfigSchema.parse({
    vaultPath: tempDir,
    projectRoot: tempDir,
    ingest: { watchEnabled },
  });
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

// Fix A (extracted, Task 3): `startVaultWatcher` centralizes the watcher
// lock-acquire + chokidar-wiring logic previously inlined in
// `src/mcp/server.ts`. These tests exercise the same three branches the
// inline block used to: watchEnabled:false, lock held by a live process,
// and the happy path — mirroring test/ingest/watcher-lock.test.ts's lock
// setup for the second case.
describe('startVaultWatcher (Task 3 extraction)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-vault-watcher-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when ingest.watchEnabled is false', async () => {
    const ctx = makeFakeCtx(tempDir, false);
    const handle = await startVaultWatcher(ctx);
    expect(handle).toBeNull();
  });

  it('returns null when the watcher lock is already held by another live process', async () => {
    const ctx = makeFakeCtx(tempDir, true);
    const lockDir = resolveLockDir(ctx.config);

    // Pre-hold the lock, same as test/ingest/watcher-lock.test.ts: this test
    // process's own PID is alive, so a second acquisition attempt must be
    // refused rather than treated as an error.
    const held: WatcherLockResult = await acquireWatcherLock(lockDir);
    expect(held.acquired).toBe(true);

    const handle = await startVaultWatcher(ctx);
    expect(handle).toBeNull();

    await held.release!();
  });

  it('returns a handle with callable stop/release when the lock is free and watching is enabled', async () => {
    const ctx = makeFakeCtx(tempDir, true);

    const handle = await startVaultWatcher(ctx);
    expect(handle).not.toBeNull();
    expect(typeof handle!.stop).toBe('function');
    expect(typeof handle!.release).toBe('function');

    handle!.stop();
    await handle!.release();
  });
});

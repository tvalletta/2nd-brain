import { join } from 'node:path';
import type { KarpathyConfig } from '../config/schema.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { SessionLogManager } from '../session/session-log.js';
import type { HotCacheManager } from '../session/hot-cache.js';
import type { JobCreateInput } from '../jobs/types.js';
import type { JobQueue } from '../jobs/queue.js';
import { loadConfig } from '../config/loader.js';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { createSessionLogManager } from '../session/session-log.js';
import { createHotCacheManager } from '../session/hot-cache.js';
import { createJobQueue } from '../jobs/queue.js';
import { createFileLock } from '../jobs/lock.js';
import { createJobRunner } from '../jobs/runner.js';
import { createHandlerRegistry } from '../jobs/handlers/index.js';
import { resolveStateDir, resolveLockDir, resolveLogDir } from '../config/defaults.js';
import { createLLMFromConfig } from '../enrichment/llm-factory.js';

/**
 * Enqueue a job and persist the queue to disk in one step.
 *
 * Fix J: `queue.enqueue()` only mutates in-memory state — without a
 * following `queue.flush()`, an enqueued job never reaches `job-queue.json`
 * and is silently lost the moment the process exits. This bit watcher-
 * triggered `sync-fts-index` jobs particularly hard: they were "enqueued"
 * every file change but dropped before the next drain ever saw them.
 * `queue.load()` first so a flush doesn't clobber jobs persisted by another
 * process (e.g. a concurrent drain) since this queue instance last loaded.
 * Exported standalone so the fix is testable without booting a full
 * `MCPContext` (which requires a real global config on disk).
 */
export async function enqueueAndPersist(queue: JobQueue, input: JobCreateInput): Promise<void> {
  await queue.load();
  await queue.enqueue(input);
  await queue.flush();
}

export interface MCPContext {
  config: KarpathyConfig;
  vault: VaultAdapter;
  sessionLog: SessionLogManager;
  hotCache: HotCacheManager;
  /** Absolute path to the JSONL usage audit log. */
  usageLogPath: string;
  /** Enqueue a job and persist the queue. */
  enqueueJob: (input: JobCreateInput) => Promise<void>;
  runDeterministicJobs: () => Promise<number>;
}

export async function createMCPContext(projectRoot?: string): Promise<MCPContext> {
  const config = await loadConfig(projectRoot);
  const vault = createFsAdapter(config.vaultPath);
  const sessionLog = createSessionLogManager(vault, config.layout);
  const hotCache = createHotCacheManager(join(config.vaultPath, config.hotCachePath));

  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queue = createJobQueue(join(stateDir, 'job-queue.json'));

  const usageLogPath = join(resolveLogDir(config), 'mcp-usage.jsonl');

  return {
    config,
    vault,
    sessionLog,
    hotCache,
    usageLogPath,
    async enqueueJob(input: JobCreateInput) {
      await enqueueAndPersist(queue, input);
    },
    async runDeterministicJobs() {
      // Lazy-init: only create heavy infrastructure (including the LLM
      // client, which can throw synchronously on a litellm misconfiguration)
      // when a job actually needs to run — not at server-startup time.
      const lock = createFileLock(lockDir);
      const handlers = createHandlerRegistry();
      const llm = createLLMFromConfig(config, stateDir);
      const runner = createJobRunner({
        queue,
        lock,
        handlers,
        vaultPath: config.vaultPath,
        projectRoot: config.projectRoot!,
        llm,
        vault,
        config,
      });
      await queue.load();
      return runner.runAll();
    },
  };
}

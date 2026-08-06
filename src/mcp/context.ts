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
 *
 * Shared-daemon fix: in the shared MCP daemon, every session and the file
 * watcher share ONE `MCPContext` and thus ONE `JobQueue` instance. Without
 * serialization, two concurrent calls against that instance can interleave
 * at the `load()`/`enqueue()`/`flush()` awaits — `queue.load()` *replaces*
 * the shared in-memory jobs array, so one caller's `load()` can clobber
 * another caller's not-yet-flushed `enqueue()`, silently dropping a job.
 * `withQueueMutex` chains each call onto the previous call *for the same
 * queue instance* via a module-level `WeakMap<JobQueue, Promise<void>>`
 * tail mutex, so the load->enqueue->flush critical section never overlaps
 * for that instance. The chain is keyed off a *settled* continuation (via
 * `.catch(() => undefined)`) so one call's rejection never wedges later
 * calls — the rejection still propagates to that call's own caller via the
 * promise returned here. Cross-*process* races (daemon vs. a separate CLI
 * or hook process) are intentionally out of scope: rarer, pre-existing, and
 * self-healing via dedupe + the 5-min scheduled full sync — deliberately not
 * closed with per-enqueue file locking, which would add I/O contention on
 * the hot watcher path.
 * Exported standalone so the fix is testable without booting a full
 * `MCPContext` (which requires a real global config on disk).
 */
const queueTails = new WeakMap<JobQueue, Promise<void>>();

async function enqueueAndPersistUnlocked(queue: JobQueue, input: JobCreateInput): Promise<void> {
  await queue.load();
  await queue.enqueue(input);
  await queue.flush();
}

export async function enqueueAndPersist(queue: JobQueue, input: JobCreateInput): Promise<void> {
  const previousTail = queueTails.get(queue) ?? Promise.resolve();
  const run = previousTail.catch(() => undefined).then(() => enqueueAndPersistUnlocked(queue, input));
  queueTails.set(queue, run.catch(() => undefined));
  return run;
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
  const queue = createJobQueue(join(stateDir, 'job-queue.json'), { maxActiveJobs: config.jobs.maxActiveJobs });

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

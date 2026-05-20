import { join } from 'node:path';
import { handleSessionStart } from './session-start.js';
import { handleUserPromptSubmit } from './user-prompt-submit.js';
import { handlePostToolUse } from './post-tool-use.js';
import { handlePostCompact } from './post-compact.js';
import { handleStop } from './stop.js';
import type { HookOutput } from './types.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { JobQueue } from '../jobs/queue.js';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { createSessionLogManager } from '../session/session-log.js';
import { createHotCacheManager } from '../session/hot-cache.js';
import { createJobQueue } from '../jobs/queue.js';
import { createFileLock } from '../jobs/lock.js';
import { createJobRunner } from '../jobs/runner.js';
import { createHandlerRegistry } from '../jobs/handlers/index.js';
import { resolveStateDir, resolveLockDir } from '../config/defaults.js';
import { createBedrockClient, createNoopClient } from '../enrichment/llm-client.js';
import { spawnBackgroundDrain } from './background-drain.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hooks');

export interface HookContext {
  config: KarpathyConfig;
  vault: ReturnType<typeof createFsAdapter>;
  sessionLog: ReturnType<typeof createSessionLogManager>;
  hotCache: ReturnType<typeof createHotCacheManager>;
  queue: JobQueue;
  backgroundDrain: () => void;
  runDeterministicJobs: () => Promise<number>;
}

function buildContext(config: KarpathyConfig): HookContext {
  const vault = createFsAdapter(config.vaultPath);
  const sessionLog = createSessionLogManager(vault, config.layout);
  const hotCache = createHotCacheManager(join(config.vaultPath, config.hotCachePath));

  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queue = createJobQueue(join(stateDir, 'job-queue.json'));

  return {
    config,
    vault,
    sessionLog,
    hotCache,
    queue,
    backgroundDrain: spawnBackgroundDrain,
    async runDeterministicJobs() {
      // Lazy-init: only create heavy infrastructure when actually draining
      const lock = createFileLock(lockDir);
      const handlers = createHandlerRegistry();
      const llm = config.llm.provider === 'bedrock'
        ? createBedrockClient({
            region: config.llm.region,
            model: config.llm.model,
            maxTokens: config.llm.maxTokens,
          })
        : createNoopClient();
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

export async function dispatchHook(
  eventName: string,
  input: unknown,
  config: KarpathyConfig,
): Promise<HookOutput | null> {
  const ctx = buildContext(config);

  try {
    switch (eventName) {
      case 'session-start':
        return await handleSessionStart(input, ctx);
      case 'user-prompt-submit':
        return await handleUserPromptSubmit(input, ctx);
      case 'post-tool-use':
        return await handlePostToolUse(input, ctx);
      case 'post-compact':
        return await handlePostCompact(input, ctx);
      case 'stop':
        return await handleStop(input, ctx);
      default:
        log.warn('Unknown hook event', { eventName });
        return null;
    }
  } catch (err) {
    log.error('Hook error', { eventName, error: (err as Error).message });
    return { continue: true }; // Never block Claude on hook failure
  }
}

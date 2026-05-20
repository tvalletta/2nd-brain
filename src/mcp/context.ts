import { join } from 'node:path';
import type { KarpathyConfig } from '../config/schema.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { SessionLogManager } from '../session/session-log.js';
import type { HotCacheManager } from '../session/hot-cache.js';
import type { JobCreateInput } from '../jobs/types.js';
import { loadConfig } from '../config/loader.js';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { createSessionLogManager } from '../session/session-log.js';
import { createHotCacheManager } from '../session/hot-cache.js';
import { createJobQueue } from '../jobs/queue.js';
import { createFileLock } from '../jobs/lock.js';
import { createJobRunner } from '../jobs/runner.js';
import { createHandlerRegistry } from '../jobs/handlers/index.js';
import { resolveStateDir, resolveLockDir, resolveLogDir } from '../config/defaults.js';
import { createBedrockClient, createNoopClient } from '../enrichment/llm-client.js';

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

  const usageLogPath = join(resolveLogDir(config), 'mcp-usage.jsonl');

  return {
    config,
    vault,
    sessionLog,
    hotCache,
    usageLogPath,
    async enqueueJob(input: JobCreateInput) {
      await queue.load();
      await queue.enqueue(input);
    },
    async runDeterministicJobs() {
      await queue.load();
      return runner.runAll();
    },
  };
}

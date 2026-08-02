import type { JobQueue } from './queue.js';
import type { FileLock } from './lock.js';
import { PAYLOAD_SCHEMAS, type Job, type JobHandler, type JobContext, type JobType } from './types.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import { createLogger } from '../shared/logger.js';
import { TransientLLMError, LockError } from '../shared/errors.js';
import { checkStuckJobAlert } from './stuck-alert.js';

const log = createLogger('runner');

/**
 * Fix E: dedicated key on the same `FileLock`/`lockDir` already threaded
 * into every `createJobRunner` call site (it's the per-`targetPath` lock
 * used by `executeJob`) — a distinct key namespace, so no collision with
 * real note paths.
 */
const QUEUE_RUNNER_LOCK_KEY = 'queue-runner';
/** Bounded-wait retry defaults for the queue-runner lock — ~7s total across processes. */
const DEFAULT_QUEUE_RUNNER_LOCK_RETRY_MS = 1000;
const DEFAULT_QUEUE_RUNNER_LOCK_MAX_ATTEMPTS = 8;

/** Default timeouts by architectural lane. */
const DEFAULT_TIMEOUTS: Partial<Record<JobType, number>> = {
  // Lane 1 — deterministic maintenance (30s)
  'update-backlinks': 30_000,
  'rebuild-index': 30_000,
  'rebuild-indexes': 30_000,
  'flush-hot-cache': 30_000,
  'cross-link-pages': 30_000,
  'lint-wiki': 30_000,
  // Lane 2 — extraction/enrichment (120s)
  'ingest-raw-file': 120_000,
  'classify-source': 120_000,
  'summarize-source': 120_000,
  'extract-entities': 120_000,
  'extract-entities-rich': 120_000,
  'link-concepts': 120_000,
  'compile-entities': 120_000,
  'agent-ingest': 600_000,
  'agent-synthesize-project': 600_000,
  'generate-synthesis-skills': 300_000,
  // Lane 3 — heuristic review (60s)
  'detect-contradictions': 60_000,
  'detect-duplicates': 60_000,
  'finalize-session': 60_000,
  'check-confidence-decay': 60_000,
  'detect-cross-project-patterns': 60_000,
  // Lane 1 — Phase 1 cascading curation (deterministic, fast)
  'evaluate-refresh-candidates': 30_000,
  // Intelligence pipeline — variable cost.
  //   embedding-index can fan out across thousands of files (bulk reindex).
  //   digest/topic-refresh/research-execute do multiple LLM calls per run.
  //   decay/rot scans walk the whole vault.
  'embedding-index': 1_800_000, // 30 min — bulk reindex can be slow
  'tldr-update': 60_000,
  'topic-refresh': 300_000,
  'digest-weekly': 600_000,
  'decay-scan': 120_000,
  'rot-scan': 60_000,
  'research-propose': 120_000,
  'research-execute': 600_000,
  'rebuild-vault-artifacts': 30_000,
};

export interface JobRunnerOptions {
  queue: JobQueue;
  lock: FileLock;
  handlers: Map<JobType, JobHandler>;
  vaultPath: string;
  projectRoot: string;
  llm: LLMClient;
  vault: VaultAdapter;
  config: KarpathyConfig;
  /**
   * Fix E: bounded-wait retry tuning for the global queue-runner lock
   * acquired at the start of `runAll()`. Test-only override — production
   * call sites rely on the defaults (~7s bounded wait total).
   */
  queueRunnerLock?: { retryMs?: number; maxAttempts?: number };
}

export interface JobRunner {
  runOne(): Promise<boolean>;
  runAll(): Promise<number>;
  stop(): void;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { queue, lock, handlers } = options;
  let stopped = false;
  const queueRunnerRetryMs = options.queueRunnerLock?.retryMs ?? DEFAULT_QUEUE_RUNNER_LOCK_RETRY_MS;
  const queueRunnerMaxAttempts = options.queueRunnerLock?.maxAttempts ?? DEFAULT_QUEUE_RUNNER_LOCK_MAX_ATTEMPTS;

  const context: JobContext = {
    vaultPath: options.vaultPath,
    projectRoot: options.projectRoot,
    enqueue: (input) => queue.enqueue(input),
    llm: options.llm,
    vault: options.vault,
    config: options.config,
  };

  /**
   * Fix E: acquire the whole-queue drain lock with a bounded wait (a few
   * retries over ~7s by default), since `FileLock.acquire` throws
   * `LockError` immediately rather than blocking when a different `FileLock`
   * instance (i.e. a different process) already holds it. Returns `null`
   * (never throws) when still held after the wait — the caller must skip
   * draining and leave jobs pending for the holder or the next scheduled
   * tick to pick up.
   */
  async function acquireQueueRunnerLock(): Promise<(() => Promise<void>) | null> {
    for (let attempt = 1; attempt <= queueRunnerMaxAttempts; attempt++) {
      try {
        return await lock.acquire(QUEUE_RUNNER_LOCK_KEY);
      } catch (err) {
        if (!(err instanceof LockError)) throw err;
        if (attempt === queueRunnerMaxAttempts) return null;
        await new Promise((resolve) => setTimeout(resolve, queueRunnerRetryMs));
      }
    }
    return null;
  }

  async function executeJob(job: Job): Promise<void> {
    const handler = handlers.get(job.type as JobType);
    if (!handler) {
      log.warn('No handler for job type', { type: job.type });
      await queue.fail(job.id, `No handler for ${job.type}`);
      return;
    }

    let release: (() => Promise<void>) | null = null;

    try {
      // Acquire lock if job targets a specific path
      if (job.targetPath) {
        release = await lock.acquire(job.targetPath);
      }

      // Warn-only payload validation
      const payloadSchema = PAYLOAD_SCHEMAS[job.type as JobType];
      if (payloadSchema) {
        const result = payloadSchema.safeParse(job.payload);
        if (!result.success) {
          log.warn('Job payload validation failed', {
            id: job.id, type: job.type,
            issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          });
        }
      }

      const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUTS[job.type as JobType] ?? 120_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      await Promise.race([handler.execute(job, context), timeoutPromise]);
      await queue.complete(job.id);
      log.info('Job completed', { id: job.id, type: job.type });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = err instanceof TransientLLMError;
      log.error('Job failed', { id: job.id, type: job.type, error: message, transient });
      await queue.fail(job.id, message, {
        transient,
        backoffCeilingMs: options.config.jobs.transientRetry.backoffCeilingMs,
      });
      if (transient) {
        // queue.fail() above mutates the job in place — the in-memory
        // JobQueue's dequeue()/fail() operate on live references into its
        // internal array, so the local `job` already reflects the updated
        // transientRetryCount/status. No re-fetch needed; revisit if a
        // future JobQueue implementation stops returning live references.
        await checkStuckJobAlert(job, options.config, queue);
      }
    } finally {
      if (release) await release();
    }
  }

  return {
    async runOne() {
      if (stopped) return false;
      const job = await queue.dequeue();
      if (!job) return false;
      await executeJob(job);
      return true;
    },

    async runAll() {
      const release = await acquireQueueRunnerLock();
      if (!release) {
        log.warn('queue-runner lock held — another drain in progress, skipping');
        return 0;
      }
      try {
        let processed = 0;
        while (!stopped) {
          const hadWork = await this.runOne();
          if (!hadWork) break;
          processed++;
        }
        await queue.flush();
        return processed;
      } finally {
        await release();
      }
    },

    stop() {
      stopped = true;
    },
  };
}

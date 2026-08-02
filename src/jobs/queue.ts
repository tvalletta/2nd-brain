import { readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { JobSchema, type Job, type JobStatus, type JobType, type JobCreateInput } from './types.js';
import { atomicWrite, ensureDir, fileExists } from '../shared/fs-utils.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';
import { dirname } from 'node:path';

const log = createLogger('queue');

const DEFAULT_TRANSIENT_BACKOFF_CEILING_MS = 1_800_000; // 30 min — matches config default (see config/schema.ts)
const DEFAULT_MAX_TRANSIENT_RETRIES = 20; // Fix F — matches config default (see config/schema.ts)
const DEFAULT_MAX_ACTIVE_JOBS = 1000; // Fix H — matches config default (see config/schema.ts)

export interface JobQueueOptions {
  /** Fix H: ceiling on total active (pending+running) jobs. `enqueue()` refuses
   *  new (non-deduped) jobs once this is reached. Defaults to 1000, matching
   *  `config.jobs.maxActiveJobs`. */
  maxActiveJobs?: number;
}

export interface JobQueue {
  /** Fix H: resolves to `null` (and logs a warning) when the active-job cap is reached. */
  enqueue(input: JobCreateInput): Promise<Job | null>;
  dequeue(): Promise<Job | null>;
  peek(): Promise<Job | null>;
  complete(jobId: string): Promise<void>;
  fail(
    jobId: string,
    error: string,
    opts?: { transient?: boolean; backoffCeilingMs?: number; maxTransientRetries?: number },
  ): Promise<void>;
  markAlerted(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  list(filter?: { status?: JobStatus; type?: JobType }): Promise<Job[]>;
  size(): number;
  flush(): Promise<void>;
  load(): Promise<void>;
}

export function createJobQueue(filePath: string, options?: JobQueueOptions): JobQueue {
  const maxActiveJobs = options?.maxActiveJobs ?? DEFAULT_MAX_ACTIVE_JOBS;
  let jobs: Job[] = [];

  function findIndex(jobId: string): number {
    return jobs.findIndex((j) => j.id === jobId);
  }

  function isDuplicate(dedupeKey: string): boolean {
    return jobs.some(
      (j) => j.dedupeKey === dedupeKey && (j.status === 'pending' || j.status === 'running'),
    );
  }

  function nextReady(): Job | null {
    const now = Date.now();
    const pending = jobs
      .filter((j) => {
        if (j.status !== 'pending') return false;
        if (j.debounceMs > 0) {
          const readyAt = new Date(j.createdAt).getTime() + j.debounceMs;
          if (now < readyAt) return false;
        }
        if (j.retryAfter && now < j.retryAfter) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
    return pending[0] ?? null;
  }

  return {
    async enqueue(input) {
      if (input.dedupeKey && isDuplicate(input.dedupeKey)) {
        log.debug('Deduped job', { dedupeKey: input.dedupeKey, type: input.type });
        const existing = jobs.find(
          (j) => j.dedupeKey === input.dedupeKey && (j.status === 'pending' || j.status === 'running'),
        )!;
        return existing;
      }

      const activeCount = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
      if (activeCount >= maxActiveJobs) {
        log.warn(`job queue at capacity (${activeCount}) — dropping ${input.type}`);
        return null;
      }

      const job = JobSchema.parse({
        ...input,
        id: nanoid(),
        status: 'pending',
        createdAt: nowISO(),
        retryCount: 0,
      });

      jobs.push(job);
      log.debug('Enqueued job', { id: job.id, type: job.type });
      return job;
    },

    async dequeue() {
      const job = nextReady();
      if (!job) return null;
      job.status = 'running';
      job.startedAt = nowISO();
      return job;
    },

    async peek() {
      return nextReady();
    },

    async complete(jobId) {
      const idx = findIndex(jobId);
      if (idx === -1) return;
      jobs[idx].status = 'completed';
      jobs[idx].completedAt = nowISO();
    },

    async fail(jobId, error, opts) {
      const idx = findIndex(jobId);
      if (idx === -1) return;
      const job = jobs[idx];
      job.error = error;

      if (opts?.transient) {
        job.transientRetryCount += 1;
        if (!job.transientSince) job.transientSince = nowISO();

        // Fix F: cap indefinite transient retries. Previously this branch
        // reset the job to 'pending' forever, re-spending LLM budget on
        // every attempt against a persistently-unreachable endpoint.
        const maxTransientRetries = opts.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
        if (job.transientRetryCount > maxTransientRetries) {
          job.status = 'failed';
          job.completedAt = nowISO();
          job.startedAt = undefined;
          log.error('Job failed transiently too many times, giving up', {
            id: jobId, transientRetry: job.transientRetryCount, maxTransientRetries,
          });
          return;
        }

        job.status = 'pending';
        job.startedAt = undefined;
        const ceiling = opts.backoffCeilingMs ?? DEFAULT_TRANSIENT_BACKOFF_CEILING_MS;
        const baseDelay = Math.min(1000 * Math.pow(2, job.transientRetryCount - 1), ceiling);
        const jitter = Math.random() * baseDelay * 0.25;
        job.retryAfter = Date.now() + baseDelay + jitter;
        log.warn('Job failed transiently, retrying', {
          id: jobId, transientRetry: job.transientRetryCount, retryAfter: job.retryAfter,
        });
        return;
      }

      if (job.retryCount < job.maxRetries) {
        job.retryCount += 1;
        job.status = 'pending';
        job.startedAt = undefined;
        // Exponential backoff with jitter: 1s, 2s, 4s, ... + random 0-25%
        const baseDelay = 1000 * Math.pow(2, job.retryCount - 1);
        const jitter = Math.random() * baseDelay * 0.25;
        job.retryAfter = Date.now() + baseDelay + jitter;
        log.warn('Job failed, retrying', { id: jobId, retry: job.retryCount, retryAfter: job.retryAfter });
      } else {
        job.status = 'failed';
        job.completedAt = nowISO();
        log.error('Job failed permanently', { id: jobId, error });
      }
    },

    async markAlerted(jobId) {
      const idx = findIndex(jobId);
      if (idx === -1) return;
      jobs[idx].transientAlertSentAt = nowISO();
    },

    async cancel(jobId) {
      const idx = findIndex(jobId);
      if (idx === -1) return;
      jobs[idx].status = 'cancelled';
      jobs[idx].completedAt = nowISO();
    },

    async list(filter) {
      return jobs.filter((j) => {
        if (filter?.status && j.status !== filter.status) return false;
        if (filter?.type && j.type !== filter.type) return false;
        return true;
      });
    },

    size() {
      return jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
    },

    async flush() {
      await ensureDir(dirname(filePath));
      // Keep only active + recent completed (last 100)
      const active = jobs.filter((j) => j.status === 'pending' || j.status === 'running');
      const done = jobs
        .filter((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
        .slice(-100);
      const toSave = [...active, ...done];
      await atomicWrite(filePath, JSON.stringify(toSave, null, 2));
    },

    async load() {
      if (!(await fileExists(filePath))) {
        jobs = [];
        return;
      }
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          jobs = [];
          return;
        }
        jobs = parsed
          .map((entry: unknown) => {
            const result = JobSchema.safeParse(entry);
            return result.success ? result.data : null;
          })
          .filter((j): j is Job => j !== null);
        log.info('Loaded job queue', { count: jobs.length });
      } catch {
        log.warn('Failed to load job queue, starting fresh');
        jobs = [];
      }
    },
  };
}

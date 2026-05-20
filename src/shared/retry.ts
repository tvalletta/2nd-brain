import { createLogger } from './logger.js';

const log = createLogger('retry');

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseDelayMs?: number;
  /** Per-attempt timeout in ms. Omit to disable timeout. */
  timeoutMs?: number;
  /** Predicate: return true if the error is retryable. Default: always retry. */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Run an async function with retry and optional per-attempt timeout.
 * Uses exponential backoff with jitter between attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = opts.timeoutMs
        ? await withTimeout(fn(), opts.timeoutMs)
        : await fn();
      return result;
    } catch (err) {
      lastError = err;

      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * baseDelayMs * 0.25;
      log.debug('Retrying after error', {
        attempt,
        maxAttempts,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }

  // Should not be reachable, but TypeScript needs it
  throw lastError;
}

/**
 * Race a promise against a timeout. Rejects with a TimeoutError if the
 * timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Check if an error is a transient Bedrock/network error worth retrying.
 */
export function isTransientBedrockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Timeout errors are always retryable
  if (err instanceof TimeoutError) return true;

  const message = err.message.toLowerCase();

  // Network errors
  if (['econnreset', 'etimedout', 'econnrefused', 'epipe', 'ehostunreach', 'enetunreach']
    .some((code) => message.includes(code))) {
    return true;
  }

  // HTTP status-based errors (Anthropic SDK includes status in error)
  const statusMatch = message.match(/status[:\s]*(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    // 429 = rate limit, 5xx = server errors
    if (status === 429 || (status >= 500 && status < 600)) return true;
  }

  // Anthropic SDK error types
  if ('status' in err) {
    const status = (err as any).status;
    if (status === 429 || (status >= 500 && status < 600)) return true;
  }

  // Generic transient patterns
  if (message.includes('throttl') || message.includes('rate limit') || message.includes('too many requests')) {
    return true;
  }

  return false;
}

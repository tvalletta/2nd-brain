import { describe, it, expect, vi } from 'vitest';
import { withRetry, TimeoutError, isTransientBedrockError } from '../../src/shared/retry.js';

describe('withRetry', () => {
  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient failure then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately for non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('not retryable');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies timeout to each attempt', async () => {
    const fn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000, 'late')),
    );

    await expect(
      withRetry(fn, { maxAttempts: 1, timeoutMs: 50 }),
    ).rejects.toThrow('timed out');
  });

  it('retries increase delay between attempts', async () => {
    const callTimes: number[] = [];
    const fn = vi.fn().mockImplementation(() => {
      callTimes.push(Date.now());
      if (callTimes.length < 3) return Promise.reject(new Error('fail'));
      return Promise.resolve('ok');
    });

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 20 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);

    // Second delay should be longer than the first (exponential backoff)
    if (callTimes.length === 3) {
      const delay1 = callTimes[1] - callTimes[0];
      const delay2 = callTimes[2] - callTimes[1];
      expect(delay2).toBeGreaterThanOrEqual(delay1);
    }
  });
});

describe('TimeoutError', () => {
  it('has correct name and message', () => {
    const err = new TimeoutError(5000);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('5000ms');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isTransientBedrockError', () => {
  it('returns true for TimeoutError', () => {
    expect(isTransientBedrockError(new TimeoutError(1000))).toBe(true);
  });

  it('returns true for rate limit errors', () => {
    const err = new Error('Request failed with status 429');
    expect(isTransientBedrockError(err)).toBe(true);
  });

  it('returns true for server errors (5xx)', () => {
    const err = new Error('Request failed with status 500');
    expect(isTransientBedrockError(err)).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isTransientBedrockError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientBedrockError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isTransientBedrockError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns true for throttling messages', () => {
    expect(isTransientBedrockError(new Error('Too many requests'))).toBe(true);
    expect(isTransientBedrockError(new Error('Rate limit exceeded'))).toBe(true);
  });

  it('returns true for errors with status property', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    expect(isTransientBedrockError(err)).toBe(true);
  });

  it('returns false for client errors (4xx)', () => {
    const err = new Error('Request failed with status 400');
    expect(isTransientBedrockError(err)).toBe(false);
  });

  it('returns false for non-errors', () => {
    expect(isTransientBedrockError('string')).toBe(false);
    expect(isTransientBedrockError(null)).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isTransientBedrockError(new Error('Unknown tool: foo'))).toBe(false);
  });
});

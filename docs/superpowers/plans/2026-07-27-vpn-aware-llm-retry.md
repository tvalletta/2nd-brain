# VPN-Aware LLM Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM-calling jobs survive VPN outages of minutes-to-hours without being lost, and fix a pre-existing bug where the real job-runner entrypoint silently no-ops instead of calling LiteLLM.

**Architecture:** A shared LLM-client factory (replacing three incomplete, hand-duplicated ones) wraps whichever real client is built with a per-provider connectivity-probe cache. The two real `fetch`-based clients classify failures via a shared helper into `TransientLLMError` (network/429/5xx/401/403) versus plain `Error` (bad request/unknown status). The job queue grows a second, uncapped retry lane driven by that classification, independent of the existing bounded `retryCount`/`maxRetries` path, with a one-shot Slack alert if a streak runs past an hour.

**Tech Stack:** TypeScript (ESM, strict), Zod, Vitest, Node's built-in `fetch`/`http`.

**Design spec:** `docs/superpowers/specs/2026-07-27-vpn-aware-llm-retry-design.md`

## Global Constraints

- ESM only — all imports use `.js` extensions, even for `.ts` source files.
- Strict TypeScript — `pnpm lint` (`tsc --noEmit`) must pass with no errors.
- `pnpm build && pnpm test && pnpm lint` must all pass before any commit that isn't marked "expected to fail" in its own step.
- Vitest is the test runner; tests live under `test/`, mirroring `src/` structure.
- No new runtime dependencies — everything here uses Node built-ins (`fetch`, `node:fs`, `node:http` for tests) plus the existing `zod`.
- Follow existing file conventions exactly where one exists: `src/shared/budget.ts`'s sync-fs, JSON-state-file pattern for the new connectivity-probe module; `test/embeddings/ollama.test.ts`'s local-HTTP-server mock pattern for fetch-based tests; `vi.mock(..., async (importOriginal) => ...)` passthrough-mock style (see `test/eval/judge-full-main.test.ts`) for module mocks.
- Never commit with `--no-verify` or skip hooks.

---

### Task 1: Config schema — `jobs.transientRetry`

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config/schema.test.ts` (new file)

**Interfaces:**
- Produces: `JobsConfigSchema` (exported Zod schema), `KarpathyConfig['jobs']: { transientRetry: { backoffCeilingMs: number; alertAfterMs: number; probeTrustWindowMs: number } }`. All three fields are defaulted, so `KarpathyConfigSchema.parse({ vaultPath: '...' })` always produces a fully-populated `jobs.transientRetry` object.

- [ ] **Step 1: Write the failing test**

Create `test/config/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('KarpathyConfigSchema — jobs.transientRetry', () => {
  it('defaults jobs.transientRetry when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.jobs.transientRetry).toEqual({
      backoffCeilingMs: 1_800_000,
      alertAfterMs: 3_600_000,
      probeTrustWindowMs: 120_000,
    });
  });

  it('allows partial overrides, filling in the rest with defaults', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      jobs: { transientRetry: { alertAfterMs: 0 } },
    });
    expect(config.jobs.transientRetry.alertAfterMs).toBe(0);
    expect(config.jobs.transientRetry.backoffCeilingMs).toBe(1_800_000);
    expect(config.jobs.transientRetry.probeTrustWindowMs).toBe(120_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: FAIL — `config.jobs` is `undefined` (property doesn't exist on the parsed type / TypeScript error, or a runtime `TypeError` reading `.transientRetry` off `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `src/config/schema.ts`, add a new schema right after `EnrichmentConfigSchema` (currently ending at line 223):

```typescript
export const JobsConfigSchema = z.object({
  transientRetry: z
    .object({
      backoffCeilingMs: z.number().int().positive().default(1_800_000), // 30 min
      alertAfterMs: z.number().int().positive().default(3_600_000), // 1 hour
      probeTrustWindowMs: z.number().int().positive().default(120_000), // 2 min
    })
    .default({}),
});
```

Add `jobs: JobsConfigSchema.default({}),` to `KarpathyConfigSchema` (`:282-300`), alongside the other top-level sections (e.g. right after the existing `notifications: NotificationsConfigSchema.default({}),` line).

Add the partial declaration alongside the other `Partial...ConfigSchema` declarations (`:303-313`):

```typescript
const PartialJobsConfigSchema = JobsConfigSchema.partial();
```

Add `jobs: PartialJobsConfigSchema.optional(),` to both `ProjectOverrideSchema` (`:315-332`) and `GlobalDefaultsSchema` (`:334-...`), each alongside their existing `notifications: PartialNotificationsConfigSchema.optional(),` line.

No changes needed anywhere in `src/config/loader.ts` — its `mergeOverride()` function (`:18-42`) merges every top-level key generically by name; it has no hardcoded list of section names to update.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "feat(config): add jobs.transientRetry config schema"
```

---

### Task 2: `TransientLLMError` + shared fetch-classification helper in `llm-client.ts`

**Files:**
- Modify: `src/shared/errors.ts`
- Modify: `src/enrichment/llm-client.ts`
- Test: `test/enrichment/llm-client.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `TransientLLMError` (class, extends `KarpathyError`, `code: 'LLM_TRANSIENT_ERROR'`, optional `httpStatus?: number` property) from `src/shared/errors.ts`. `fetchWithClassification(url: string, init: RequestInit, label: string): Promise<Response>` exported from `src/enrichment/llm-client.ts` — throws `TransientLLMError` for network failures and status codes `{401, 403, 429, 500, 502, 503, 504}`; throws plain `Error` for any other non-2xx status. `createBedrockBearerClient` and `createLiteLLMClient`'s behavior is otherwise unchanged (same return shapes, same `ExtractionError` on malformed JSON).

- [ ] **Step 1: Write the failing test**

Add to `test/enrichment/llm-client.test.ts` (append after the existing `extractJSON` describe block):

```typescript
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createBedrockBearerClient, createLiteLLMClient, fetchWithClassification } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

async function startStatusServer(status: number, body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('fetchWithClassification', () => {
  let mock: { url: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it.each([401, 403, 429, 500, 502, 503, 504])('throws TransientLLMError on HTTP %i', async (status) => {
    mock = await startStatusServer(status, { error: 'boom' });
    await expect(fetchWithClassification(mock.url, { method: 'POST' }, 'Test')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it.each([400, 404, 418])('throws a plain Error (not TransientLLMError) on HTTP %i', async (status) => {
    mock = await startStatusServer(status, { error: 'nope' });
    await expect(fetchWithClassification(mock.url, { method: 'POST' }, 'Test')).rejects.not.toBeInstanceOf(TransientLLMError);
  });

  it('throws TransientLLMError on connection refused', async () => {
    // Port 1 — nothing listens here (same convention as ollama.test.ts).
    await expect(fetchWithClassification('http://127.0.0.1:1', { method: 'POST' }, 'Test')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('sets httpStatus on the thrown TransientLLMError', async () => {
    mock = await startStatusServer(503, { error: 'boom' });
    await expect(fetchWithClassification(mock.url, { method: 'POST' }, 'Test')).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('returns the response unchanged on a 2xx status', async () => {
    mock = await startStatusServer(200, { ok: true });
    const res = await fetchWithClassification(mock.url, { method: 'POST' }, 'Test');
    expect(res.ok).toBe(true);
  });
});

describe('createBedrockBearerClient / createLiteLLMClient — classification wiring', () => {
  let mock: { url: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('LiteLLM client propagates TransientLLMError on a 500', async () => {
    mock = await startStatusServer(500, { error: 'boom' });
    const client = createLiteLLMClient({ baseUrl: mock.url, apiKey: 'k', model: 'm', maxTokens: 100 });
    await expect(client.complete('hi')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('Bedrock bearer client propagates a plain Error on a 404 (real AWS host, unreachable — expect network TransientLLMError instead since we cannot mock the hardcoded host)', async () => {
    // createBedrockBearerClient hardcodes the bedrock-runtime.<region>.amazonaws.com host, so it
    // cannot be pointed at a local mock server. A bogus region reliably produces a DNS failure,
    // which fetchWithClassification classifies as a network-level TransientLLMError — this proves
    // the client is wired through fetchWithClassification without needing a real AWS endpoint.
    const client = createBedrockBearerClient({ region: 'not-a-real-region-xyz', model: 'm', maxTokens: 100, bearerToken: 't' });
    await expect(client.complete('hi')).rejects.toBeInstanceOf(TransientLLMError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/enrichment/llm-client.test.ts`
Expected: FAIL — `fetchWithClassification` and `TransientLLMError` are not exported yet (import error).

- [ ] **Step 3: Write minimal implementation**

In `src/shared/errors.ts`, add after `ExtractionError`:

```typescript
export class TransientLLMError extends KarpathyError {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message, 'LLM_TRANSIENT_ERROR');
    this.name = 'TransientLLMError';
  }
}
```

In `src/enrichment/llm-client.ts`, add the import and the shared helper near the top (after the existing `import { ExtractionError } from '../shared/errors.js';` line):

```typescript
import { ExtractionError, TransientLLMError } from '../shared/errors.js';

const TRANSIENT_STATUS_CODES = new Set([401, 403, 429, 500, 502, 503, 504]);

/**
 * Runs `fetch`, classifying failures so callers can decide retry behavior:
 * network-level failures and the status codes in TRANSIENT_STATUS_CODES
 * throw TransientLLMError (safe to retry indefinitely); everything else
 * throws a plain Error (bad request/model — retrying won't help).
 */
export async function fetchWithClassification(url: string, init: RequestInit, label: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new TransientLLMError(`${label} network error calling ${url}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    const message = `${label} request failed (${res.status}): ${errText}`;
    if (TRANSIENT_STATUS_CODES.has(res.status)) {
      throw new TransientLLMError(message, res.status);
    }
    throw new Error(message);
  }

  return res;
}
```

Replace `createBedrockBearerClient`'s `call()` function (`:120-142`):

```typescript
async function call(prompt: string, maxTokens: number, _temperature: number): Promise<string> {
  const res = await fetchWithClassification(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.bearerToken}`,
    },
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  }, 'Bedrock Bearer');

  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? '';
}
```

Replace `createLiteLLMClient`'s `call()` function (`:255-278`):

```typescript
async function call(prompt: string, maxTokens: number, temperature: number): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetchWithClassification(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
    }),
  }, 'LiteLLM');

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}
```

`extractStructured()` on both clients is unchanged — it still calls the same `call()` function and still wraps JSON-parse failures in `ExtractionError`, unaffected by this change since `call()`'s external signature (`Promise<string>`) is identical.

No changes to `createBedrockClient`'s SDK-based branch (`:169-244`) or `createNoopClient` (`:308-317`) — out of scope per the design spec's non-goals.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/enrichment/llm-client.test.ts`
Expected: PASS (all existing `extractJSON` tests still pass, plus all new classification tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts src/enrichment/llm-client.ts test/enrichment/llm-client.test.ts
git commit -m "feat(llm): classify transient vs permanent fetch failures"
```

---

### Task 3: Job schema fields + `queue.fail()` transient lane + `queue.markAlerted()`

**Files:**
- Modify: `src/jobs/types.ts`
- Modify: `src/jobs/queue.ts`
- Test: `test/jobs/queue.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing from other tasks (the default backoff ceiling is a literal constant here, matching Task 1's config default by value — not by import, since `queue.ts` has no dependency on `KarpathyConfig` today and this plan does not introduce one; the real configured value is threaded in by the caller in Task 7).
- Produces: `Job.transientRetryCount: number`, `Job.transientSince?: string`, `Job.transientAlertSentAt?: string`. `JobQueue.fail(jobId: string, error: string, opts?: { transient?: boolean; backoffCeilingMs?: number }): Promise<void>` (signature change — `opts` is new and optional, so all existing call sites that call `fail(jobId, error)` with two args keep compiling and behaving identically). `JobQueue.markAlerted(jobId: string): Promise<void>` (new method).

- [ ] **Step 1: Write the failing test**

Add to `test/jobs/queue.test.ts` (append a new `describe` block):

```typescript
describe('JobQueue — transient retry lane', () => {
  it('never marks a transiently-failing job as failed, and leaves retryCount untouched', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index', maxRetries: 3 });

    for (let i = 0; i < 10; i++) {
      await queue.fail(job.id, 'simulated outage', { transient: true });
    }

    const [stored] = await queue.list();
    expect(stored.status).toBe('pending');
    expect(stored.retryCount).toBe(0);
    expect(stored.transientRetryCount).toBe(10);
    expect(stored.transientSince).toBeTruthy();
  });

  it('caps backoff at backoffCeilingMs', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });

    for (let i = 0; i < 20; i++) {
      await queue.fail(job.id, 'simulated outage', { transient: true, backoffCeilingMs: 5000 });
    }

    const [stored] = await queue.list();
    // 20 doublings would be enormous uncapped; confirm it's pinned at the 5s ceiling (+ up to 25% jitter).
    const delay = stored.retryAfter! - Date.now();
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThanOrEqual(5000 * 1.25 + 50);
  });

  it('keeps the existing bounded path unchanged for non-transient failures', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index', maxRetries: 2 });

    await queue.fail(job.id, 'bad request');
    await queue.fail(job.id, 'bad request');
    await queue.fail(job.id, 'bad request');

    const [stored] = await queue.list();
    expect(stored.status).toBe('failed');
    expect(stored.transientRetryCount).toBe(0);
  });

  it('markAlerted stamps transientAlertSentAt', async () => {
    const queue = createJobQueue(queuePath);
    const job = await queue.enqueue({ type: 'rebuild-index' });
    expect(job.transientAlertSentAt).toBeUndefined();

    await queue.markAlerted(job.id);

    const [stored] = await queue.list();
    expect(stored.transientAlertSentAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/jobs/queue.test.ts`
Expected: FAIL — `queue.fail()` doesn't accept a third argument yet (TypeScript error) and `queue.markAlerted` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/types.ts`, add three fields to `JobSchema` (`:53-71`), alongside the existing `retryAfter`/`timeoutMs` fields:

```typescript
  transientRetryCount: z.number().int().default(0),
  transientSince: z.string().optional(),
  transientAlertSentAt: z.string().optional(),
```

In `src/jobs/queue.ts`, update the `JobQueue` interface (`:11-22`):

```typescript
  fail(jobId: string, error: string, opts?: { transient?: boolean; backoffCeilingMs?: number }): Promise<void>;
  markAlerted(jobId: string): Promise<void>;
```

Add a module-level default near the top of the file, alongside the existing `const log = createLogger('queue');`:

```typescript
const DEFAULT_TRANSIENT_BACKOFF_CEILING_MS = 1_800_000; // 30 min — matches config default (see config/schema.ts)
```

Replace `fail()`'s implementation (`:95-115`):

```typescript
    async fail(jobId, error, opts) {
      const idx = findIndex(jobId);
      if (idx === -1) return;
      const job = jobs[idx];
      job.error = error;

      if (opts?.transient) {
        job.transientRetryCount += 1;
        if (!job.transientSince) job.transientSince = nowISO();
        job.status = 'pending';
        job.startedAt = undefined;
        const ceiling = opts.backoffCeilingMs ?? DEFAULT_TRANSIENT_BACKOFF_CEILING_MS;
        const baseDelay = Math.min(1000 * Math.pow(2, job.transientRetryCount - 1), ceiling);
        const jitter = Math.random() * baseDelay * 0.25;
        job.retryAfter = Date.now() + baseDelay + jitter;
        log.warn('Job failed transiently, retrying indefinitely', {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/jobs/queue.test.ts`
Expected: PASS (all existing queue tests plus the four new ones)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/types.ts src/jobs/queue.ts test/jobs/queue.test.ts
git commit -m "feat(jobs): add an uncapped transient-retry lane to the job queue"
```

---

### Task 4: Connectivity-probe cache (`src/enrichment/connectivity-probe.ts`)

**Files:**
- Create: `src/enrichment/connectivity-probe.ts`
- Test: `test/enrichment/connectivity-probe.test.ts` (new file)

**Interfaces:**
- Consumes: `TransientLLMError` from Task 2, `KarpathyConfig` type from Task 1 (only for `withConnectivityProbe`'s parameter type — it reads `config.jobs.transientRetry.probeTrustWindowMs`), `LLMClient` interface from `src/enrichment/llm-client.js` (pre-existing, unchanged).
- Produces: `createConnectivityProbe(stateDir: string, trustWindowMs: number): ConnectivityProbe` where `ConnectivityProbe = { shouldSkip(providerId: string): boolean; recordOutcome(providerId: string, ok: boolean, error?: string): void }`. `withConnectivityProbe(client: LLMClient, providerId: string, config: KarpathyConfig, stateDir: string): LLMClient` — consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/enrichment/connectivity-probe.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createConnectivityProbe, withConnectivityProbe } from '../../src/enrichment/connectivity-probe.js';
import { createNoopClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('connectivity probe', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-probe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not skip when no prior outcome is recorded', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('skips within the trust window after a recorded failure', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    probe.recordOutcome('litellm', false, 'boom');
    expect(probe.shouldSkip('litellm')).toBe(true);
  });

  it('does not skip once the trust window has elapsed', () => {
    mkdirSync(dir, { recursive: true });
    const staleTimestamp = new Date(Date.now() - 200_000).toISOString();
    writeFileSync(
      join(dir, 'connectivity-probe.json'),
      JSON.stringify({ litellm: { reachable: false, checkedAt: staleTimestamp, error: 'boom' } }),
    );
    const probe = createConnectivityProbe(dir, 120_000); // 2 min window, entry is ~3.3 min stale
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('a successful outcome clears a prior failure', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    probe.recordOutcome('litellm', false, 'boom');
    expect(probe.shouldSkip('litellm')).toBe(true);
    probe.recordOutcome('litellm', true);
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('keeps providers isolated — a bedrock failure does not affect litellm', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    probe.recordOutcome('bedrock', false, 'boom');
    expect(probe.shouldSkip('bedrock')).toBe(true);
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('withConnectivityProbe short-circuits with TransientLLMError when skip applies, without calling the wrapped client', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    let calls = 0;
    const inner = createNoopClient();
    const spyClient = {
      complete: async (...args: Parameters<typeof inner.complete>) => {
        calls++;
        return inner.complete(...args);
      },
      extractStructured: inner.extractStructured,
    };

    const wrapped = withConnectivityProbe(spyClient, 'litellm', config, dir);
    // First call fails for a non-transient reason isn't possible with noop's complete()
    // (it never throws), so seed the cache directly instead.
    const probe = createConnectivityProbe(dir, config.jobs.transientRetry.probeTrustWindowMs);
    probe.recordOutcome('litellm', false, 'boom');

    await expect(wrapped.complete('hi')).rejects.toBeInstanceOf(TransientLLMError);
    expect(calls).toBe(0);
  });

  it('withConnectivityProbe records a real success and clears the skip', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    const probe = createConnectivityProbe(dir, config.jobs.transientRetry.probeTrustWindowMs);
    probe.recordOutcome('litellm', false, 'boom');

    // trustWindowMs of 0 forces the wrapper to attempt for real instead of trusting the stale skip.
    const config2 = KarpathyConfigSchema.parse({ vaultPath: dir, jobs: { transientRetry: { probeTrustWindowMs: 0 } } });
    const wrapped = withConnectivityProbe(createNoopClient(), 'litellm', config2, dir);
    await wrapped.complete('hi'); // noop client never throws

    const freshProbe = createConnectivityProbe(dir, 120_000);
    expect(freshProbe.shouldSkip('litellm')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/enrichment/connectivity-probe.test.ts`
Expected: FAIL — the module doesn't exist yet (import error).

- [ ] **Step 3: Write minimal implementation**

Create `src/enrichment/connectivity-probe.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { TransientLLMError } from '../shared/errors.js';
import type { LLMClient } from './llm-client.js';
import type { KarpathyConfig } from '../config/schema.js';

const log = createLogger('connectivity-probe');

export interface ProbeState {
  reachable: boolean;
  checkedAt: string;
  error?: string;
}

export interface ConnectivityProbe {
  shouldSkip(providerId: string): boolean;
  recordOutcome(providerId: string, ok: boolean, error?: string): void;
}

function loadState(filePath: string): Record<string, ProbeState> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, ProbeState>;
  } catch {
    log.warn('Failed to parse connectivity-probe state, starting fresh', { filePath });
    return {};
  }
}

function saveState(filePath: string, state: Record<string, ProbeState>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function createConnectivityProbe(stateDir: string, trustWindowMs: number): ConnectivityProbe {
  const filePath = join(stateDir, 'connectivity-probe.json');
  let state = loadState(filePath);

  return {
    shouldSkip(providerId) {
      const entry = state[providerId];
      if (!entry || entry.reachable) return false;
      const age = Date.now() - Date.parse(entry.checkedAt);
      return age < trustWindowMs;
    },
    recordOutcome(providerId, ok, error) {
      state = { ...state, [providerId]: { reachable: ok, checkedAt: new Date().toISOString(), error: ok ? undefined : error } };
      saveState(filePath, state);
    },
  };
}

export function withConnectivityProbe(
  client: LLMClient,
  providerId: string,
  config: KarpathyConfig,
  stateDir: string,
): LLMClient {
  const probe = createConnectivityProbe(stateDir, config.jobs.transientRetry.probeTrustWindowMs);

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (probe.shouldSkip(providerId)) {
      throw new TransientLLMError(`Skipped: ${providerId} marked unreachable within the trust window`);
    }
    try {
      const result = await fn();
      probe.recordOutcome(providerId, true);
      return result;
    } catch (err) {
      if (err instanceof TransientLLMError) probe.recordOutcome(providerId, false, err.message);
      throw err;
    }
  }

  return {
    complete: (prompt, options) => guarded(() => client.complete(prompt, options)),
    extractStructured: (prompt, schema) => guarded(() => client.extractStructured(prompt, schema)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/enrichment/connectivity-probe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/enrichment/connectivity-probe.ts test/enrichment/connectivity-probe.test.ts
git commit -m "feat(llm): add per-provider connectivity-probe cache"
```

---

### Task 5: Shared LLM-client factory + migrate all four call sites

**Files:**
- Create: `src/enrichment/llm-factory.ts`
- Modify: `src/bin/karpathy.ts`
- Modify: `src/bin/intel-command.ts`
- Modify: `src/mcp/context.ts`
- Modify: `src/hooks/dispatch.ts`
- Test: `test/enrichment/llm-factory.test.ts` (new file)

**Interfaces:**
- Consumes: `withConnectivityProbe` from Task 4; `createBedrockClient`, `createLiteLLMClient`, `createNoopClient` from `src/enrichment/llm-client.js` (pre-existing, unchanged).
- Produces: `createLLMFromConfig(config: KarpathyConfig, stateDir: string): LLMClient` from `src/enrichment/llm-factory.ts` — consumed by all four call sites below (no other task depends on this).

- [ ] **Step 1: Write the failing test**

Create `test/enrichment/llm-factory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

vi.mock('../../src/enrichment/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/enrichment/llm-client.js')>();
  return {
    ...actual,
    createBedrockClient: vi.fn(actual.createBedrockClient),
    createLiteLLMClient: vi.fn(actual.createLiteLLMClient),
  };
});

import { createBedrockClient, createLiteLLMClient } from '../../src/enrichment/llm-client.js';
import { createLLMFromConfig } from '../../src/enrichment/llm-factory.js';

describe('createLLMFromConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-factory-'));
    vi.clearAllMocks();
  });

  it('builds a LiteLLM client and forwards baseUrl/apiKey/model', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: { provider: 'litellm', baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-haiku-4.5' },
    });
    createLLMFromConfig(config, dir);
    expect(createLiteLLMClient).toHaveBeenCalledWith({
      baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-haiku-4.5', maxTokens: config.llm.maxTokens,
    });
    expect(createBedrockClient).not.toHaveBeenCalled();
  });

  it('throws a clear error when litellm is selected without baseUrl/apiKey', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, llm: { provider: 'litellm' } });
    expect(() => createLLMFromConfig(config, dir)).toThrow(/requires llm.baseUrl and llm.apiKey/);
  });

  it('builds a Bedrock client and forwards bearerToken', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: { provider: 'bedrock', region: 'us-west-2', model: 'claude-sonnet-4-6', bearerToken: 'tok' },
    });
    createLLMFromConfig(config, dir);
    expect(createBedrockClient).toHaveBeenCalledWith({
      region: 'us-west-2', model: 'claude-sonnet-4-6', maxTokens: config.llm.maxTokens, bearerToken: 'tok',
    });
  });

  it('returns a noop client when no provider matches', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, llm: { provider: 'bedrock' as const } });
    // Force an unrecognized provider via a cast, simulating defensive fallback behavior.
    (config.llm as { provider: string }).provider = 'unknown';
    const client = createLLMFromConfig(config, dir);
    expect(client.complete('hi')).resolves.toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/enrichment/llm-factory.test.ts`
Expected: FAIL — `src/enrichment/llm-factory.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/enrichment/llm-factory.ts`:

```typescript
import { createBedrockClient, createLiteLLMClient, createNoopClient, type LLMClient } from './llm-client.js';
import { withConnectivityProbe } from './connectivity-probe.js';
import type { KarpathyConfig } from '../config/schema.js';

export function createLLMFromConfig(config: KarpathyConfig, stateDir: string): LLMClient {
  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    const client = createLiteLLMClient({ baseUrl, apiKey, model: config.llm.model, maxTokens: config.llm.maxTokens });
    return withConnectivityProbe(client, 'litellm', config, stateDir);
  }
  if (config.llm.provider === 'bedrock') {
    const client = createBedrockClient({
      region: config.llm.region,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
    return withConnectivityProbe(client, 'bedrock', config, stateDir);
  }
  return createNoopClient();
}
```

Now migrate all four call sites:

**`src/bin/karpathy.ts`:** Delete the local `createLLMFromConfig` function (`:61-84`). Add the import near the other enrichment imports: `import { createLLMFromConfig } from '../enrichment/llm-factory.js';`. Every existing call site (`createLLMFromConfig(config)`, six occurrences per the grounding pass — at minimum lines 245, 286, 352, 593, 859, and any others found via `grep -n "createLLMFromConfig(config)" src/bin/karpathy.ts`) becomes `createLLMFromConfig(config, stateDir)` — each of those call sites already has `const stateDir = resolveStateDir(config);` in scope earlier in the same function (confirmed during grounding; re-verify with the grep above before editing, since exact line numbers shift as edits land).

**`src/bin/intel-command.ts`:** Delete `llmFor()` (`:65-73`). Add the import: `import { createLLMFromConfig } from '../enrichment/llm-factory.js';`. Its one call site (`:97`, `llm: llmFor(config),`) becomes `llm: createLLMFromConfig(config, stateDir),` — `stateDir` is already computed at `:85` in the same scope.

**`src/mcp/context.ts`:** Replace the inline ternary (`:42-48`):
```typescript
  const llm = createLLMFromConfig(config, stateDir);
```
Add the import, remove the now-unused `createBedrockClient`/`createNoopClient` imports if nothing else in the file uses them (check with `grep -n "createBedrockClient\|createNoopClient" src/mcp/context.ts` — if only this one call site used them, remove; otherwise leave).

**`src/hooks/dispatch.ts`:** Replace the inline ternary (`:54-60`) the same way:
```typescript
      const llm = createLLMFromConfig(config, stateDir);
```
Same import-cleanup check as above.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/enrichment/llm-factory.test.ts`
Expected: PASS

Then run the full suite to confirm the four call-site migrations didn't break anything:

Run: `pnpm test`
Expected: PASS (existing tests for `karpathy.ts`, `intel-command.ts`, `mcp/context.ts`, `hooks/dispatch.ts` behavior are unaffected — they exercise job-queue/CLI behavior, not the LLM-client internals, which is why this is a safe consolidation)

Run: `pnpm lint`
Expected: PASS (no unused imports left behind, no type errors)

- [ ] **Step 5: Commit**

```bash
git add src/enrichment/llm-factory.ts src/bin/karpathy.ts src/bin/intel-command.ts src/mcp/context.ts src/hooks/dispatch.ts test/enrichment/llm-factory.test.ts
git commit -m "fix(llm): consolidate 4 duplicated LLM-client factories into one; fixes litellm provider being silently ignored in intel-command/mcp/hooks"
```

---

### Task 6: Stuck-job Slack alert (`src/jobs/stuck-alert.ts`)

**Files:**
- Create: `src/jobs/stuck-alert.ts`
- Test: `test/jobs/stuck-alert.test.ts` (new file)

**Interfaces:**
- Consumes: `Job` type from `src/jobs/types.js` (Task 3's new fields: `transientSince`, `transientAlertSentAt`, `transientRetryCount`), `JobQueue.markAlerted` from Task 3, `KarpathyConfig['jobs']['transientRetry']['alertAfterMs']` and `KarpathyConfig['notifications']['slack']` from Task 1 (pre-existing `notifications.slack` schema, unchanged), `sendSlackNotification` from `src/intelligence/slack-notify.js` (pre-existing, unchanged).
- Produces: `checkStuckJobAlert(job: Job, config: KarpathyConfig, queue: JobQueue): Promise<void>` and `formatStuckJobAlert(job: Job, ageMs: number): string` — consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Create `test/jobs/stuck-alert.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobQueue } from '../../src/jobs/queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

vi.mock('../../src/intelligence/slack-notify.js', () => ({
  sendSlackNotification: vi.fn(async () => true),
}));

import { sendSlackNotification } from '../../src/intelligence/slack-notify.js';
import { checkStuckJobAlert, formatStuckJobAlert } from '../../src/jobs/stuck-alert.js';

describe('checkStuckJobAlert', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-stuck-alert-'));
    vi.clearAllMocks();
  });

  function configWithSlack(enabled: boolean, alertAfterMs = 3_600_000) {
    return KarpathyConfigSchema.parse({
      vaultPath: tempDir,
      notifications: { slack: { enabled, webhookUrl: 'https://example.com/webhook' } },
      jobs: { transientRetry: { alertAfterMs } },
    });
  }

  it('does not alert before the threshold', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    job.transientSince = new Date().toISOString();
    await checkStuckJobAlert(job, configWithSlack(true), queue);
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('does nothing when transientSince is unset (job has never failed transiently)', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    await checkStuckJobAlert(job, configWithSlack(true, 0), queue);
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('alerts exactly once after crossing the threshold', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    job.transientSince = new Date(Date.now() - 3_700_000).toISOString();
    const config = configWithSlack(true);

    await checkStuckJobAlert(job, config, queue);
    expect(sendSlackNotification).toHaveBeenCalledTimes(1);

    const [stamped] = await queue.list();
    await checkStuckJobAlert(stamped, config, queue);
    expect(sendSlackNotification).toHaveBeenCalledTimes(1); // still 1
  });

  it('never alerts when slack is disabled', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    job.transientSince = new Date(Date.now() - 3_700_000).toISOString();
    await checkStuckJobAlert(job, configWithSlack(false), queue);
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('formatStuckJobAlert includes type, id, retry count, and latest error', () => {
    const job = {
      id: 'abc123', type: 'summarize-source', transientRetryCount: 7, error: 'boom',
    } as Parameters<typeof formatStuckJobAlert>[0];
    const message = formatStuckJobAlert(job, 3_700_000);
    expect(message).toContain('summarize-source');
    expect(message).toContain('abc123');
    expect(message).toContain('7');
    expect(message).toContain('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/jobs/stuck-alert.test.ts`
Expected: FAIL — `src/jobs/stuck-alert.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/jobs/stuck-alert.ts`:

```typescript
import type { Job } from './types.js';
import type { JobQueue } from './queue.js';
import type { KarpathyConfig } from '../config/schema.js';
import { sendSlackNotification } from '../intelligence/slack-notify.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('stuck-alert');

export function formatStuckJobAlert(job: Job, ageMs: number): string {
  const ageMinutes = Math.round(ageMs / 60_000);
  return [
    `*Karpathy job stuck retrying* — ${job.type} (\`${job.id}\`)`,
    `First failed ${ageMinutes} min ago, ${job.transientRetryCount} transient retries so far.`,
    `Latest error: ${job.error ?? '(none recorded)'}`,
    `This will keep retrying indefinitely — cancel it manually if this looks like a dead credential rather than a network outage.`,
  ].join('\n');
}

export async function checkStuckJobAlert(job: Job, config: KarpathyConfig, queue: JobQueue): Promise<void> {
  if (!config.notifications.slack.enabled) return;
  if (!job.transientSince || job.transientAlertSentAt) return;

  const ageMs = Date.now() - Date.parse(job.transientSince);
  if (ageMs < config.jobs.transientRetry.alertAfterMs) return;

  const message = formatStuckJobAlert(job, ageMs);
  const sent = await sendSlackNotification(
    { webhookUrl: config.notifications.slack.webhookUrl ?? '', channel: config.notifications.slack.target },
    message,
  );
  if (sent) {
    await queue.markAlerted(job.id);
  } else {
    log.warn('Stuck-job Slack alert not sent (webhook missing or request failed)', { jobId: job.id });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/jobs/stuck-alert.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jobs/stuck-alert.ts test/jobs/stuck-alert.test.ts
git commit -m "feat(jobs): add one-shot Slack alert for stuck transient-retry streaks"
```

---

### Task 7: Wire transient classification + stuck-alert into `runner.ts` (final integration)

**Files:**
- Modify: `src/jobs/runner.ts`
- Test: `test/jobs/runner.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `TransientLLMError` from Task 2, `checkStuckJobAlert` from Task 6, `queue.fail(jobId, error, opts)` from Task 3.
- Produces: nothing new — this is the integration point where everything else becomes observable end-to-end from the job runner's perspective.

- [ ] **Step 1: Write the failing test**

Add to `test/jobs/runner.test.ts`. First add these imports at the top of the file, alongside the existing ones:

```typescript
import { TransientLLMError } from '../../src/shared/errors.js';

vi.mock('../../src/intelligence/slack-notify.js', () => ({
  sendSlackNotification: vi.fn(async () => true),
}));
import { sendSlackNotification } from '../../src/intelligence/slack-notify.js';
```

Then add a new test inside the existing `describe('JobRunner', ...)` block:

```typescript
  it('retries a TransientLLMError job indefinitely instead of marking it failed, and sends exactly one stuck-job alert', async () => {
    vi.useFakeTimers();
    try {
      vi.clearAllMocks();
      const queue = createJobQueue(join(tempDir, 'queue.json'));
      const lock = createFileLock(join(tempDir, 'locks'));

      const outageHandler: JobHandler = {
        async execute() {
          throw new TransientLLMError('simulated outage');
        },
      };
      const handlers = new Map<JobType, JobHandler>();
      handlers.set('rebuild-index', outageHandler);

      await queue.enqueue({ type: 'rebuild-index', maxRetries: 3 }); // old bounded ceiling — must not apply here

      const config = KarpathyConfigSchema.parse({
        vaultPath: tempDir,
        projectRoot: tempDir,
        notifications: { slack: { enabled: true, webhookUrl: 'https://example.com/webhook' } },
        jobs: { transientRetry: { alertAfterMs: 0, backoffCeilingMs: 60_000 } },
      });

      const runner = createJobRunner({
        queue, lock, handlers, vaultPath: tempDir, projectRoot: tempDir,
        llm: createNoopClient(), vault: createFsAdapter(tempDir), config,
      });

      // Fail 5 times in a row — well past the job's own maxRetries: 3.
      for (let i = 0; i < 5; i++) {
        await runner.runAll();
        vi.advanceTimersByTime(120_000);
      }

      const jobs = await queue.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('pending'); // never 'failed', unlike the bounded path
      expect(jobs[0].transientRetryCount).toBe(5);
      expect(jobs[0].retryCount).toBe(0); // untouched
      expect(sendSlackNotification).toHaveBeenCalledTimes(1); // one alert, not five
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/jobs/runner.test.ts`
Expected: FAIL — the job reaches `status: 'failed'` after 3 attempts (today's unconditional `queue.fail(job.id, message)` treats every error as non-transient), and `sendSlackNotification` is never called.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/runner.ts`, add imports at the top:

```typescript
import { TransientLLMError } from '../shared/errors.js';
import { checkStuckJobAlert } from './stuck-alert.js';
```

Replace `executeJob`'s catch block (`:119-122`):

```typescript
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = err instanceof TransientLLMError;
      log.error('Job failed', { id: job.id, type: job.type, error: message, transient });
      await queue.fail(job.id, message, {
        transient,
        backoffCeilingMs: options.config.jobs.transientRetry.backoffCeilingMs,
      });
      if (transient) {
        const all = await queue.list();
        const current = all.find((j) => j.id === job.id);
        if (current) await checkStuckJobAlert(current, options.config, queue);
      }
    }
```

The re-fetch-by-id after `queue.fail()` is necessary because `checkStuckJobAlert` needs the just-updated `transientSince`/`transientRetryCount`/`transientAlertSentAt`, not the stale in-memory `job` reference `executeJob` was called with — `queue.fail()` mutates the queue's own internal copy, not the caller's local variable. `queue.ts` has no `get(jobId)` accessor today, so this reuses the existing `list()` method rather than inventing a new one beyond what's needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/jobs/runner.test.ts`
Expected: PASS (both the new test and all pre-existing runner tests, including the existing "retries failed jobs after backoff delay" test which uses a plain `Error` and must still hit the bounded path unchanged)

Then run the full project verification:

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/jobs/runner.ts test/jobs/runner.test.ts
git commit -m "feat(jobs): wire transient classification and stuck-alert into the job runner"
```

---

## Post-plan manual verification (not automated — run once after all 7 tasks land)

With a real `~/.karpathy/config.json` set to `llm.provider: 'litellm'`:
1. Disconnect the VPN.
2. Trigger a job that calls the LLM (e.g. `karpathy intel tick` after enqueuing a `summarize-source` job, or any job type that reaches `context.llm`).
3. Confirm via `karpathy intel tick` output / logs that the job stays `pending` with a growing `retryAfter` instead of failing after 3 attempts.
4. Reconnect the VPN, run `karpathy intel tick` again, confirm the job completes.
5. If left disconnected past an hour with `notifications.slack.enabled: true`, confirm exactly one Slack message arrives.

This step is manual because it requires a real VPN and a real LiteLLM endpoint — it cannot be part of the automated test suite, and is the acceptance criterion the whole design spec was written to satisfy.

---

## Addendum: Task 8 — Propagate `TransientLLMError` through the real job handlers

**Added after the final whole-branch review of Tasks 1-7** (which were approved and merged into this branch as designed). That review found a Critical gap invisible to any single task's diff: none of Tasks 1-7 touch the pre-existing enrichment/handler layer, and every real LLM-calling job handler catches the LLM error and converts or swallows it before `runner.ts`'s `err instanceof TransientLLMError` check (`src/jobs/runner.ts:123`) ever sees it. Concretely, of the job types that call an LLM, only `research-execute` and `tldr-update` propagate a raw thrown error today — `summarize-source`, `summarize-meeting`, `extract-entities`, `extract-entities-rich`, `compile-entities`, `topic-refresh`, and `generate-synthesis-skills` all still behave as if Tasks 1-7 don't exist during an outage. `compile-entities` and `generate-synthesis-skills` are the worst cases: they swallow the failure and return/complete normally, so the job is marked `completed` having silently done nothing, with no retry at all.

This addendum fixes that, without changing any of Tasks 1-7's already-reviewed code.

### Task 8: Propagate transient-error identity through `EnrichmentResult` and every real handler

**Files:**
- Modify: `src/enrichment/types.ts`
- Modify: `src/enrichment/summarizer.ts`
- Modify: `src/enrichment/entity-extractor.ts`
- Modify: `src/enrichment/entity-extractor-rich.ts`
- Modify: `src/enrichment/concept-linker.ts`
- Modify: `src/jobs/handlers/summarize-source.ts`
- Modify: `src/jobs/handlers/summarize-meeting.ts`
- Modify: `src/jobs/handlers/extract-entities.ts`
- Modify: `src/intelligence/topic-refresh.ts`
- Modify: `src/compilation/compiler.ts`
- Modify: `src/jobs/handlers/generate-synthesis-skills.ts`
- Test: `test/enrichment/summarizer.test.ts`, `test/enrichment/entity-extractor.test.ts`, `test/enrichment/entity-extractor-rich.test.ts`, `test/jobs/handlers/summarize-source.test.ts`, `test/jobs/handlers/summarize-meeting.test.ts`, `test/jobs/handlers/extract-entities.test.ts`, `test/intelligence/topic-refresh.test.ts`, `test/compilation/compiler.test.ts`, `test/jobs/handlers/generate-synthesis-skills.test.ts` (extend whichever of these already exist; create only if a file genuinely has none today — check first)

**Interfaces:**
- Consumes: `TransientLLMError` from `src/shared/errors.ts` (Task 2, already merged).
- Produces: nothing new consumed by other tasks — this is the last task in the plan. The observable contract change: every one of the seven handlers named above now throws the *original* `TransientLLMError` instance (not a re-wrapped plain `Error`) when the underlying LLM call failed transiently, so `runner.ts`'s existing `err instanceof TransientLLMError` check (already correct, untouched) actually fires for real production jobs.

**Design, one paragraph:** `EnrichmentResult<T>`'s error variant gains an optional `transient?: boolean` flag. Every function that currently does `return { status: 'error', error: (err as Error).message }` inside a `catch (err)` block changes to also set `transient: err instanceof TransientLLMError`. Callers that currently do `if (result.status === 'error') throw new Error(...)` change to check that flag and, when true, throw the *original* `err` object (not a new one) — every one of these call sites already has `err` in scope from its own `catch`, OR needs a small restructure to keep the original error in scope through to the throw (shown per-file below). Two files (`compiler.ts`'s per-entity loop, `generate-synthesis-skills.ts`) don't go through `EnrichmentResult` at all — they catch directly around an `llm.complete`/pipeline call and swallow-and-continue; those get a direct `if (err instanceof TransientLLMError) throw err;` guard before their existing swallow logic, so a real outage aborts the whole job (to be retried in full by the indefinite-retry lane) instead of silently skipping every remaining entity/skill one by one.

**Per-file changes:**

#### `src/enrichment/types.ts`

```typescript
/** Discriminated union for enrichment function results.
 *  Allows callers to distinguish "no data found" from "extraction failed". */
export type EnrichmentResult<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; error: string; transient?: boolean };
```

#### `src/enrichment/summarizer.ts`

Add the import: `import { TransientLLMError } from '../shared/errors.js';`

All four outer `catch (err)` blocks (in `summarizeSource`, `summarizeMeetingSource`, `summarizeMeetingChunks`, `summarizeChunks`) change from:
```typescript
  } catch (err) {
    log.error('Summarization failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
```
to (same pattern, all four functions, only the log message text differs per function — keep each function's existing log message text unchanged):
```typescript
  } catch (err) {
    log.error('Summarization failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message, transient: err instanceof TransientLLMError };
  }
```
The **inner per-chunk** `catch` blocks in `summarizeMeetingChunks`/`summarizeChunks` (the ones that push a placeholder brief/summary and continue the loop) are **unchanged** — during a real outage the subsequent synthesis call (`synthesizeSummariesPrompt`/`synthesizeMeetingSummariesPrompt`) will itself throw transiently and be caught by the outer catch above, so the transient signal still surfaces correctly without touching the resilient per-chunk fallback.

#### `src/enrichment/entity-extractor.ts` and `src/enrichment/entity-extractor-rich.ts` (identical shape, apply to both)

Add the import: `import { TransientLLMError } from '../shared/errors.js';`

The single-text functions (`extractEntities`/`extractEntitiesRich`) get the same one-line addition as summarizer.ts's pattern:
```typescript
  } catch (err) {
    log.error('Entity extraction failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message, transient: err instanceof TransientLLMError };
  }
```

The chunked functions (`extractEntitiesFromChunks`/`extractEntitiesRichFromChunks`) need more than the outer-catch fix: unlike summarizer.ts, there is **no LLM call after the per-chunk loop** (the loop is followed only by a local, non-LLM merge), so if every chunk fails transiently, the per-chunk catch swallows all of them and the function returns a hollow `{ status: 'success', data: <empty-merged-entities> }` — silently reporting success with no data during an outage. Fix by tracking transient failures across the loop and escalating:

```typescript
  try {
    // Extract from each chunk
    const perChunk: Array<{ chunkId: string; entities: ExtractedEntities }> = [];
    let anyTransientFailure = false;

    for (const chunk of chunks) {
      try {
        const parsed = await llm.extractStructured(
          extractEntitiesChunkPrompt(chunk.content, chunk.chunkId, chunk.headingContext),
          ExtractedEntitiesSchema,
        );
        perChunk.push({ chunkId: chunk.chunkId, entities: tagChunkRefs(parsed, chunk.chunkId) });
      } catch (err) {
        if (err instanceof TransientLLMError) anyTransientFailure = true;
        log.warn('Chunk entity extraction failed', { chunkId: chunk.chunkId, error: (err as Error).message });
      }
    }

    if (anyTransientFailure) {
      return { status: 'error', error: 'One or more chunks failed with a transient (network/outage) error', transient: true };
    }

    // Merge results across chunks
    return { status: 'success', data: mergeExtractedEntities(perChunk.map((pc) => pc.entities)) };
  } catch (err) {
    log.error('Chunked entity extraction failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message, transient: err instanceof TransientLLMError };
  }
```
(For `entity-extractor-rich.ts`, apply the identical structure with its own type names — `RichExtractedEntities`, `mergeRichExtractedEntities`, `tagChunkRefs`, `extractEntitiesRichChunkPrompt`, `RichExtractedEntitiesSchema` — and its own existing log message text.)

Any per-chunk failure that is NOT transient (a genuine bad-output/extraction problem on one chunk) still falls back to the existing placeholder-and-continue behavior — only network/outage-classified chunk failures escalate to aborting the whole extraction with `transient: true`.

#### `src/enrichment/concept-linker.ts`

`findConceptLinks` currently has **zero callers anywhere in the codebase** (confirmed via `grep -rln "findConceptLinks" src/` — only the definition file itself matches). No handler needs fixing for this one. For consistency with the shared `EnrichmentResult` type (so a future caller doesn't inherit a silently-incomplete pattern), add the same one-line change to its catch:
```typescript
import { TransientLLMError } from '../shared/errors.js';
// ...
  } catch (err) {
    log.error('Concept linking failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message, transient: err instanceof TransientLLMError };
  }
```

#### `src/jobs/handlers/summarize-source.ts`

Add the import: `import { TransientLLMError } from '../../shared/errors.js';`

Change:
```typescript
    if (summaryResult.status === 'error') throw new Error(`Summarization failed: ${summaryResult.error}`);
```
to:
```typescript
    if (summaryResult.status === 'error') {
      if (summaryResult.transient) throw new TransientLLMError(`Summarization failed: ${summaryResult.error}`);
      throw new Error(`Summarization failed: ${summaryResult.error}`);
    }
```

#### `src/jobs/handlers/summarize-meeting.ts`

Same pattern, applied to its own error line:
```typescript
    if (briefResult.status === 'error') {
      if (briefResult.transient) throw new TransientLLMError(`Meeting summarization failed: ${briefResult.error}`);
      throw new Error(`Meeting summarization failed: ${briefResult.error}`);
    }
```
Add the same import (adjust the relative path to `../../shared/errors.js` if this file lives at the same directory depth as `summarize-source.ts` — verify by checking the file's existing import paths for sibling modules).

#### `src/jobs/handlers/extract-entities.ts`

Add the import: `import { TransientLLMError } from '../../shared/errors.js';`

Both error sites (non-rich around line 42, rich around line 177) get the same pattern:
```typescript
    if (extractResult.status === 'error') {
      if (extractResult.transient) throw new TransientLLMError(`Entity extraction failed: ${extractResult.error}`);
      throw new Error(`Entity extraction failed: ${extractResult.error}`);
    }
```
```typescript
    if (richResult.status === 'error') {
      if (richResult.transient) throw new TransientLLMError(`Rich entity extraction failed: ${richResult.error}`);
      throw new Error(`Rich entity extraction failed: ${richResult.error}`);
    }
```

#### `src/intelligence/topic-refresh.ts`

Add the import (check the file's existing imports for the correct relative path to `src/shared/errors.js` from `src/intelligence/`): `import { TransientLLMError } from '../shared/errors.js';`

Change the synthesis catch (currently, confirmed exact location, line 159):
```typescript
  let synthesis;
  try {
    synthesis = await deps.llm.extractStructured(prompt, SynthesisSchema);
  } catch (err) {
    // Bail without modifying the note.
    throw new Error(`topic synthesis failed for ${notePath}: ${(err as Error).message}`);
  }
```
to:
```typescript
  let synthesis;
  try {
    synthesis = await deps.llm.extractStructured(prompt, SynthesisSchema);
  } catch (err) {
    // Bail without modifying the note. Preserve TransientLLMError identity so
    // the job runner's indefinite-retry lane actually sees it (see Task 8).
    if (err instanceof TransientLLMError) throw err;
    throw new Error(`topic synthesis failed for ${notePath}: ${(err as Error).message}`);
  }
```

#### `src/compilation/compiler.ts`

Add the import (check existing import paths from `src/compilation/` to `src/shared/`): `import { TransientLLMError } from '../shared/errors.js';`

Change the per-entity catch inside `compileFromSource`'s loop (currently swallows unconditionally):
```typescript
    } catch (err) {
      log.error('Failed to compile entity page', {
        name: entity.name,
        path: existingPagePath,
        error: (err as Error).message,
      });
      result.skipped.push(entity.name);
    }
```
to:
```typescript
    } catch (err) {
      if (err instanceof TransientLLMError) throw err; // abort the whole job — every remaining entity would fail the same way during a real outage; the runner retries the full job.
      log.error('Failed to compile entity page', {
        name: entity.name,
        path: existingPagePath,
        error: (err as Error).message,
      });
      result.skipped.push(entity.name);
    }
```
This means `compileFromSource` can now throw for the first time (previously it never did). Its caller, `src/jobs/handlers/compile-entities.ts:154`, already calls it as `const result = await compileFromSource(...)` with no surrounding try/catch of its own — an uncaught throw here propagates naturally up through the handler's `execute()` to `runner.ts`'s existing catch block, exactly as intended. No change needed in `compile-entities.ts` itself.

#### `src/jobs/handlers/generate-synthesis-skills.ts`

Add the import: `import { TransientLLMError } from '../../shared/errors.js';`

Change the outer catch (currently swallows unconditionally, logs, and falls off the end of `execute`):
```typescript
    } catch (err) {
      log.error('Failed to generate skills', { error: (err as Error).message });
    }
```
to:
```typescript
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      log.error('Failed to generate skills', { error: (err as Error).message });
    }
```

### Testing plan

For each modified `EnrichmentResult`-returning function (`summarizer.ts`'s four functions, `entity-extractor.ts`/`entity-extractor-rich.ts`'s four functions, `concept-linker.ts`'s one function): a test that makes the mocked/fake `LLMClient` throw a `TransientLLMError` and asserts the returned `EnrichmentResult` has `transient: true`; and a test that throws a plain `Error` and asserts `transient` is `false`/`undefined`. For the two chunked entity-extractor functions specifically: a test where one chunk throws `TransientLLMError` and the rest succeed, asserting the whole function returns `{ status: 'error', transient: true }` rather than a partial success.

For each modified handler (`summarize-source.ts`, `summarize-meeting.ts`, `extract-entities.ts` both branches, `generate-synthesis-skills.ts`): a test where the underlying enrichment call is mocked to return/throw a `TransientLLMError`-flagged result, asserting the handler's `execute()` rejects with an error that is `instanceof TransientLLMError` (not a plain `Error`).

For `topic-refresh.ts`: a test where `deps.llm.extractStructured` throws `TransientLLMError`, asserting `refreshTopic` rejects with that same `TransientLLMError` (identity-preserving, not just message-similar — assert `instanceof`), and a separate test with a plain `Error` asserting the existing wrapped-message behavior (`topic synthesis failed for ...`) is unchanged.

For `compiler.ts`: a test where `compileEntityPage` throws `TransientLLMError` for one entity, asserting `compileFromSource` rejects (propagates the `TransientLLMError`) instead of returning normally with that entity in `result.skipped`; and a regression test that a plain `Error` on one entity still results in that entity being skipped and the function returning normally (existing behavior, must be unchanged).

Regression requirement across every file above: existing tests for the non-transient/plain-`Error` paths must continue to pass unmodified in behavior — this task only adds a new branch, it does not change what happens for errors that were never network/outage-related.

### Manual verification

Not required beyond the automated tests above — this task has no new configuration surface or state file; its only externally-observable effect is that `runner.ts`'s existing `instanceof TransientLLMError` check (already covered by Task 7's end-to-end test) now actually receives a `TransientLLMError` from real job handlers instead of always seeing a plain `Error`.

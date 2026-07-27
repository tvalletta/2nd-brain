# Design: VPN-Aware Retry for LLM-Calling Jobs

**Status:** Approved for spec write-up (design conversation complete 2026-07-27)
**Scope:** Foundational infrastructure sub-project, prerequisite-ish for the in-progress B2a sub-project (review-note explanatory content generation via LiteLLM). Not itself part of B2a's spec.

## 0. Context

Karpathy's job queue (`src/jobs/queue.ts`) already has real exponential-backoff-with-jitter retry logic in `fail()` (`:95-115`), but `maxRetries` defaults to 3 (`src/jobs/types.ts:66`), giving roughly 7 seconds of total retry window (1s, 2s, 4s + jitter) before a job is marked permanently `'failed'`. The user's LiteLLM proxy access depends on a VPN connection that disconnects intermittently, for minutes to hours at a time. Today, any LLM-calling job that happens to run during an outage exhausts its 3 retries in seconds and is discarded — the job is lost, not resumed.

While investigating this (and separately confirming, via live testing, that Haiku-quality output is acceptable for B2a's review-note generation — see the prior conversation's Q1 answer), a second, more fundamental gap was found:

**`src/bin/intel-command.ts`'s `llmFor()` (:66-73) — the LLM-client factory used by `karpathy intel tick`, the actual job-runner entrypoint wired to cron/launchd — never wires up the LiteLLM provider at all.** It branches only on `config.llm.provider === 'bedrock'`; any other value (including `'litellm'`, the newly-chosen default) falls through to `createNoopClient()`, whose `.complete()` silently returns `''` and whose `.extractStructured()` throws a plain, permanent-looking error with no network involved. The same incomplete pattern is duplicated in `src/mcp/context.ts:42-48` and `src/hooks/dispatch.ts:54-60`. Both also omit `config.llm.bearerToken` when constructing `createBedrockClient`, so even their Bedrock path silently falls back to the slower IAM/SDK route instead of the working bearer-token route. Only `src/bin/karpathy.ts`'s `createLLMFromConfig()` (:61-84) is complete and correct today.

Net effect: without fixing this, none of the retry/backoff work below would matter for real background jobs — `intel tick` would never attempt a real LiteLLM call in the first place.

This spec covers both: consolidating LLM-client construction into one correct, shared factory, and building a VPN-outage-tolerant retry path on top of it. It does **not** cover B2a's actual review-note prompts/content (separate spec) or any change to which provider/model is used for which task (already decided: LiteLLM default, Haiku fast-tier / Sonnet fallback, per the prior conversation).

## 1. Goals / Non-Goals

**Goals:**
- One shared LLM-client factory, used by all four existing call sites, so `litellm` is wired correctly everywhere and there is exactly one place to get this right instead of four.
- A job that fails due to a genuine outage (VPN down, proxy unreachable, rate-limited, upstream 5xx) retries indefinitely with a capped backoff, and is never lost or marked permanently failed for that reason.
- A job that fails for a real, non-network reason (bad model ID, malformed request, malformed LLM output) keeps today's fast, bounded 3-try behavior — indefinite retry only applies to the transient class.
- A per-provider connectivity cache lets one job's real failed attempt protect other pending jobs from also wasting a call during the same outage window, without introducing a second source of truth for retry state.
- If a transient-retry streak runs past 1 hour, exactly one Slack notification fires so a genuinely dead credential (which — per an explicit product decision — is now also classified as transient, see §2) doesn't retry forever silently.
- All of the above survives a cold process restart with no new persistence code beyond plain JSON state files, because `karpathy intel tick` already runs as a fresh, disk-loaded process on every invocation — there is no long-lived daemon holding retry state in memory to begin with.

**Non-goals:**
- B2a's actual review-note-generation prompts, budget-tier wiring for that specific feature, or its four call sites (contradiction/duplicate/ambiguous-entity/uncertain-drop detectors) — separate spec.
- The Bedrock IAM/SDK code path (`createBedrockClient`'s non-bearer-token branch, `llm-client.ts:169-244`) — not in active use (the user authenticates via bearer token retrieved from Control Center), left as-is.
- Any change to embedding providers (`src/embeddings/`) — Ollama is local (no VPN dependency) and `bedrock-titan` is out of scope for this pass; can be revisited later using the same `TransientLLMError` pattern if it turns out to need it.
- Changing `config.llm.provider`'s default or re-litigating LiteLLM-vs-Bedrock as the default (already decided).

## 2. Architecture Overview

```
src/enrichment/llm-factory.ts (NEW — Component 1)
  createLLMFromConfig(config) → LLMClient
    │
    ├─ builds the real client (createBedrockBearerClient / createBedrockClient /
    │  createLiteLLMClient / createNoopClient — unchanged from llm-client.ts)
    │
    └─ wraps it with withConnectivityProbe(client, providerId, config)  (Component 5)
         — checks/updates .karpathy/state/connectivity-probe.json before/after
           every real call

src/bin/karpathy.ts, src/bin/intel-command.ts, src/mcp/context.ts,
src/hooks/dispatch.ts
  — all four now call createLLMFromConfig(config) instead of their own
    hand-rolled (and in 3/4 cases incomplete) branching.

src/enrichment/llm-client.ts (Component 2 — modified)
  createBedrockBearerClient() / createLiteLLMClient()'s call() functions
    — throw TransientLLMError (new, src/shared/errors.ts) instead of a plain
      Error when the failure looks like an outage, rate-limit, or auth
      rejection; unchanged plain Error/ExtractionError otherwise.

src/jobs/types.ts, src/jobs/queue.ts, src/jobs/runner.ts (Component 3/4)
  Job.transientRetryCount / Job.transientSince (new fields)
  queue.fail(jobId, error, { transient? })
    — transient:true grows a separate, uncapped counter with capped backoff;
      never touches retryCount/maxRetries; job never becomes 'failed' for
      this reason.
  runner.ts's catch block passes `err instanceof TransientLLMError` straight
      through as the transient flag — no string-matching.

src/jobs/stuck-alert.ts (NEW — Component 6)
  checkStuckJobAlert(job, config) — called from runner.ts right after a
      transient queue.fail(); sends one Slack message per streak once
      transientSince crosses the configured threshold.
```

Three independent mechanisms, composed rather than tangled:
1. **Classification** (Component 2) decides transient-vs-permanent per failure, once, at the point closest to the actual HTTP call.
2. **Retry bookkeeping** (Components 3/4) is pure `Job`-state, persisted by the exact same `flush()`/`load()` round-trip that already exists — no new persistence mechanism.
3. **The connectivity cache** (Component 5) is a cross-job optimization layered on top of Component 2's classification; it can only ever produce the same synthetic `TransientLLMError` a real call would have thrown, so it can't introduce a disagreement with Components 3/4.

## 3. Component 1 — Shared LLM-client factory

**New file:** `src/enrichment/llm-factory.ts`

```typescript
import { createBedrockClient, createLiteLLMClient, createNoopClient, type LLMClient } from './llm-client.js';
import { withConnectivityProbe } from './connectivity-probe.js';
import type { KarpathyConfig } from '../config/schema.js';

export function createLLMFromConfig(config: KarpathyConfig, stateDir: string): LLMClient {
  let client: LLMClient;
  let providerId: string;

  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    client = createLiteLLMClient({ baseUrl, apiKey, model: config.llm.model, maxTokens: config.llm.maxTokens });
    providerId = 'litellm';
  } else if (config.llm.provider === 'bedrock') {
    client = createBedrockClient({
      region: config.llm.region,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
    providerId = 'bedrock';
  } else {
    return createNoopClient();
  }

  return withConnectivityProbe(client, providerId, config, stateDir);
}
```

This is `karpathy.ts`'s existing `createLLMFromConfig` (:61-84), moved and given one addition: the `withConnectivityProbe` wrap, and a `stateDir` parameter (all four call sites already compute `stateDir`/`resolveStateDir(config)` for their job queue, so this is not a new value to thread through — see call-site diffs below). `bearerToken` is now passed to `createBedrockClient` unconditionally, fixing the silent-IAM-fallback bug in the two call sites that previously omitted it.

**Call-site changes** (all four are one-line swaps of an inline factory for a single import + call):
- `src/bin/karpathy.ts` — delete the local `createLLMFromConfig` function (:61-84), import the shared one instead.
- `src/bin/intel-command.ts` — delete `llmFor()` (:66-73), replace its one call site with `createLLMFromConfig(config, stateDir)` (`stateDir` already computed at :254).
- `src/mcp/context.ts` — replace the inline ternary (:42-48) with `createLLMFromConfig(config, stateDir)`.
- `src/hooks/dispatch.ts` — replace the inline ternary (:54-60) with `createLLMFromConfig(config, stateDir)`.

**Test additions:** `test/enrichment/llm-factory.test.ts` — for each of `bedrock` / `litellm` / unset provider, assert the correct underlying client constructor is invoked (via module mock) and that `bearerToken` is forwarded for `bedrock`. A regression test asserting all four call sites import from `llm-factory.ts` (grep-based, similar in spirit to existing "no other call sites" grounding checks in this repo's specs) is optional polish, not required.

## 4. Component 2 — Transient error classification

**File:** `src/shared/errors.ts` — add:

```typescript
export class TransientLLMError extends KarpathyError {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message, 'LLM_TRANSIENT_ERROR');
    this.name = 'TransientLLMError';
  }
}
```

**File:** `src/enrichment/llm-client.ts` — both `createBedrockBearerClient`'s `call()` (:120-142) and `createLiteLLMClient`'s `call()` (:255-278) change their failure branches from:

```typescript
if (!res.ok) {
  const errText = await res.text().catch(() => res.statusText);
  throw new Error(`Bedrock Bearer request failed (${res.status}): ${errText}`);
}
```

to:

```typescript
if (!res.ok) {
  const errText = await res.text().catch(() => res.statusText);
  const message = `Bedrock Bearer request failed (${res.status}): ${errText}`;
  if (TRANSIENT_STATUS_CODES.has(res.status)) {
    throw new TransientLLMError(message, res.status);
  }
  throw new Error(message);
}
```

with `TRANSIENT_STATUS_CODES = new Set([401, 403, 429, 500, 502, 503, 504])` module-level in `llm-client.ts`. `400`/`404` (bad request, unknown model) and any other unrecognized status fall through to the existing plain `Error` — permanent, fast-fail, per the explicit decision that unclassified failures default to permanent rather than risk an unrecognized error retrying forever.

The `fetch()` call itself (network-level failure — DNS, timeout, connection refused, no HTTP response at all) is wrapped:

```typescript
let res: Response;
try {
  res = await fetch(endpoint, { /* ...unchanged... */ });
} catch (err) {
  throw new TransientLLMError(`Network error calling ${endpoint}: ${(err as Error).message}`);
}
```

`ExtractionError` (thrown from `extractStructured()`'s JSON-parse-failure branch, both clients, unchanged) is **not** touched — a malformed LLM response is a content problem, not a connectivity problem, and keeps the existing fast/bounded retry behavior.

The SDK-based branch of `createBedrockClient` (:169-244, only reached when no bearer token is configured) is left unmodified per §1's non-goals — the AWS SDK throws its own typed exceptions with a different shape (`$metadata.httpStatusCode`), and this path isn't in active use today.

**Test additions:** `test/enrichment/llm-client.test.ts` — mock `fetch` for each of: throws (network), 401, 403, 429, 500, 502, 503, 504 (all → `TransientLLMError`); 400, 404, and one unrecognized status e.g. 418 (all → plain `Error`). Assert `err.httpStatus` is set correctly when present.

## 5. Component 3 — Job schema: a second, uncapped retry lane

**File:** `src/jobs/types.ts` — `JobSchema` (:53-71) gains:

```typescript
transientRetryCount: z.number().int().default(0),
transientSince: z.string().optional(), // ISO timestamp of first failure in the current unbroken transient streak
transientAlertSentAt: z.string().optional(), // set once Component 6 has sent a streak's one alert
```

These are independent of the existing `retryCount`/`maxRetries` — a job accumulates whichever counter matches how it's currently failing, and the two never interact.

**File:** `src/jobs/queue.ts` — `fail()`'s signature (:16, interface; :95-115, implementation) changes to:

```typescript
fail(jobId: string, error: string, opts?: { transient?: boolean }): Promise<void>
```

New branch, checked before the existing `retryCount < maxRetries` logic:

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
    const CEILING_MS = /* from config, see §7 */ 1_800_000;
    const baseDelay = Math.min(1000 * Math.pow(2, job.transientRetryCount - 1), CEILING_MS);
    const jitter = Math.random() * baseDelay * 0.25;
    job.retryAfter = Date.now() + baseDelay + jitter;
    log.warn('Job failed transiently, retrying indefinitely', {
      id: jobId, transientRetry: job.transientRetryCount, retryAfter: job.retryAfter,
    });
    return;
  }

  // ...existing retryCount/maxRetries logic, unchanged...
}
```

A transiently-failing job never reaches `status = 'failed'` — this is deliberate, matching the explicit decision that transient failures (including 401/403, now always classified transient — see §4) retry until the outage clears or the user cancels the job via the existing `cancel()` path. `cancel()` itself is unchanged; it remains the only way to stop a stuck transient job short of it succeeding.

**File:** `src/jobs/runner.ts` — `executeJob`'s catch block (:119-122) becomes:

```typescript
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const transient = err instanceof TransientLLMError;
  log.error('Job failed', { id: job.id, type: job.type, error: message, transient });
  await queue.fail(job.id, message, { transient });
  if (transient) await checkStuckJobAlert(job, options.config, queue); // Component 6
}
```

No changes needed to `nextReady()` (`queue.ts:37-51`) — it already respects `retryAfter` regardless of which counter produced it, and a `'pending'` job with a far-future `retryAfter` is correctly skipped until due, exactly as today.

**Test additions:** `test/jobs/queue.test.ts` — transient failures never reach `'failed'` even after 100+ calls to `fail(..., {transient: true})`; `retryCount` stays at 0 throughout; backoff caps at `CEILING_MS` and holds there; a non-transient failure on a job that previously failed transiently still respects its own independent `retryCount`/`maxRetries`.

## 6. Component 4 — Backoff ceiling

Already shown inline in §5 (`Math.min(1000 * 2^(transientRetryCount-1), CEILING_MS)`). Growth: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, then hits the 30-minute default ceiling on the 12th failure (~17 minutes of elapsed retrying) and holds there ± the same 0-25% jitter the existing formula already applies — a steady heartbeat re-checking connectivity roughly every half hour without hammering the endpoint.

## 7. Component 5 — Connectivity probe cache

**New file:** `src/enrichment/connectivity-probe.ts`, modeled directly on `src/shared/budget.ts`'s existing pattern (sync fs, JSON state file under `.karpathy/state/`, factory function returning a narrow interface):

```typescript
export interface ProbeState {
  reachable: boolean;
  checkedAt: string; // ISO
  error?: string;
}

export interface ConnectivityProbe {
  shouldSkip(providerId: string): boolean;
  recordOutcome(providerId: string, ok: boolean, error?: string): void;
}

export function createConnectivityProbe(stateDir: string, trustWindowMs: number): ConnectivityProbe {
  const filePath = join(stateDir, 'connectivity-probe.json');
  // load-on-first-use, write-through on recordOutcome — same idiom as budget.ts
  // shouldSkip(providerId): entry exists, reachable === false, and
  //   (Date.now() - Date.parse(entry.checkedAt)) < trustWindowMs
  // recordOutcome: overwrites the provider's entry with {reachable, checkedAt: nowISO(), error}
}
```

`withConnectivityProbe(client, providerId, config, stateDir)` (also in this file) wraps an `LLMClient`:

```typescript
export function withConnectivityProbe(client: LLMClient, providerId: string, config: KarpathyConfig, stateDir: string): LLMClient {
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

Keyed per-provider (`'bedrock'` / `'litellm'`) deliberately — the user's Bedrock bearer-token path has no VPN dependency, so a LiteLLM outage must not make Bedrock-backed jobs skip too. Only ever produces a `TransientLLMError` (never a permanent one), so it cannot make a job fail differently than an equivalent real attempt would have — it only changes *whether a real HTTP call is made*, not what a failure means. A stale `reachable: false` entry (older than the trust window) is not trusted; the next call attempts for real and refreshes the cache either way, which is also how recovery is detected — no separate polling loop.

**Test additions:** `test/enrichment/connectivity-probe.test.ts` — `shouldSkip` true within the trust window after a recorded failure, false once the window elapses; `recordOutcome(true)` clears a prior failure entry; `withConnectivityProbe` short-circuits the wrapped client (never calls through) when skip applies, and forwards/records real outcomes otherwise.

## 8. Component 6 — Stuck-job Slack alert

**New file:** `src/jobs/stuck-alert.ts`

```typescript
export async function checkStuckJobAlert(job: Job, config: KarpathyConfig, queue: JobQueue): Promise<void> {
  if (!config.notifications.slack.enabled || !job.transientSince || job.transientAlertSentAt) return;
  const ageMs = Date.now() - Date.parse(job.transientSince);
  if (ageMs < config.jobs.transientRetry.alertAfterMs) return;

  const message = formatStuckJobAlert(job, ageMs);
  const sent = await sendSlackNotification(
    { webhookUrl: config.notifications.slack.webhookUrl ?? '', channel: config.notifications.slack.target },
    message,
  );
  if (sent) await queue.markAlerted(job.id); // new small queue method, sets transientAlertSentAt = nowISO()
}
```

`formatStuckJobAlert` (small formatter in the same file, mirroring `slack-notify.ts`'s existing `formatQueueDigest`) includes job type, job id, first-failure time, current `transientRetryCount`, and the latest error text — enough to decide "let it ride" versus "this is a dead credential, cancel it."

Fires **exactly once per unbroken streak** (per the explicit decision against a repeating reminder): the `transientAlertSentAt` field, once set, suppresses further alerts for this job until it either succeeds (streak ends, though the field is never explicitly cleared since a completed job is terminal and never re-read) or is cancelled. A *new* streak on a *different* job (or the same job type re-enqueued fresh after completion) starts with `transientAlertSentAt` unset and can alert again independently.

**Test additions:** `test/jobs/stuck-alert.test.ts` — no alert before `alertAfterMs`; exactly one alert once crossed; no second alert on a subsequent check of the same job; `notifications.slack.enabled: false` suppresses entirely regardless of age.

## 9. Config schema changes

**File:** `src/config/schema.ts` — new top-level section:

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

Wired into `KarpathyConfigSchema` the same way `NotificationsConfigSchema`/`EnrichmentConfigSchema` already are (`jobs: JobsConfigSchema.default({})`), plus the corresponding `Partial...` entries used by the `defaults`/`projects`-override merge (mirroring the existing pattern at schema.ts:303,321,340 for `llm`). All-default Zod schema, so existing installs need no config changes.

No changes to `LLMConfigSchema` — `provider`/`baseUrl`/`apiKey`/`bearerToken`/`model` all already exist and are unchanged by this spec.

## 10. Data model / frontmatter

No wiki frontmatter changes — this spec is entirely within `.karpathy/state/` (job queue) and in-memory job execution. No vault-visible notes are created or modified by this work. The two new state files:
- `.karpathy/state/connectivity-probe.json` — ephemeral cache, safe to delete at any time (worst case: one extra real HTTP attempt after deletion).
- `job-queue.json` — schema-extended in place (three new optional/defaulted fields on `Job`); existing entries parse unchanged via `JobSchema.safeParse`'s existing defaulting behavior in `queue.load()` (:159-164).

## 11. Decision tables

**Error classification:**

| Failure | Classification | Retry behavior |
|---|---|---|
| `fetch()` throws (DNS/timeout/connection refused) | `TransientLLMError` | Indefinite, capped backoff |
| HTTP 401 / 403 | `TransientLLMError` (always — explicit decision) | Indefinite, capped backoff |
| HTTP 429 | `TransientLLMError` | Indefinite, capped backoff |
| HTTP 500 / 502 / 503 / 504 | `TransientLLMError` | Indefinite, capped backoff |
| HTTP 400 / 404 | plain `Error` | Existing 3-try bounded path |
| Any other/unrecognized status | plain `Error` (default-permanent) | Existing 3-try bounded path |
| `ExtractionError` (malformed LLM JSON output) | unchanged | Existing 3-try bounded path |
| Connectivity-probe skip | synthetic `TransientLLMError` | Same as a real transient failure |

**Alerting:**

| Condition | Outcome |
|---|---|
| `transientSince` age < `alertAfterMs` | No alert |
| Age ≥ `alertAfterMs`, `transientAlertSentAt` unset, Slack enabled | One alert sent, `transientAlertSentAt` stamped |
| Age ≥ `alertAfterMs`, `transientAlertSentAt` already set | No further alert (one-per-streak) |
| `notifications.slack.enabled === false` | Never alerts, regardless of age |

## 12. Observability

New `log.md` entry, following the existing one-line-per-run convention (matching `research:propose`/`topic:refresh` style already in the codebase):
- `**job:transient-retry** — {type} ({id}) attempt {transientRetryCount}, next retry in {delay}ms: {error}` — logged at `log.warn` level via the existing `createLogger('queue')`, not necessarily appended to vault `log.md` (this is process-log noise, not curated vault content) — confirm during implementation whether existing `log.warn` calls in `queue.ts` already go to a file the user can tail; if not, this is a good candidate to add.

No new log.md vault entries are required by this spec — it's infrastructure, not curated content.

## 13. Testing plan

Covered inline per-component in §3-§8. Summary:
- `llm-factory.test.ts` — correct client + probe-wrap per provider, bearer-token forwarding.
- `llm-client.test.ts` — classification matrix (network throw / 401 / 403 / 429 / 5xx → transient; 400/404/unknown → permanent).
- `queue.test.ts` — transient lane never reaches `'failed'`, independent of `retryCount`; backoff caps correctly.
- `connectivity-probe.test.ts` — skip/trust-window/recovery behavior, per-provider isolation.
- `stuck-alert.test.ts` — one-per-streak alert timing and Slack-enabled gating.
- **Regression:** existing `queue.test.ts`/`runner.test.ts` non-transient-path tests continue passing unmodified (transient is purely additive — `opts.transient` defaults to falsy, preserving today's exact `fail()` behavior when omitted).
- **Manual end-to-end (post-build, before considering this done):** with `llm.provider: 'litellm'` configured, disconnect the VPN, trigger a job that calls the LLM, confirm it retries with growing backoff instead of failing after 3 tries; reconnect the VPN, confirm the next scheduled retry succeeds and the job completes; confirm exactly one Slack message arrives if the outage is left running past the 1-hour threshold.

## 14. Explicitly deferred

- B2a's actual review-note-generation feature (prompts, budget-tier selection for that feature specifically) — separate spec, this one is a prerequisite for it to work reliably.
- Bedrock IAM/SDK path transient classification (not in active use today).
- `bedrock-titan` / Ollama embedding-provider transient handling — revisit later with the same `TransientLLMError` pattern if needed.
- A repeating Slack reminder cadence for long-running outages (explicitly decided against — one alert per streak).
- Any UI/CLI surface for listing currently-stuck transient jobs beyond the Slack alert itself (e.g. a `karpathy jobs stuck` command) — not requested, not built.

## 15. Open implementation questions (for the plan phase, not product decisions)

- Exact mechanism for `queue.markAlerted(jobId)` (§8) — a new small `JobQueue` interface method, following the same `findIndex`/mutate-in-place pattern as `complete()`/`cancel()` (`queue.ts:88-93,117-122`).
- Confirm whether `queue.ts`'s existing `log.warn`/`log.error` calls (via `createLogger`) already write to a file under `.karpathy/logs/` the user can tail, or only to stdout/stderr — determines whether §12's log line needs any new plumbing or is free with the existing logger.
- Confirm `KarpathyConfigSchema`'s `Partial...` override-merge machinery (schema.ts:303,321,340) needs `jobs` added in all three places it lists sibling top-level sections (`llm`, `notifications`, etc.) for the `projects`-level per-path override to work correctly — pattern should be mechanical but worth double-checking against one existing section during implementation.

# Track A Phase 2: Dataset Triage, Pooling, LLM Judge, Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the machinery that turns the 74-item draft eval set into real, judged ground truth: clean up category/subtype labels, author and verify a confirmed-absent query slice, pool candidate notes from multiple retrieval sources per query, have an LLM judge grade relevance, and produce a human-reviewable calibration report — ending at the human gate (Tom annotates; applying corrections and full-scale judging are later, out-of-scope follow-ups).

**Architecture:** Seven small, single-responsibility modules under `eval/dataset/` and `eval/pool/`, each independently testable. The expensive step (LLM judging) is isolated to exactly two real invocations in this plan: a cheap triage pass (~3 calls) and a calibration-sample judge pass (~20 calls) — never a full 73-item judge run, which is explicitly deferred to a future plan gated on the calibration agreement check.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `tsx`, `zod` (`^3.25.76`), `better-sqlite3`, `vitest`. Reuses Phase 1's `eval/run/{types,open-store,normalize,variants}.ts` and this codebase's existing `src/enrichment/llm-client.ts` LLMClient factories.

## Global Constraints

- ESM with `.js` import extensions on all relative imports (project convention, verbatim: `import { x } from '../../src/foo.js'`).
- Tests MUST live under `test/**/*.test.ts` (vitest `include: ['test/**/*.test.ts']`).
- zod import convention: `import { z } from 'zod';` (matches every existing file in this codebase).
- LLM-touching code MUST accept an injected `LLMClient` (dependency injection) so tests use a fake, never real network calls. Follow this codebase's existing test-double convention exactly (`test/intelligence/topic-refresh.test.ts`):
  ```ts
  function fakeLLM(response: unknown): LLMClient {
    return {
      async complete() { return JSON.stringify(response); },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse(response);
      },
    };
  }
  ```
- **No shared-budget-tracker calls.** Do not import or call `createBudgetTrackerFromConfig`/`tryReserve` anywhere in this plan's code — Phase 2's LLM calls are a deliberate, manual, one-off research task, not a routine background job, and must not compete with or be throttled by production enrichment jobs' daily caps.
- **Judge/triage model = medium tier**, resolved via a NEW `createLLMForTier(config, 'medium')` (Task 1) — `config.llm.models.medium` in production resolves to `"us.anthropic.claude-sonnet-4-6"`. This is the first call site in this codebase to actually use `config.llm.models.*`; every existing call site uses the single legacy `config.llm.model` field instead.
- **Pool sources are `grep-first` + `as-deployed`** (via Phase 1's `buildVariants`), NOT `search` + `search_vault` — `search_vault` only scans 4 vault folders and was already retired as a real contender by Track B; `grep-first`'s full-corpus FTS is a strict superset of its reach.
- **Read-only against the live production index** for all search/pooling operations (no `upsertDoc`/`deleteDoc`/`syncFTS` calls against the real `.karpathy/state/embeddings.sqlite`). Test fixtures use temp/throwaway dirs exactly as Phase 1's tests do.
- `doc_id` === vault-relative path (identity, no hash) — unchanged from Phase 1.
- Real LLM-calling scripts (triage, calibration) must support `--dry-run` (print what would be called, make zero LLM calls) for cost control before committing to a real run.

---

### Task 1: Tier-specific LLM client construction

**Files:**
- Create: `eval/pool/llm.ts`
- Test: `test/eval/llm.test.ts`

**Interfaces:**
- Consumes: `LLMClient`, `createBedrockClient`, `createLiteLLMClient`, `createNoopClient` from `src/enrichment/llm-client.ts` (all already exported, exact signatures: `createBedrockClient(config: {region: string; model: string; maxTokens: number; bearerToken?: string}): LLMClient`, `createLiteLLMClient(config: {baseUrl: string; apiKey: string; model: string; maxTokens: number}): LLMClient`, `createNoopClient(): LLMClient`). `KarpathyConfig`, `LLMTier` from `src/config/schema.ts` (`LLMTier = 'fast' | 'medium' | 'heavy'`; `config.llm.models: {fast: string; medium: string; heavy: string}`; `config.llm.provider: 'bedrock' | 'litellm'`; `config.llm.region: string`; `config.llm.maxTokens: number`; `config.llm.bearerToken?: string`; `config.llm.baseUrl?: string`; `config.llm.apiKey?: string`).
- Produces: `resolveTierModel(config: KarpathyConfig, tier: LLMTier): string`, `createLLMForTier(config: KarpathyConfig, tier: LLMTier): LLMClient` — used by Task 3 and Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/llm.test.ts
import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { resolveTierModel, createLLMForTier } from '../../eval/pool/llm.js';

describe('resolveTierModel', () => {
  it('resolves the configured model id for a given tier', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { models: { medium: 'us.anthropic.claude-sonnet-4-6' } },
    });
    expect(resolveTierModel(config, 'medium')).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('resolves different tiers to their own configured models', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { models: { fast: 'fast-model', medium: 'medium-model', heavy: 'heavy-model' } },
    });
    expect(resolveTierModel(config, 'fast')).toBe('fast-model');
    expect(resolveTierModel(config, 'heavy')).toBe('heavy-model');
  });
});

describe('createLLMForTier', () => {
  it('constructs a usable LLMClient for the bedrock provider without making a network call', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { provider: 'bedrock', region: 'us-west-2', maxTokens: 4096, models: { medium: 'us.anthropic.claude-sonnet-4-6' } },
    });
    const client = createLLMForTier(config, 'medium');
    expect(typeof client.complete).toBe('function');
    expect(typeof client.extractStructured).toBe('function');
  });

  it('throws a clear error for litellm provider missing baseUrl/apiKey', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { provider: 'litellm', models: { medium: 'medium-model' } },
    });
    expect(() => createLLMForTier(config, 'medium')).toThrow('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/llm.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/llm.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/llm.ts
import type { KarpathyConfig, LLMTier } from '../../src/config/schema.js';
import {
  createBedrockClient,
  createLiteLLMClient,
  createNoopClient,
  type LLMClient,
} from '../../src/enrichment/llm-client.js';

/** Resolve which model ID a given tier maps to for this config. */
export function resolveTierModel(config: KarpathyConfig, tier: LLMTier): string {
  return config.llm.models[tier];
}

/**
 * Construct an LLMClient for a specific tier. Mirrors src/bin/karpathy.ts's
 * private createLLMFromConfig provider branching, but resolves
 * config.llm.models[tier] instead of the legacy single config.llm.model
 * field — this is the first call site in this codebase to do so.
 */
export function createLLMForTier(config: KarpathyConfig, tier: LLMTier): LLMClient {
  const model = resolveTierModel(config, tier);
  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) {
      throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    }
    return createLiteLLMClient({ baseUrl, apiKey, model, maxTokens: config.llm.maxTokens });
  }
  if (config.llm.provider === 'bedrock') {
    return createBedrockClient({
      region: config.llm.region,
      model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
  }
  return createNoopClient();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/llm.test.ts`
Expected: PASS (4 tests). Note: `createLLMForTier` for `bedrock` does NOT make a network call at construction time (`createBedrockClient` lazily imports the AWS SDK only when `.complete()`/`.extractStructured()` is first invoked) — this test is safe to run with no AWS credentials.

- [ ] **Step 5: Commit**

```bash
git add eval/pool/llm.ts test/eval/llm.test.ts
git commit -m "feat(eval): tier-specific LLM client construction"
```

---

### Task 2: Judge and triage prompt templates

**Files:**
- Create: `eval/pool/prompts.ts`
- Test: `test/eval/prompts.test.ts`

**Interfaces:**
- Consumes: nothing (pure string-building functions).
- Produces: `triagePrompt(items: TriageItemInput[]): string`, `judgePrompt(query: string, intent: string, candidates: JudgeCandidate[]): string`, `JudgeCandidate` type, `TriageItemInput` type — used by Task 3 and Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/prompts.test.ts
import { describe, it, expect } from 'vitest';
import { triagePrompt, judgePrompt } from '../../eval/pool/prompts.js';

describe('triagePrompt', () => {
  it('includes every item\'s id, query, and current labels', () => {
    const prompt = triagePrompt([
      { id: 'x-001', query: 'what did we decide about X', category: 'decisions', subtype: 'lookup', source: 'log', intent: 'find the decision' },
    ]);
    expect(prompt).toContain('x-001');
    expect(prompt).toContain('what did we decide about X');
    expect(prompt).toContain('decisions');
    expect(prompt).toContain('lookup');
    expect(prompt).toContain('json');
  });
});

describe('judgePrompt', () => {
  it('includes the query, intent, and every candidate\'s doc_id/title/excerpt', () => {
    const prompt = judgePrompt('what did we decide about X', 'find the decision', [
      { doc_id: 'wiki/decisions/x.md', title: 'Decision: X', excerpt: 'We decided X because...' },
      { doc_id: 'wiki/meetings/y.md', title: 'Meeting Y', excerpt: 'Unrelated meeting notes' },
    ]);
    expect(prompt).toContain('what did we decide about X');
    expect(prompt).toContain('find the decision');
    expect(prompt).toContain('wiki/decisions/x.md');
    expect(prompt).toContain('Decision: X');
    expect(prompt).toContain('We decided X because...');
    expect(prompt).toContain('wiki/meetings/y.md');
    expect(prompt).toContain('json');
  });

  it('handles an empty intent without leaving a literal "undefined" in the prompt', () => {
    const prompt = judgePrompt('q', '', [{ doc_id: 'a.md', title: 'A', excerpt: 'e' }]);
    expect(prompt).not.toContain('undefined');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/prompts.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/prompts.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/prompts.ts

export interface TriageItemInput {
  id: string;
  query: string;
  category: string;
  subtype: string;
  source: string;
  intent: string;
}

export interface JudgeCandidate {
  doc_id: string;
  title: string;
  excerpt: string;
}

export function triagePrompt(items: TriageItemInput[]): string {
  const body = items
    .map(
      (it) =>
        `id: ${it.id}\nquery: ${it.query}\ncurrent_category: ${it.category}\ncurrent_subtype: ${it.subtype}\nsource: ${it.source}\nintent: ${it.intent || '(none given)'}`,
    )
    .join('\n---\n');

  return `You are a retrieval-evaluation dataset curator reviewing draft eval items for a personal knowledge-base search system.

For each item below, decide whether its category and subtype labels are correct, and whether it is genuinely a retrieval question (asking to find/recall something in a personal notes vault) rather than an unrelated task request that slipped in by mistake during automated mining.

Categories: "plaud-ai-session" (meeting recordings, AI coding session history), "entities" (people/orgs/projects/relationships), "hot-topics" (what's currently active/important), "decisions" (specific decisions or meeting outcomes).
Subtypes: "lookup" (single-fact retrieval), "synthesis" (spans many notes), "relationship" (entity graph walk), "absent" (deliberately testing that nothing relevant exists).

--- BEGIN ITEMS ---
${body}
--- END ITEMS ---

For each item, return an object with: id, proposed_category, proposed_subtype, drop (true if this is NOT a genuine retrieval question — e.g. it's a coding task request, an installation request, or an acknowledgement that slipped through), and a one-sentence reason.

Respond with only a JSON array, one object per item, wrapped in \`\`\`json code fences.`;
}

export function judgePrompt(query: string, intent: string, candidates: JudgeCandidate[]): string {
  const body = candidates
    .map((c) => `doc_id: ${c.doc_id}\ntitle: ${c.title}\nexcerpt: ${c.excerpt}`)
    .join('\n---\n');
  const intentLine = intent
    ? intent
    : '(no additional intent given — judge relevance to the query alone)';

  return `You are grading search-result relevance for a personal knowledge-base retrieval evaluation.

Query: "${query}"
Intent: ${intentLine}

For each candidate note below, grade how relevant it is to the query:
- 2 = directly answers or is the primary target of the query
- 1 = relevant supporting context, but not the primary answer
- 0 = not relevant

--- BEGIN CANDIDATES ---
${body}
--- END CANDIDATES ---

Return a JSON array with one object per candidate: { "doc_id": "...", "label": 0|1|2, "reason": "<one sentence>" }. Include every candidate exactly once, in any order.

Respond with only the JSON array, wrapped in \`\`\`json code fences.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/prompts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/pool/prompts.ts test/eval/prompts.test.ts
git commit -m "feat(eval): judge and triage prompt templates"
```

---

### Task 3: Dataset category/subtype triage

**Files:**
- Create: `eval/dataset/types.ts`
- Create: `eval/dataset/triage.ts`
- Modify: `package.json` (add `eval:triage` script)
- Test: `test/eval/triage.test.ts`

**Interfaces:**
- Consumes: `LLMClient` from `src/enrichment/llm-client.ts`; `triagePrompt`, `TriageItemInput` from `eval/pool/prompts.ts` (Task 2); `createLLMForTier` from `eval/pool/llm.ts` (Task 1, used only in `main()`).
- Produces: `EvalItem` interface (`eval/dataset/types.ts`) — used by Task 4 and Task 7. `TriageProposal` interface, `triageItems(llm: LLMClient, items: EvalItem[], chunkSize?: number): Promise<TriageProposal[]>` — used by Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/triage.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { triageItems, type TriageProposal } from '../../eval/dataset/triage.js';
import type { EvalItem } from '../../eval/dataset/types.js';

function makeItem(id: string, query: string): EvalItem {
  return {
    id,
    query,
    category: 'decisions',
    subtype: 'lookup',
    source: 'log',
    source_ref: '',
    intent: '',
    is_regression: false,
    query_truncated: false,
    needs_review: true,
  };
}

function countingFakeLLM(responsePerCall: TriageProposal[]): { llm: LLMClient; callCount: () => number } {
  let calls = 0;
  const llm: LLMClient = {
    async complete() {
      return '';
    },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
      calls += 1;
      return schema.parse(responsePerCall) as T;
    },
  };
  return { llm, callCount: () => calls };
}

const dummyProposal: TriageProposal = {
  id: 'a',
  proposed_category: 'decisions',
  proposed_subtype: 'lookup',
  drop: false,
  reason: 'r',
};

describe('triageItems', () => {
  it('chunks items and flattens results across multiple LLM calls', async () => {
    const items = [makeItem('a', 'q1'), makeItem('b', 'q2'), makeItem('c', 'q3')];
    const { llm, callCount } = countingFakeLLM([dummyProposal]);
    const proposals = await triageItems(llm, items, 2); // chunk size 2 -> batches of [2,1] -> 2 calls
    expect(callCount()).toBe(2);
    expect(proposals).toHaveLength(2); // 1 dummy proposal returned per call x 2 calls
  });

  it('propagates a rejection when the LLM call fails', async () => {
    const badLlm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured() {
        throw new Error('bad json');
      },
    };
    await expect(triageItems(badLlm, [makeItem('a', 'q1')], 25)).rejects.toThrow('bad json');
  });

  it('makes zero calls for an empty item list', async () => {
    const { llm, callCount } = countingFakeLLM([dummyProposal]);
    const proposals = await triageItems(llm, [], 25);
    expect(callCount()).toBe(0);
    expect(proposals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/triage.test.ts`
Expected: FAIL — cannot find module `../../eval/dataset/triage.js` (and `types.js`).

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/dataset/types.ts

export interface EvalItem {
  id: string;
  query: string;
  category: 'plaud-ai-session' | 'entities' | 'hot-topics' | 'decisions';
  subtype: 'lookup' | 'synthesis' | 'relationship' | 'absent';
  source: 'log' | 'session' | 'synthetic';
  source_ref: string;
  intent: string;
  is_regression: boolean;
  query_truncated: boolean;
  needs_review: boolean;
}
```

```ts
// eval/dataset/triage.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { triagePrompt } from '../pool/prompts.js';
import type { EvalItem } from './types.js';

export interface TriageProposal {
  id: string;
  proposed_category: 'plaud-ai-session' | 'entities' | 'hot-topics' | 'decisions';
  proposed_subtype: 'lookup' | 'synthesis' | 'relationship' | 'absent';
  drop: boolean;
  reason: string;
}

const TriageProposalSchema = z.object({
  id: z.string(),
  proposed_category: z.enum(['plaud-ai-session', 'entities', 'hot-topics', 'decisions']),
  proposed_subtype: z.enum(['lookup', 'synthesis', 'relationship', 'absent']),
  drop: z.boolean(),
  reason: z.string(),
});
const TriageResponseSchema = z.array(TriageProposalSchema);

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Propose corrected category/subtype/drop labels for each item, batching
 * `chunkSize` items per LLM call (default 25, small enough to stay well
 * within context for a 74-item dataset in ~3 calls). */
export async function triageItems(
  llm: LLMClient,
  items: EvalItem[],
  chunkSize = 25,
): Promise<TriageProposal[]> {
  const proposals: TriageProposal[] = [];
  for (const batch of chunk(items, chunkSize)) {
    const prompt = triagePrompt(
      batch.map((it) => ({
        id: it.id,
        query: it.query,
        category: it.category,
        subtype: it.subtype,
        source: it.source,
        intent: it.intent,
      })),
    );
    const result = await llm.extractStructured(prompt, TriageResponseSchema);
    proposals.push(...result);
  }
  return proposals;
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { loadConfig } = await import('../../src/config/loader.js');
  const { createLLMForTier } = await import('../pool/llm.js');
  const config = await loadConfig(REPO_ROOT);
  const items: EvalItem[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  if (dryRun) {
    console.log(`[dry-run] would triage ${items.length} items in chunks of 25 (~${Math.ceil(items.length / 25)} LLM calls)`);
    return;
  }
  const llm = createLLMForTier(config, 'medium');
  const proposals = await triageItems(llm, items);
  writeFileSync(join(REPO_ROOT, 'eval/dataset/triage-proposals.json'), JSON.stringify(proposals, null, 2));
  console.log(`Wrote ${proposals.length} triage proposals to eval/dataset/triage-proposals.json`);
  const drops = proposals.filter((p) => p.drop);
  console.log(`${drops.length} items flagged for drop:`, drops.map((d) => d.id));
}

if (process.argv[1]?.endsWith('triage.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/triage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the eval:triage script**

Modify `package.json` scripts (after the existing `eval:run` line):

```json
"eval:triage": "tsx eval/dataset/triage.ts",
```

- [ ] **Step 6: Commit**

```bash
git add eval/dataset/types.ts eval/dataset/triage.ts test/eval/triage.test.ts package.json
git commit -m "feat(eval): dataset category/subtype triage"
```

---

### Task 4: Authored, mechanically-verified absent queries

**Files:**
- Create: `eval/dataset/author-absent.ts`
- Modify: `package.json` (add `eval:author-absent` script)
- Test: `test/eval/author-absent.test.ts`

**Interfaces:**
- Consumes: `Variant` from `eval/run/types.ts` (Phase 1); `toRunHits` from `eval/run/normalize.ts` (Phase 1); `openVariantStore` from `eval/run/open-store.ts` (Phase 1); `EvalItem` from `eval/dataset/types.ts` (Task 3).
- Produces: `isConfirmedAbsent(variants: Variant[], query: string, scoreThreshold?: number): Promise<boolean>` — pure verification logic, not consumed by later tasks but independently testable.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/author-absent.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { isConfirmedAbsent } from '../../eval/dataset/author-absent.js';
import type { Variant } from '../../eval/run/types.js';

describe('isConfirmedAbsent', () => {
  let dir: string;
  let dbPath: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-absent-'));
    dbPath = join(dir, 'idx.sqlite');
    config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana Notes\n---\nyellow banana harness fruit tropical');
    const seed = openVariantStore(config, dbPath, {});
    try {
      await seed.syncFTS(['wiki']);
    } finally {
      seed.close();
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeVariants(): Variant[] {
    return [
      {
        name: 'grep-first',
        keywordOnly: true,
        topK: 1,
        openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' },
      },
    ];
  }

  it('returns false when a real match exists', async () => {
    const absent = await isConfirmedAbsent(makeVariants(), 'banana tropical');
    expect(absent).toBe(false);
  });

  it('returns true when no meaningful match exists', async () => {
    const absent = await isConfirmedAbsent(makeVariants(), 'zzznonexistentqqqxyzzy');
    expect(absent).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/author-absent.test.ts`
Expected: FAIL — cannot find module `../../eval/dataset/author-absent.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/dataset/author-absent.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';
import type { EvalItem } from './types.js';

/**
 * Starting threshold for "no meaningful match" — a top-hit `final` score
 * below this counts as absent. NOT independently calibrated; the real run
 * (Step 5 below) prints every candidate's top score across all variants so
 * this can be sanity-checked/adjusted against real observed scores before
 * trusting the confirmed-absent set.
 */
const DEFAULT_SCORE_THRESHOLD = 0.02;

/** Check whether a query is confirmed absent across ALL given variants:
 * either zero hits, or the top hit's final score is below the threshold. */
export async function isConfirmedAbsent(
  variants: Variant[],
  query: string,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): Promise<boolean> {
  for (const variant of variants) {
    const store = variant.openStore();
    try {
      const result = await store.search(query, { topK: 1 });
      const hits = toRunHits(result, 1);
      if (hits.length > 0 && hits[0].final >= scoreThreshold) {
        return false;
      }
    } finally {
      store.close();
    }
  }
  return true;
}

const CANDIDATE_ABSENT_QUERIES = [
  'kubernetes horizontal pod autoscaler tuning for a Redis cluster',
  'quarterly OKR review for the marketing analytics team',
  'vendor contract renewal terms for Salesforce',
  'company parental leave policy update',
  'chess opening strategy notes',
  'sourdough bread starter maintenance schedule',
  'garbage collector internals comparison across programming languages',
  'family vacation itinerary planning',
  'home aquarium water chemistry balancing',
  'marathon training pace plan',
];

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const variants = buildVariants(config, REPO_ROOT, 1);

  const confirmed: string[] = [];
  for (const query of CANDIDATE_ABSENT_QUERIES) {
    const scores: Record<string, number> = {};
    let absent = true;
    for (const variant of variants) {
      const store = variant.openStore();
      try {
        const result = await store.search(query, { topK: 1 });
        const hits = toRunHits(result, 1);
        const top = hits[0]?.final ?? 0;
        scores[variant.name] = top;
        if (top >= DEFAULT_SCORE_THRESHOLD) absent = false;
      } finally {
        store.close();
      }
    }
    console.log(`${absent ? 'ABSENT' : 'FOUND '} "${query}" scores=${JSON.stringify(scores)}`);
    if (absent) confirmed.push(query);
  }
  console.log(`\n${confirmed.length}/${CANDIDATE_ABSENT_QUERIES.length} candidates confirmed absent.`);
  if (confirmed.length < 5) {
    console.warn('Fewer than 5 confirmed absent — consider authoring more candidates or lowering the threshold.');
  }

  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const withoutStub = items.filter((it) => !it.query.startsWith('<ABSENT-STUB'));
  const absentItems: EvalItem[] = confirmed.map((query, i) => ({
    id: `absent-${String(i + 1).padStart(3, '0')}`,
    query,
    category: 'decisions',
    subtype: 'absent',
    source: 'synthetic',
    source_ref: 'author:absent-verified',
    intent: 'robustness: system should return nothing / low-confidence',
    is_regression: false,
    query_truncated: false,
    needs_review: false,
  }));
  writeFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), JSON.stringify([...withoutStub, ...absentItems], null, 2));
  console.log(`Wrote ${absentItems.length} confirmed-absent items to eval/dataset/queries.json (removed placeholder stub).`);
}

if (process.argv[1]?.endsWith('author-absent.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/author-absent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the eval:author-absent script**

Modify `package.json` scripts (after `eval:triage`):

```json
"eval:author-absent": "tsx eval/dataset/author-absent.ts",
```

- [ ] **Step 6: Commit**

```bash
git add eval/dataset/author-absent.ts test/eval/author-absent.test.ts package.json
git commit -m "feat(eval): authored, mechanically-verified absent queries"
```

---

### Task 5: Pool builder

**Files:**
- Create: `eval/pool/build-pool.ts`
- Modify: `package.json` (add `eval:pool` script)
- Test: `test/eval/build-pool.test.ts`

**Interfaces:**
- Consumes: `Variant` from `eval/run/types.ts`; `toRunHits` from `eval/run/normalize.ts` (both Phase 1). `Database` from `better-sqlite3`.
- Produces: `PoolCandidate`, `ItemPool` interfaces; `buildPoolForItem(item, variants, db, behavioral, poolK?): Promise<ItemPool>` — used by Task 6/7 callers (via the written `pool.json`, not a direct function import).

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/build-pool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { buildPoolForItem } from '../../eval/pool/build-pool.js';
import type { Variant } from '../../eval/run/types.js';

describe('buildPoolForItem', () => {
  let dir: string;
  let dbPath: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-pool-'));
    dbPath = join(dir, 'idx.sqlite');
    config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana Notes\n---\nyellow banana harness fruit');
    await writeFile(join(dir, 'wiki', 'apple.md'), '---\ntitle: Apple Notes\n---\ncrunchy apple orchard');
    const seed = openVariantStore(config, dbPath, {});
    try {
      await seed.syncFTS(['wiki']);
    } finally {
      seed.close();
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeVariants(): Variant[] {
    return [
      {
        name: 'grep-first',
        keywordOnly: true,
        topK: 5,
        openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' },
      },
      {
        name: 'as-deployed',
        keywordOnly: false,
        topK: 5,
        openStore: () => openVariantStore(config, dbPath, {}),
        profile: { runtimeDeps: ['ollama'], storageGbBeyondFts: 1, maintenanceJobs: ['embedding-index'], silentDegradationModes: [], codeSurface: 'high' },
      },
    ];
  }

  it('dedupes by doc_id, tags every contributing source, and looks up titles', async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const pool = await buildPoolForItem(
        { id: 'x-001', query: 'banana' },
        makeVariants(),
        db,
        [{ query: 'banana', ts: '2026-01-01T00:00:00Z', opened: ['wiki/apple.md'] }],
      );
      expect(pool.item_id).toBe('x-001');

      const banana = pool.candidates.find((c) => c.doc_id === 'wiki/banana.md');
      expect(banana).toBeDefined();
      expect(banana!.title).toBe('Banana Notes');
      expect(banana!.sources).toContain('grep-first');
      expect(banana!.sources).toContain('as-deployed');
      expect(banana!.sources).toContain('keyword-sweep');

      const apple = pool.candidates.find((c) => c.doc_id === 'wiki/apple.md');
      expect(apple).toBeDefined();
      expect(apple!.sources).toContain('behavioral');
    } finally {
      db.close();
    }
  });

  it('falls back to doc_id as title when a note is missing from the FTS index', async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const pool = await buildPoolForItem(
        { id: 'x-002', query: 'banana' },
        makeVariants(),
        db,
        [{ query: 'banana', ts: '2026-01-01T00:00:00Z', opened: ['wiki/missing-note.md'] }],
      );
      const missing = pool.candidates.find((c) => c.doc_id === 'wiki/missing-note.md');
      expect(missing).toBeDefined();
      expect(missing!.title).toBe('wiki/missing-note.md');
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/build-pool.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/build-pool.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/build-pool.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';

export interface PoolCandidate {
  doc_id: string;
  title: string;
  excerpt: string;
  sources: string[];
}

export interface ItemPool {
  item_id: string;
  candidates: PoolCandidate[];
}

export interface BehavioralEntry {
  query: string;
  ts: string;
  opened: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function lookupTitle(db: Database.Database, docId: string): string {
  const row = db.prepare('SELECT title FROM notes_fts WHERE doc_id = ?').get(docId) as
    | { title: string }
    | undefined;
  return row?.title || docId;
}

/** Pool = union of grep-first top-K, as-deployed top-K, a raw FTS keyword
 * sweep (via the first variant's shared store.fts — same underlying index
 * for every variant), and behavioral signal (notes opened shortly after a
 * matching real logged search). Dedup by doc_id; each candidate records
 * every source that surfaced it. */
export async function buildPoolForItem(
  item: { id: string; query: string },
  variants: Variant[],
  db: Database.Database,
  behavioral: BehavioralEntry[],
  poolK = 20,
): Promise<ItemPool> {
  const byDocId = new Map<string, PoolCandidate>();
  const add = (docId: string, source: string, excerpt: string) => {
    const existing = byDocId.get(docId);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byDocId.set(docId, { doc_id: docId, title: lookupTitle(db, docId), excerpt, sources: [source] });
  };

  for (const variant of variants) {
    const store = variant.openStore();
    try {
      const result = await store.search(item.query, { topK: poolK });
      const hits = toRunHits(result, poolK);
      for (const h of hits) add(h.path, variant.name, h.excerpt);
    } finally {
      store.close();
    }
  }

  const sweepStore = variants[0].openStore();
  try {
    const ftsHits = sweepStore.fts.query(item.query, poolK);
    for (const h of ftsHits) add(h.docId, 'keyword-sweep', h.snippet);
  } finally {
    sweepStore.close();
  }

  const behavioralMatch = behavioral.find((b) => norm(b.query) === norm(item.query));
  if (behavioralMatch) {
    for (const path of behavioralMatch.opened) add(path, 'behavioral', '');
  }

  return { item_id: item.id, candidates: [...byDocId.values()] };
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const variants = buildVariants(config, REPO_ROOT, 20);

  const items: { id: string; query: string }[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  const behavioral: BehavioralEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/behavioral-signal.json'), 'utf8'),
  );

  const db = new Database(dbPath, { readonly: true });
  const pools: ItemPool[] = [];
  try {
    for (const item of items) {
      if (item.query.startsWith('<ABSENT-STUB')) continue;
      pools.push(await buildPoolForItem(item, variants, db, behavioral, 20));
    }
  } finally {
    db.close();
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), JSON.stringify(pools, null, 2));
  const totalCandidates = pools.reduce((sum, p) => sum + p.candidates.length, 0);
  console.log(`Wrote eval/dataset/pool.json: ${pools.length} items, ${totalCandidates} total candidates`);
}

if (process.argv[1]?.endsWith('build-pool.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/build-pool.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the eval:pool script**

Modify `package.json` scripts (after `eval:author-absent`):

```json
"eval:pool": "tsx eval/pool/build-pool.ts",
```

- [ ] **Step 6: Commit**

```bash
git add eval/pool/build-pool.ts test/eval/build-pool.test.ts package.json
git commit -m "feat(eval): 4-source candidate pool builder"
```

---

### Task 6: LLM judge (library function)

**Files:**
- Create: `eval/pool/judge.ts`
- Test: `test/eval/judge.test.ts`

**Interfaces:**
- Consumes: `LLMClient` from `src/enrichment/llm-client.ts`; `judgePrompt`, `JudgeCandidate` from `eval/pool/prompts.ts` (Task 2); `ItemPool` from `eval/pool/build-pool.ts` (Task 5).
- Produces: `Judgment` interface, `judgeItem(llm, item, pool): Promise<Judgment[]>` — used by Task 7. **No CLI/main() in this task** — full-scale judging of the entire pool is explicitly out of scope for this plan (see design doc §9); only Task 7's calibration-sample run invokes this function for real.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/judge.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgeItem } from '../../eval/pool/judge.js';
import type { ItemPool } from '../../eval/pool/build-pool.js';

describe('judgeItem', () => {
  it('labels every pooled candidate and tags provenance as llm', async () => {
    const pool: ItemPool = {
      item_id: 'x-001',
      candidates: [
        { doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] },
        { doc_id: 'b.md', title: 'B', excerpt: 'exc-b', sources: ['as-deployed'] },
      ],
    };
    const fakeResults = [
      { doc_id: 'a.md', label: 2, reason: 'directly answers' },
      { doc_id: 'b.md', label: 0, reason: 'unrelated' },
    ];
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse(fakeResults) as T;
      },
    };
    const judgments = await judgeItem(llm, { id: 'x-001', query: 'q', intent: '' }, pool);
    expect(judgments).toHaveLength(2);
    expect(judgments.find((j) => j.doc_id === 'a.md')).toMatchObject({ item_id: 'x-001', label: 2, label_provenance: 'llm' });
    expect(judgments.find((j) => j.doc_id === 'b.md')).toMatchObject({ item_id: 'x-001', label: 0, label_provenance: 'llm' });
  });

  it('filters out any doc_id the LLM invents that is not in the pool', async () => {
    const pool: ItemPool = {
      item_id: 'x-001',
      candidates: [{ doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] }],
    };
    const fakeResults = [
      { doc_id: 'a.md', label: 2, reason: 'matches' },
      { doc_id: 'hallucinated.md', label: 1, reason: 'made up' },
    ];
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse(fakeResults) as T;
      },
    };
    const judgments = await judgeItem(llm, { id: 'x-001', query: 'q', intent: '' }, pool);
    expect(judgments).toHaveLength(1);
    expect(judgments[0].doc_id).toBe('a.md');
  });

  it('returns an empty array without calling the LLM when the pool has no candidates', async () => {
    let called = false;
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(): Promise<T> {
        called = true;
        return [] as unknown as T;
      },
    };
    const judgments = await judgeItem(llm, { id: 'x-002', query: 'q', intent: '' }, { item_id: 'x-002', candidates: [] });
    expect(judgments).toEqual([]);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/judge.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/judge.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/judge.ts
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgePrompt, type JudgeCandidate } from './prompts.js';
import type { ItemPool } from './build-pool.js';

export interface Judgment {
  item_id: string;
  doc_id: string;
  label: number;
  reason: string;
  label_provenance: 'llm' | 'human' | 'llm+human';
}

const JudgeResultSchema = z.object({
  doc_id: z.string(),
  label: z.number().int().min(0).max(2),
  reason: z.string(),
});
const JudgeResponseSchema = z.array(JudgeResultSchema);

/** Grade every candidate in `pool` against `item` in one LLM call. Filters
 * out any doc_id the LLM returns that wasn't actually in the pool (a real
 * risk with LLM-generated structured output — never trust it blindly). */
export async function judgeItem(
  llm: LLMClient,
  item: { id: string; query: string; intent: string },
  pool: ItemPool,
): Promise<Judgment[]> {
  if (pool.candidates.length === 0) return [];

  const candidates: JudgeCandidate[] = pool.candidates.map((c) => ({
    doc_id: c.doc_id,
    title: c.title,
    excerpt: c.excerpt,
  }));
  const prompt = judgePrompt(item.query, item.intent, candidates);
  const results = await llm.extractStructured(prompt, JudgeResponseSchema);

  const knownIds = new Set(pool.candidates.map((c) => c.doc_id));
  return results
    .filter((r) => knownIds.has(r.doc_id))
    .map((r) => ({
      item_id: item.id,
      doc_id: r.doc_id,
      label: r.label,
      reason: r.reason,
      label_provenance: 'llm' as const,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/judge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/pool/judge.ts test/eval/judge.test.ts
git commit -m "feat(eval): batched LLM judge for pooled candidates"
```

---

### Task 7: Calibration sample — stratified selection, real judge run, markdown report

**Files:**
- Create: `eval/pool/calibration-report.ts`
- Modify: `package.json` (add `eval:calibration` script)
- Test: `test/eval/calibration-report.test.ts`

**Interfaces:**
- Consumes: `EvalItem` from `eval/dataset/types.ts` (Task 3); `TriageProposal` from `eval/dataset/triage.ts` (Task 3); `Judgment`, `judgeItem` from `eval/pool/judge.ts` (Task 6); `ItemPool` from `eval/pool/build-pool.ts` (Task 5); `createLLMForTier` from `eval/pool/llm.ts` (Task 1, used only in `main()`).
- Produces: `stratifiedSample(items, size): EvalItem[]`, `renderCalibrationReport(items, judgmentsByItem, triageByItemId?): string`, `writeCalibrationReport(path, items, judgmentsByItem, triageByItemId?): void`. This task's `main()` is the plan's final real, end-to-end run.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/calibration-report.test.ts
import { describe, it, expect } from 'vitest';
import { stratifiedSample, renderCalibrationReport } from '../../eval/pool/calibration-report.js';
import type { EvalItem } from '../../eval/dataset/types.js';
import type { Judgment } from '../../eval/pool/judge.js';

function makeItem(id: string, category: EvalItem['category'], subtype: EvalItem['subtype']): EvalItem {
  return {
    id,
    query: `query for ${id}`,
    category,
    subtype,
    source: 'log',
    source_ref: '',
    intent: `intent for ${id}`,
    is_regression: false,
    query_truncated: false,
    needs_review: false,
  };
}

describe('stratifiedSample', () => {
  it('round-robins across (category, subtype) groups so no single group dominates', () => {
    const items = [
      makeItem('d1', 'decisions', 'lookup'),
      makeItem('d2', 'decisions', 'lookup'),
      makeItem('e1', 'entities', 'relationship'),
      makeItem('e2', 'entities', 'relationship'),
      makeItem('h1', 'hot-topics', 'synthesis'),
      makeItem('h2', 'hot-topics', 'synthesis'),
    ];
    const sample = stratifiedSample(items, 3);
    expect(sample).toHaveLength(3);
    const groups = new Set(sample.map((it) => `${it.category}::${it.subtype}`));
    expect(groups.size).toBe(3); // one from each of the 3 groups, not 3 from one group
  });

  it('caps at the requested size even with more items available', () => {
    const items = [
      makeItem('d1', 'decisions', 'lookup'),
      makeItem('d2', 'decisions', 'lookup'),
      makeItem('d3', 'decisions', 'lookup'),
    ];
    expect(stratifiedSample(items, 2)).toHaveLength(2);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const items = [makeItem('d1', 'decisions', 'lookup'), makeItem('d2', 'decisions', 'lookup')];
    expect(stratifiedSample(items, 2).map((it) => it.id)).toEqual(stratifiedSample(items, 2).map((it) => it.id));
  });
});

describe('renderCalibrationReport', () => {
  it('includes the query, intent, and each judged candidate with a checkbox line', () => {
    const items = [makeItem('d1', 'decisions', 'lookup')];
    const judgmentsByItem = new Map<string, Judgment[]>([
      ['d1', [{ item_id: 'd1', doc_id: 'a.md', label: 2, reason: 'directly answers', label_provenance: 'llm' }]],
    ]);
    const report = renderCalibrationReport(items, judgmentsByItem);
    expect(report).toContain('d1');
    expect(report).toContain('query for d1');
    expect(report).toContain('intent for d1');
    expect(report).toContain('a.md');
    expect(report).toContain('label 2');
    expect(report).toContain('directly answers');
    expect(report).toContain("Tom's call");
  });

  it('notes when an item has no pooled candidates instead of a blank section', () => {
    const items = [makeItem('d1', 'decisions', 'lookup')];
    const report = renderCalibrationReport(items, new Map());
    expect(report).toContain('no pooled candidates');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/calibration-report.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/calibration-report.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/calibration-report.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalItem } from '../dataset/types.js';
import type { TriageProposal } from '../dataset/triage.js';
import type { Judgment } from './judge.js';
import type { ItemPool } from './build-pool.js';

/** Pick a stratified sample across (category, subtype) pairs — round-robin
 * one item per group per round, so no single group dominates a small sample.
 * Deterministic: groups sorted by key, items within a group sorted by id. */
export function stratifiedSample(items: EvalItem[], size: number): EvalItem[] {
  const groups = new Map<string, EvalItem[]>();
  for (const it of items) {
    const key = `${it.category}::${it.subtype}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }
  for (const group of groups.values()) group.sort((a, b) => a.id.localeCompare(b.id));

  const keys = [...groups.keys()].sort();
  const sample: EvalItem[] = [];
  let round = 0;
  while (sample.length < size && keys.some((k) => (groups.get(k)?.length ?? 0) > round)) {
    for (const key of keys) {
      if (sample.length >= size) break;
      const group = groups.get(key)!;
      if (round < group.length) sample.push(group[round]);
    }
    round += 1;
  }
  return sample;
}

export function renderCalibrationReport(
  items: EvalItem[],
  judgmentsByItem: Map<string, Judgment[]>,
  triageByItemId?: Map<string, TriageProposal>,
): string {
  const lines: string[] = ['# Judge Calibration Sample', '', "For each candidate, mark agree or write a correction.", ''];

  if (triageByItemId && triageByItemId.size > 0) {
    lines.push('## Category/Subtype Triage Proposals', '');
    for (const [id, proposal] of triageByItemId) {
      lines.push(
        `- **${id}** -> category: ${proposal.proposed_category}, subtype: ${proposal.proposed_subtype}${proposal.drop ? ', DROP' : ''} — ${proposal.reason}`,
      );
      lines.push(`  - Tom's call: [ ] agree   [ ] correct to: ____`);
    }
    lines.push('');
  }

  for (const item of items) {
    lines.push(`## ${item.id}`, '', `**Query:** ${item.query}`, `**Intent:** ${item.intent || '(none)'}`, `**Category/Subtype:** ${item.category} / ${item.subtype}`, '');
    const judgments = judgmentsByItem.get(item.id) ?? [];
    if (judgments.length === 0) {
      lines.push('_(no pooled candidates)_', '');
      continue;
    }
    for (const j of judgments) {
      lines.push(`- **${j.doc_id}** — label ${j.label} — ${j.reason}`);
      lines.push(`  - Tom's call: [ ] agree   [ ] correct to: ____`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeCalibrationReport(
  path: string,
  items: EvalItem[],
  judgmentsByItem: Map<string, Judgment[]>,
  triageByItemId?: Map<string, TriageProposal>,
): void {
  writeFileSync(path, renderCalibrationReport(items, judgmentsByItem, triageByItemId));
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { loadConfig } = await import('../../src/config/loader.js');
  const { createLLMForTier } = await import('./llm.js');
  const { judgeItem } = await import('./judge.js');

  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const triageProposals: TriageProposal[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/triage-proposals.json'), 'utf8'),
  );
  const triageByItemId = new Map(triageProposals.map((p) => [p.id, p]));
  const pools: ItemPool[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), 'utf8'));
  const poolByItemId = new Map(pools.map((p) => [p.item_id, p]));

  // Stratify using triage-proposed categories/subtypes when available (a
  // preview, not applied back to queries.json — applying corrections is a
  // later, human-gated step).
  const itemsForStratification: EvalItem[] = items.map((it) => {
    const proposal = triageByItemId.get(it.id);
    if (!proposal || proposal.drop) return it;
    return { ...it, category: proposal.proposed_category, subtype: proposal.proposed_subtype };
  });
  const dropped = new Set(
    [...triageByItemId.values()].filter((p) => p.drop).map((p) => p.id),
  );
  const eligible = itemsForStratification.filter((it) => !dropped.has(it.id) && poolByItemId.has(it.id));

  const sample = stratifiedSample(eligible, 20);
  console.log(`Selected ${sample.length} calibration items across ${new Set(sample.map((it) => `${it.category}::${it.subtype}`)).size} category/subtype groups`);

  if (dryRun) {
    console.log('[dry-run] would judge:', sample.map((it) => it.id));
    return;
  }

  const config = await loadConfig(REPO_ROOT);
  const llm = createLLMForTier(config, 'medium');
  const judgmentsByItem = new Map<string, Judgment[]>();
  const allJudgments: Judgment[] = [];
  for (const item of sample) {
    const pool = poolByItemId.get(item.id)!;
    const judgments = await judgeItem(llm, item, pool);
    judgmentsByItem.set(item.id, judgments);
    allJudgments.push(...judgments);
    console.log(`Judged ${item.id}: ${judgments.length} labels`);
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), JSON.stringify(allJudgments, null, 2));
  console.log(`Wrote eval/dataset/judgments.json: ${allJudgments.length} judgments across ${sample.length} calibration items (NOT the full pool — full-scale judging is a later, gated step)`);

  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(outDir, `${date}-calibration-sample.md`);
  writeCalibrationReport(outPath, sample, judgmentsByItem, triageByItemId);
  console.log(`Wrote calibration report to eval/results/${date}-calibration-sample.md`);
}

if (process.argv[1]?.endsWith('calibration-report.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/calibration-report.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the eval:calibration script**

Modify `package.json` scripts (after `eval:pool`):

```json
"eval:calibration": "tsx eval/pool/calibration-report.ts",
```

- [ ] **Step 6: Run the full eval test suite**

Run: `npx vitest run test/eval/`
Expected: PASS (all Tasks 1–7 tests, plus Phase 1's existing eval tests — should be 13 test files total: 5 from Phase 1 + tokens/llm/prompts/triage/author-absent/build-pool/judge/calibration-report from this plan... verify the actual count printed matches "all passing, 0 failed").

- [ ] **Step 7: Real end-to-end run (dry-run first, then for real)**

Dry-run every LLM-calling step first to sanity-check before spending real API calls:

```bash
npx tsx eval/dataset/triage.ts --dry-run
npx tsx eval/pool/calibration-report.ts --dry-run
```
Expected: both print their intended call counts/item lists and exit 0 with zero LLM calls made (the second will report "0 groups" or similar until `pool.json`/`triage-proposals.json` exist yet — that's fine, it's just confirming the flags work; the real ordered run below produces those files first).

Now run the real pipeline in order:

```bash
pnpm eval:triage
```
Expected: writes `eval/dataset/triage-proposals.json`; prints proposal count and any items flagged for drop. This makes real Sonnet calls (~3, for 74 items in chunks of 25) — inspect the output for anything alarming (e.g. most items flagged `drop: true`, which would signal a prompt problem) before continuing.

```bash
pnpm eval:author-absent
```
Expected: prints ABSENT/FOUND per candidate query with real scores, confirms 5+ absent (warns if fewer), and rewrites `eval/dataset/queries.json` with the confirmed-absent items replacing the old `<ABSENT-STUB>` placeholder. No LLM calls (pure search verification). If fewer than 5 are confirmed, inspect the printed scores — the `DEFAULT_SCORE_THRESHOLD = 0.02` in `eval/dataset/author-absent.ts` may need adjusting based on real observed scores before re-running.

```bash
pnpm eval:pool
```
Expected: writes `eval/dataset/pool.json` for every non-absent-stub item (now including the newly-authored absent items); prints item count and total candidate count. No LLM calls — takes a few minutes (comparable to Phase 1's smoke run, since it calls `store.search()` for both variants plus a keyword sweep per item).

```bash
pnpm eval:calibration
```
Expected: selects a ~20-item stratified sample (using triage-proposed categories for stratification, previewed not applied), makes real Sonnet calls (~20, one per sampled item) via `judgeItem`, writes a **partial** `eval/dataset/judgments.json` (calibration-sample items only — explicitly logged as such), and writes `eval/results/<date>-calibration-sample.md`. Read the generated markdown file to confirm it renders sensibly (query/intent/candidates/checkboxes present, triage proposals section at the top) before handing it to Tom.

- [ ] **Step 8: Update the roadmap**

In `docs/superpowers/ROADMAP.md`, mark Track A Phase 2 status: dataset triage + absent-query authoring + pooling + calibration-sample judging are done; the **human gate is now open** — record the exact path to the generated `eval/results/<date>-calibration-sample.md` and note that applying Tom's corrections + computing agreement + full-scale judging (beyond the calibration sample) are the next, still-unbuilt steps. Update "You are here" accordingly. Commit:

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs: Track A Phase 2 — triage/pool/calibration shipped, human gate open"
```

- [ ] **Step 9: Commit the code + real run artifacts**

```bash
git add eval/pool/calibration-report.ts test/eval/calibration-report.test.ts package.json \
        eval/dataset/triage-proposals.json eval/dataset/queries.json eval/dataset/pool.json \
        eval/dataset/judgments.json eval/results/*-calibration-sample.md
git commit -m "feat(eval): calibration sample selection, real judge run, markdown report

Real Phase 2 run: triage proposals for all 74 items, confirmed-absent
queries replacing the placeholder stub, full pool built for every
item, and a stratified ~20-item calibration sample judged and
rendered to markdown for human review."
```

---

## Notes for the next plan (out of scope here)

- **Applying Tom's calibration corrections + computing agreement**: parse the annotated markdown (or a simpler structured hand-back format — decide with Tom when he returns it), compute raw agreement against spec §8.3's ≥0.8 gate, update `label_provenance` to `"llm+human"` for corrected items.
- **Full-scale judging**: run `judgeItem` (Task 6, already built) over the remaining ~53 pool items beyond the calibration sample — gated on the agreement check passing.
- **Phase 3 scoring/scorecard**: consumes the completed `judgments.json` + Phase 1's `eval/results/*-runs.json`, computes recall/precision/MRR per spec §7.

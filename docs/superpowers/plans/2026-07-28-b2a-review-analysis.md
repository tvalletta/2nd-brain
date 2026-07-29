# B2a Review-Note Explanatory Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four review-note kinds' static/templated "analysis" text with real LLM-generated judgment (contradiction, duplicate, ambiguous-entity, uncertain-drop), cheap-first with a confidence-gated fallback, without ever masking a real VPN/network outage as "analysis unavailable."

**Architecture:** A shared `generateReviewAnalysis()` orchestrator (new) calls a fast-tier model first, escalates to a medium-tier model only when the fast call fails non-transiently or reports low confidence, and falls back to a static placeholder only as a last resort — a genuine `TransientLLMError` always propagates instead of degrading. Real per-call model-tier selection is added to the already-merged `createLLMFromConfig` factory (previously, `config.llm.models.{fast,medium,heavy}` existed but nothing read it). The four review-note write paths — two of which currently duplicate frontmatter-writing logic instead of sharing it — are unified onto the existing `createReviewItem()` function.

**Tech Stack:** TypeScript (ESM, strict), Zod, Vitest.

**Design spec:** `docs/superpowers/specs/2026-07-28-b2a-review-analysis-design.md`

## Global Constraints

- ESM only — all imports use `.js` extensions, even for `.ts` source files.
- Strict TypeScript — `pnpm lint` (`tsc --noEmit`) must pass with no errors.
- `pnpm build && pnpm test && pnpm lint` must all pass before any commit.
- Vitest is the test runner; tests live under `test/`, mirroring `src/` structure.
- No new runtime dependencies.
- A real `TransientLLMError` must never be caught and converted into a placeholder/fallback result anywhere in this plan's new code — it always propagates, exactly like every other LLM call site fixed in the VPN-aware-retry work (`docs/superpowers/specs/2026-07-27-vpn-aware-llm-retry-design.md`).
- Any test that exercises a code path calling `generateReviewAnalysis` (directly or transitively) MUST mock it (or its dependency `createLLMFromConfig`) — never let a test fall through to a real network call. Existing tests for `compiler.ts`'s uncertain-drop branch and (once added) `link-concepts.ts`'s ambiguous-entity branch construct a `KarpathyConfig` with Zod defaults (`provider: 'bedrock'`, no bearer token) — without a mock, `generateReviewAnalysis` would attempt a real, uncredentialed network call during `pnpm test`.
- `test/bin/intel-tick-exit.test.ts` is a known pre-existing flake in this environment (spawns the real CLI against whatever vault is configured on the host machine, unrelated to this plan) — if it's the only failure in a full `pnpm test` run, treat the run as clean.

---

### Task 1: Config schema — `review` section

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config/schema.test.ts` (extend existing file)

**Interfaces:**
- Produces: `ReviewConfigSchema` (exported Zod schema), `KarpathyConfig['review']: { analysisEnabled: boolean; confidenceEscalationThreshold: number }`.

- [ ] **Step 1: Write the failing test**

Add to `test/config/schema.test.ts` (append a new `describe` block after the existing `jobs.transientRetry` one):

```typescript
describe('KarpathyConfigSchema — review', () => {
  it('defaults review section when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.review).toEqual({
      analysisEnabled: true,
      confidenceEscalationThreshold: 0.7,
    });
  });

  it('allows overriding analysisEnabled and confidenceEscalationThreshold', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      review: { analysisEnabled: false, confidenceEscalationThreshold: 0.5 },
    });
    expect(config.review.analysisEnabled).toBe(false);
    expect(config.review.confidenceEscalationThreshold).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: FAIL — `config.review` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schema.ts`, add a new schema right after `JobsConfigSchema` (the section added by the prior VPN-retry plan):

```typescript
export const ReviewConfigSchema = z.object({
  analysisEnabled: z.boolean().default(true),
  confidenceEscalationThreshold: z.number().min(0).max(1).default(0.7),
});
```

Add `review: ReviewConfigSchema.default({}),` to `KarpathyConfigSchema`, alongside the other top-level sections (e.g. right after the existing `jobs: JobsConfigSchema.default({}),` line).

Add the partial declaration alongside the other `Partial...ConfigSchema` declarations:

```typescript
const PartialReviewConfigSchema = ReviewConfigSchema.partial();
```

Add `review: PartialReviewConfigSchema.optional(),` to both `ProjectOverrideSchema` and `GlobalDefaultsSchema`, each alongside their existing `jobs: PartialJobsConfigSchema.optional(),` line.

No changes needed in `src/config/loader.ts` — `mergeOverride()` merges every top-level key generically by name.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "feat(config): add review.analysisEnabled and review.confidenceEscalationThreshold"
```

---

### Task 2: Tier-aware `createLLMFromConfig`

**Files:**
- Modify: `src/enrichment/llm-factory.ts`
- Test: `test/enrichment/llm-factory.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `LLMTier` type from `src/config/schema.js` (already exported: `export type LLMTier = keyof LLMModelTiers;`).
- Produces: `createLLMFromConfig(config: KarpathyConfig, stateDir: string, tier?: LLMTier): LLMClient` — signature change is additive (`tier` is optional), so every existing call site (`karpathy.ts`, `intel-command.ts`, `mcp/context.ts`, `hooks/dispatch.ts`) keeps compiling and behaving identically.

- [ ] **Step 1: Write the failing test**

Add to `test/enrichment/llm-factory.test.ts` (append new tests inside the existing `describe('createLLMFromConfig', ...)` block):

```typescript
  it('uses config.llm.model when no tier is given (regression)', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: { provider: 'litellm', baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-sonnet-4-6' },
    });
    createLLMFromConfig(config, dir);
    expect(createLiteLLMClient).toHaveBeenCalledWith({
      baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-sonnet-4-6', maxTokens: config.llm.maxTokens,
    });
  });

  it('uses config.llm.models[tier] when a tier is given', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: {
        provider: 'litellm', baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-sonnet-4-6',
        models: { fast: 'claude-haiku-4.5', medium: 'claude-sonnet-4-6', heavy: 'claude-opus-4-8' },
      },
    });
    createLLMFromConfig(config, dir, 'fast');
    expect(createLiteLLMClient).toHaveBeenCalledWith({
      baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-haiku-4.5', maxTokens: config.llm.maxTokens,
    });
  });

  it('uses the medium-tier model for bedrock too', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: {
        provider: 'bedrock', region: 'us-west-2', model: 'claude-sonnet-4-6', bearerToken: 'tok',
        models: { fast: 'claude-haiku-4-5-20251001-v1:0', medium: 'claude-sonnet-4-6', heavy: 'claude-opus-4-6-v1' },
      },
    });
    createLLMFromConfig(config, dir, 'medium');
    expect(createBedrockClient).toHaveBeenCalledWith({
      region: 'us-west-2', model: 'claude-sonnet-4-6', maxTokens: config.llm.maxTokens, bearerToken: 'tok',
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/enrichment/llm-factory.test.ts`
Expected: FAIL — `createLLMFromConfig` doesn't accept a third argument yet (the two new "tier" tests will pick `config.llm.model`, not `config.llm.models[tier]`).

- [ ] **Step 3: Write minimal implementation**

Replace `src/enrichment/llm-factory.ts` in full:

```typescript
import { createBedrockClient, createLiteLLMClient, createNoopClient, type LLMClient } from './llm-client.js';
import { withConnectivityProbe } from './connectivity-probe.js';
import type { KarpathyConfig, LLMTier } from '../config/schema.js';

export function createLLMFromConfig(config: KarpathyConfig, stateDir: string, tier?: LLMTier): LLMClient {
  const model = tier ? config.llm.models[tier] : config.llm.model;

  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    const client = createLiteLLMClient({ baseUrl, apiKey, model, maxTokens: config.llm.maxTokens });
    return withConnectivityProbe(client, 'litellm', config, stateDir);
  }
  if (config.llm.provider === 'bedrock') {
    const client = createBedrockClient({
      region: config.llm.region,
      model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
    return withConnectivityProbe(client, 'bedrock', config, stateDir);
  }
  return createNoopClient();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/enrichment/llm-factory.test.ts`
Expected: PASS (all existing tests plus the three new ones)

- [ ] **Step 5: Commit**

```bash
git add src/enrichment/llm-factory.ts test/enrichment/llm-factory.test.ts
git commit -m "feat(llm): read config.llm.models[tier] when a tier is requested"
```

---

### Task 3: The four analysis prompts

**Files:**
- Create: `src/review/analysis-prompts.ts`
- Test: `test/review/analysis-prompts.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from other tasks (pure prompt/schema definitions).
- Produces: `ReviewAnalysisInput` (discriminated union type), `PROMPTS: Record<ReviewAnalysisInput['kind'], { buildPrompt: (input) => string; responseSchema: z.ZodTypeAny }>` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `test/review/analysis-prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PROMPTS } from '../../src/review/analysis-prompts.js';

describe('analysis-prompts', () => {
  it('contradiction: prompt includes both claims and titles; schema accepts a valid response', () => {
    const input = {
      kind: 'contradiction' as const,
      pageATitle: 'Deadline A',
      pageBTitle: 'Deadline B',
      claimA: 'The deadline is March 1',
      claimB: 'The deadline is not March',
    };
    const prompt = PROMPTS.contradiction.buildPrompt(input);
    expect(prompt).toContain('Deadline A');
    expect(prompt).toContain('Deadline B');
    expect(prompt).toContain('The deadline is March 1');
    expect(prompt).toContain('The deadline is not March');

    const parsed = PROMPTS.contradiction.responseSchema.parse({
      verdict: 'genuine_conflict', reasoning: 'Both discuss the same deadline with incompatible dates.', confidence: 0.9,
    });
    expect(parsed.verdict).toBe('genuine_conflict');
  });

  it('contradiction: schema rejects an invalid verdict', () => {
    expect(() =>
      PROMPTS.contradiction.responseSchema.parse({ verdict: 'maybe', reasoning: 'x', confidence: 0.5 }),
    ).toThrow();
  });

  it('duplicate: prompt includes both titles, excerpts, and the overlap percentage', () => {
    const input = {
      kind: 'duplicate' as const,
      titleA: 'Alice', titleB: 'Alice Smith',
      excerptA: 'Alice is a senior engineer.', excerptB: 'Alice Smith leads the auth team.',
      wordOverlapPercent: 72,
    };
    const prompt = PROMPTS.duplicate.buildPrompt(input);
    expect(prompt).toContain('Alice Smith');
    expect(prompt).toContain('72%');
    expect(prompt).toContain('senior engineer');

    const parsed = PROMPTS.duplicate.responseSchema.parse({
      verdict: 'same_entity', reasoning: 'Same person, different name variants.', confidence: 0.8,
    });
    expect(parsed.verdict).toBe('same_entity');
  });

  it('ambiguous_entity: prompt lists every candidate with its path and excerpt', () => {
    const input = {
      kind: 'ambiguous_entity' as const,
      entityName: 'Alex', entityKind: 'person',
      sourceContext: 'Alex reviewed the PR.',
      candidates: [
        { path: 'wiki/entities/alex-chen.md', title: 'Alex Chen', excerpt: 'Backend engineer.' },
        { path: 'wiki/entities/alex-park.md', title: 'Alex Park', excerpt: 'Product manager.' },
      ],
    };
    const prompt = PROMPTS.ambiguous_entity.buildPrompt(input);
    expect(prompt).toContain('wiki/entities/alex-chen.md');
    expect(prompt).toContain('wiki/entities/alex-park.md');
    expect(prompt).toContain('Backend engineer.');

    const parsed = PROMPTS.ambiguous_entity.responseSchema.parse({
      verdict: 'match', matchedPath: 'wiki/entities/alex-chen.md', reasoning: 'PR review fits the backend engineer.', confidence: 0.75,
    });
    expect(parsed.matchedPath).toBe('wiki/entities/alex-chen.md');
  });

  it('ambiguous_entity: matchedPath is optional (verdict can be no_match/unclear without it)', () => {
    const parsed = PROMPTS.ambiguous_entity.responseSchema.parse({
      verdict: 'no_match', reasoning: 'Neither candidate fits.', confidence: 0.6,
    });
    expect(parsed.matchedPath).toBeUndefined();
  });

  it('uncertain_entity_drop: prompt includes the gate reason, confidence, and entity context', () => {
    const input = {
      kind: 'uncertain_entity_drop' as const,
      entityName: 'Zephyr Protocol', entityKind: 'concept',
      entityContext: 'Discussed as a new sync protocol.',
      dropReason: 'sounds like generic jargon', gateConfidence: 0.4,
    };
    const prompt = PROMPTS.uncertain_entity_drop.buildPrompt(input);
    expect(prompt).toContain('Zephyr Protocol');
    expect(prompt).toContain('sounds like generic jargon');
    expect(prompt).toContain('0.40');
    expect(prompt).toContain('sync protocol');

    const parsed = PROMPTS.uncertain_entity_drop.responseSchema.parse({
      verdict: 'keep', reasoning: 'It is a specific named protocol, not generic jargon.', confidence: 0.85,
    });
    expect(parsed.verdict).toBe('keep');
  });

  it('every schema rejects a confidence outside 0-1', () => {
    expect(() =>
      PROMPTS.contradiction.responseSchema.parse({ verdict: 'unclear', reasoning: 'x', confidence: 1.5 }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/review/analysis-prompts.test.ts`
Expected: FAIL — `src/review/analysis-prompts.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/review/analysis-prompts.ts`:

```typescript
import { z } from 'zod';

export type ReviewAnalysisInput =
  | { kind: 'contradiction'; pageATitle: string; pageBTitle: string; claimA: string; claimB: string }
  | { kind: 'duplicate'; titleA: string; titleB: string; excerptA: string; excerptB: string; wordOverlapPercent: number }
  | {
      kind: 'ambiguous_entity';
      entityName: string;
      entityKind: string;
      sourceContext: string;
      candidates: Array<{ path: string; title: string; excerpt: string }>;
    }
  | {
      kind: 'uncertain_entity_drop';
      entityName: string;
      entityKind: string;
      entityContext: string;
      dropReason: string;
      gateConfidence: number;
    };

const ContradictionSchema = z.object({
  verdict: z.enum(['genuine_conflict', 'false_positive', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildContradictionPrompt(input: Extract<ReviewAnalysisInput, { kind: 'contradiction' }>): string {
  return `Two claims from a personal knowledge base were flagged as a potential contradiction by an automated heuristic (it just checks for shared subject words plus negation/date/number differences, so it produces many false positives). Judge whether these claims actually conflict.

Page A ("${input.pageATitle}"): "${input.claimA}"
Page B ("${input.pageBTitle}"): "${input.claimB}"

Decide: genuine_conflict, false_positive, or unclear. Explain in 2-3 sentences, referencing what's actually said. If there's a genuine conflict and a date makes it inferable, note which claim seems more current — the human reviewer makes the final call either way.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "genuine_conflict" | "false_positive" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const DuplicateSchema = z.object({
  verdict: z.enum(['same_entity', 'different_entities', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildDuplicatePrompt(input: Extract<ReviewAnalysisInput, { kind: 'duplicate' }>): string {
  return `Two wiki pages were flagged as possible duplicates by a heuristic (${input.wordOverlapPercent}% word overlap, plus bonuses for shared aliases/entity-kind/sources). Judge whether they describe the same real-world thing.

Page A ("${input.titleA}"): ${input.excerptA}

Page B ("${input.titleB}"): ${input.excerptB}

Decide: same_entity, different_entities, or unclear. If the same entity, say which page looks more complete/authoritative and should be kept as canonical. Explain in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "same_entity" | "different_entities" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const AmbiguousEntitySchema = z.object({
  verdict: z.enum(['match', 'no_match', 'unclear']),
  matchedPath: z.string().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildAmbiguousEntityPrompt(input: Extract<ReviewAnalysisInput, { kind: 'ambiguous_entity' }>): string {
  const candidateBlock = input.candidates
    .map((c, i) => `[${i + 1}] ${c.title} (${c.path}): ${c.excerpt}`)
    .join('\n');
  return `While processing a new mention, the entity "${input.entityName}" (${input.entityKind}) matched multiple existing pages ambiguously.

Context where it was mentioned: ${input.sourceContext}

Candidates:
${candidateBlock}

Decide: does this mention clearly match ONE of these candidates (name its exact path in matchedPath), do none of them match (no_match), or is it genuinely unclear? Explain your reasoning in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "match" | "no_match" | "unclear", "matchedPath": "<exact path from the list, only if verdict=match>", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const UncertainEntityDropSchema = z.object({
  verdict: z.enum(['keep', 'drop', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildUncertainEntityDropPrompt(input: Extract<ReviewAnalysisInput, { kind: 'uncertain_entity_drop' }>): string {
  return `An automated significance gate suggested dropping the newly-extracted entity "${input.entityName}" (${input.entityKind}) as likely noise, but wasn't confident enough (confidence ${input.gateConfidence.toFixed(2)}) to drop it outright — its page was created and flagged for review instead of being silently discarded.

Gate's stated reason: ${input.dropReason}
Context where the entity was mentioned: ${input.entityContext}

Judge independently: does this deserve to exist as its own wiki page (keep), is it genuinely low-signal noise (drop), or is it unclear? Explain your reasoning in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "keep" | "drop" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

export const PROMPTS = {
  contradiction: { buildPrompt: buildContradictionPrompt, responseSchema: ContradictionSchema },
  duplicate: { buildPrompt: buildDuplicatePrompt, responseSchema: DuplicateSchema },
  ambiguous_entity: { buildPrompt: buildAmbiguousEntityPrompt, responseSchema: AmbiguousEntitySchema },
  uncertain_entity_drop: { buildPrompt: buildUncertainEntityDropPrompt, responseSchema: UncertainEntityDropSchema },
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/review/analysis-prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/analysis-prompts.ts test/review/analysis-prompts.test.ts
git commit -m "feat(review): add the four review-analysis prompts and response schemas"
```

---

### Task 4: `generateReviewAnalysis` orchestrator

**Files:**
- Create: `src/review/generate-review-analysis.ts`
- Test: `test/review/generate-review-analysis.test.ts` (new file)

**Interfaces:**
- Consumes: `createLLMFromConfig` from Task 2 (`src/enrichment/llm-factory.js`), `PROMPTS`/`ReviewAnalysisInput` from Task 3 (`src/review/analysis-prompts.js`), `config.review.*` from Task 1, `TransientLLMError` from `src/shared/errors.js` (pre-existing), `createBudgetTrackerFromConfig` from `src/shared/budget.js` (pre-existing), `resolveStateDir` from `src/config/defaults.js` (pre-existing).
- Produces: `generateReviewAnalysis(config: KarpathyConfig, projectRoot: string, input: ReviewAnalysisInput): Promise<ReviewAnalysisResult>` and `bucketConfidence(score: number): 'low' | 'medium' | 'high'` — both consumed by Tasks 6, 7, 8. `ReviewAnalysisResult = { verdict: string; reasoning: string; confidence: number; matchedPath?: string; tier: 'fast' | 'medium' | 'placeholder' }`.

- [ ] **Step 1: Write the failing test**

Create `test/review/generate-review-analysis.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { TransientLLMError } from '../../src/shared/errors.js';

vi.mock('../../src/enrichment/llm-factory.js', () => ({
  createLLMFromConfig: vi.fn(),
}));

import { createLLMFromConfig } from '../../src/enrichment/llm-factory.js';
import { generateReviewAnalysis, bucketConfidence } from '../../src/review/generate-review-analysis.js';

function fakeClient(behavior: (prompt: string, schema: unknown) => unknown) {
  return {
    complete: async () => '',
    extractStructured: async (prompt: string, schema: unknown) => behavior(prompt, schema),
  };
}

const SAMPLE_INPUT = {
  kind: 'contradiction' as const,
  pageATitle: 'A', pageBTitle: 'B', claimA: 'claim a', claimB: 'claim b',
};

describe('bucketConfidence', () => {
  it('buckets at the documented cutoffs', () => {
    expect(bucketConfidence(0.95)).toBe('high');
    expect(bucketConfidence(0.7)).toBe('high');
    expect(bucketConfidence(0.69)).toBe('medium');
    expect(bucketConfidence(0.4)).toBe('medium');
    expect(bucketConfidence(0.39)).toBe('low');
    expect(bucketConfidence(0)).toBe('low');
  });
});

describe('generateReviewAnalysis', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-review-analysis-'));
    vi.clearAllMocks();
  });

  function config(overrides: Record<string, unknown> = {}) {
    return KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
  }

  it('returns the fast-tier result immediately when confidence is high enough', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) =>
      fakeClient(() => ({ verdict: 'genuine_conflict', reasoning: 'fast reasoning', confidence: 0.9 })) as never,
    );
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ verdict: 'genuine_conflict', reasoning: 'fast reasoning', tier: 'fast' });
    expect(createLLMFromConfig).toHaveBeenCalledTimes(1);
    expect(createLLMFromConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'fast');
  });

  it('escalates to medium when fast succeeds but confidence is below the threshold', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => ({ verdict: 'unclear', reasoning: 'fast unsure', confidence: 0.3 })) as never;
      return fakeClient(() => ({ verdict: 'false_positive', reasoning: 'medium reasoning', confidence: 0.85 })) as never;
    });
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ verdict: 'false_positive', reasoning: 'medium reasoning', tier: 'medium' });
    expect(createLLMFromConfig).toHaveBeenCalledTimes(2);
  });

  it('escalates to medium when fast throws a non-transient error', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => { throw new Error('malformed JSON'); }) as never;
      return fakeClient(() => ({ verdict: 'unclear', reasoning: 'medium fallback', confidence: 0.6 })) as never;
    });
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ tier: 'medium', reasoning: 'medium fallback' });
  });

  it('rethrows a TransientLLMError from the fast tier without touching medium or the placeholder', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation(() =>
      fakeClient(() => { throw new TransientLLMError('outage'); }) as never,
    );
    await expect(generateReviewAnalysis(config(), dir, SAMPLE_INPUT)).rejects.toBeInstanceOf(TransientLLMError);
    expect(createLLMFromConfig).toHaveBeenCalledTimes(1); // medium never attempted
  });

  it('rethrows a TransientLLMError from the medium tier', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => { throw new Error('malformed JSON'); }) as never;
      return fakeClient(() => { throw new TransientLLMError('outage'); }) as never;
    });
    await expect(generateReviewAnalysis(config(), dir, SAMPLE_INPUT)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('falls back to the low-confidence fast result when medium also fails', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => ({ verdict: 'unclear', reasoning: 'fast low-confidence', confidence: 0.2 })) as never;
      return fakeClient(() => { throw new Error('medium also broken'); }) as never;
    });
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ tier: 'fast', reasoning: 'fast low-confidence', confidence: 0.2 });
  });

  it('falls back to the placeholder when fast throws non-transiently and medium budget is exhausted', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation(() =>
      fakeClient(() => { throw new Error('broken'); }) as never,
    );
    const result = await generateReviewAnalysis(
      config({ intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 10, medium: 0, heavy: 0 } } } }),
      dir,
      SAMPLE_INPUT,
    );
    expect(result).toMatchObject({ tier: 'placeholder', verdict: 'unclear' });
  });

  it('skips straight to the placeholder when the fast budget is pre-exhausted', async () => {
    const result = await generateReviewAnalysis(
      config({ intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 0, heavy: 0 } } } }),
      dir,
      SAMPLE_INPUT,
    );
    expect(result).toMatchObject({ tier: 'placeholder' });
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('returns the placeholder immediately when review.analysisEnabled is false, without constructing any client', async () => {
    const result = await generateReviewAnalysis(config({ review: { analysisEnabled: false } }), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ tier: 'placeholder' });
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/review/generate-review-analysis.test.ts`
Expected: FAIL — `src/review/generate-review-analysis.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/review/generate-review-analysis.ts`:

```typescript
import { createLLMFromConfig } from '../enrichment/llm-factory.js';
import { createBudgetTrackerFromConfig } from '../shared/budget.js';
import { resolveStateDir } from '../config/defaults.js';
import { TransientLLMError } from '../shared/errors.js';
import type { KarpathyConfig } from '../config/schema.js';
import { PROMPTS, type ReviewAnalysisInput } from './analysis-prompts.js';

export type { ReviewAnalysisInput } from './analysis-prompts.js';

export interface ReviewAnalysisResult {
  verdict: string;
  reasoning: string;
  confidence: number;
  matchedPath?: string;
  tier: 'fast' | 'medium' | 'placeholder';
}

const PLACEHOLDER_TEXT: Record<ReviewAnalysisInput['kind'], string> = {
  contradiction: 'Pending human review.',
  duplicate: 'Pending human review — LLM analysis unavailable.',
  ambiguous_entity: 'Multiple pages match this entity. Please review and resolve manually.',
  uncertain_entity_drop: 'Pending human review — LLM analysis unavailable.',
};

function placeholderResult(kind: ReviewAnalysisInput['kind']): ReviewAnalysisResult {
  return { verdict: 'unclear', reasoning: PLACEHOLDER_TEXT[kind], confidence: 0, tier: 'placeholder' };
}

export function bucketConfidence(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

export async function generateReviewAnalysis(
  config: KarpathyConfig,
  projectRoot: string,
  input: ReviewAnalysisInput,
): Promise<ReviewAnalysisResult> {
  if (!config.review.analysisEnabled) return placeholderResult(input.kind);

  const budget = createBudgetTrackerFromConfig(config, projectRoot);
  const stateDir = resolveStateDir(config);
  const { buildPrompt, responseSchema } = PROMPTS[input.kind];
  const prompt = buildPrompt(input as never);
  const threshold = config.review.confidenceEscalationThreshold;

  let fastResult: ReviewAnalysisResult | null = null;

  if (budget.tryReserve('fast')) {
    try {
      const fastClient = createLLMFromConfig(config, stateDir, 'fast');
      const parsed = await fastClient.extractStructured(prompt, responseSchema);
      fastResult = { ...parsed, tier: 'fast' };
      if (parsed.confidence >= threshold) return fastResult;
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      // non-transient (e.g. malformed JSON) — fall through to medium escalation
    }
  }

  if (budget.tryReserve('medium')) {
    try {
      const mediumClient = createLLMFromConfig(config, stateDir, 'medium');
      const parsed = await mediumClient.extractStructured(prompt, responseSchema);
      return { ...parsed, tier: 'medium' };
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      // both tiers failed for real content/parsing reasons — fall through
    }
  }

  return fastResult ?? placeholderResult(input.kind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/review/generate-review-analysis.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/generate-review-analysis.ts test/review/generate-review-analysis.test.ts
git commit -m "feat(review): add generateReviewAnalysis orchestrator with confidence-gated tier fallback"
```

---

### Task 5: `createReviewItem` confidence field

**Files:**
- Modify: `src/review/create-review-item.ts`
- Test: `test/review/create-review-item.test.ts` (extend existing file)

**Interfaces:**
- Produces: `ReviewItemInput` gains `confidence?: 'low' | 'medium' | 'high'` (optional, defaults to `'low'`) — consumed by Tasks 6, 7, 8.

- [ ] **Step 1: Write the failing test**

Add to `test/review/create-review-item.test.ts` (append inside the existing `describe('createReviewItem', ...)` block):

```typescript
  it('defaults confidence to low when omitted (regression)', async () => {
    const path = await createReviewItem(vault, {
      slug: 'no-confidence', title: 'T', claimA: 'a', claimB: 'b',
      sourceRefs: [], links: [], conflictType: 'potential_factual', body: 'body',
    });
    const { data } = parseNote(await vault.read(path));
    expect(data.confidence).toBe('low');
  });

  it('uses the provided confidence bucket when given', async () => {
    const path = await createReviewItem(vault, {
      slug: 'high-confidence', title: 'T', claimA: 'a', claimB: 'b',
      sourceRefs: [], links: [], conflictType: 'potential_factual', body: 'body', confidence: 'high',
    });
    const { data } = parseNote(await vault.read(path));
    expect(data.confidence).toBe('high');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/review/create-review-item.test.ts`
Expected: FAIL — TypeScript error (`confidence` not in `ReviewItemInput`) on the second new test; the first passes already (todays's hardcoded `'low'`) but run both together to confirm the type error surfaces first.

- [ ] **Step 3: Write minimal implementation**

In `src/review/create-review-item.ts`, add the field to the interface:

```typescript
export interface ReviewItemInput {
  slug: string;
  title: string;
  claimA: string;
  claimB: string;
  sourceRefs: string[];
  links: string[];
  conflictType: string;
  body: string;
  /** LLM-assessed confidence bucket. Defaults to 'low' (today's hardcoded value) when omitted. */
  confidence?: 'low' | 'medium' | 'high';
}
```

Change the frontmatter object's hardcoded line:
```typescript
    confidence: 'low',
```
to:
```typescript
    confidence: input.confidence ?? 'low',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/review/create-review-item.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/create-review-item.ts test/review/create-review-item.test.ts
git commit -m "feat(review): let createReviewItem accept an LLM-assessed confidence bucket"
```

---

### Task 6: Unify contradiction & duplicate detectors onto `createReviewItem`

**Files:**
- Modify: `src/review/contradiction-detector.ts`
- Modify: `src/review/duplicate-detector.ts`
- Modify: `src/jobs/handlers/detect-contradictions.ts`
- Modify: `src/jobs/handlers/detect-duplicates.ts`
- Test: `test/review/review.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `generateReviewAnalysis`/`bucketConfidence` from Task 4, `createReviewItem` (with the new `confidence` field) from Task 5.
- Produces: `writeContradictionReview(vault, config, projectRoot, candidate): Promise<string>` and `writeDuplicateReview(vault, config, projectRoot, candidate): Promise<string>` — signature change (two new required params) is a breaking change to these two functions specifically; both callers (the two handlers) are updated in this same task.

- [ ] **Step 1: Write the failing test**

Replace the two `'writes ... review note'` tests in `test/review/review.test.ts` (they currently call `writeContradictionReview(vault, candidate)`/`writeDuplicateReview(vault, candidate)` with two args — both must change to mock `generateReviewAnalysis` and pass `config`/`projectRoot`). Add these imports at the top of the file:

```typescript
import { KarpathyConfigSchema } from '../../src/config/schema.js';

vi.mock('../../src/review/generate-review-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/generate-review-analysis.js')>();
  return { ...actual, generateReviewAnalysis: vi.fn() };
});
```

(add `vi` to the existing `import { describe, it, expect, beforeEach, afterEach } from 'vitest';` line, making it `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`)

Then, right after those imports:

```typescript
import { generateReviewAnalysis } from '../../src/review/generate-review-analysis.js';
```

Replace the existing `'writes contradiction review note'` test:

```typescript
  it('writes contradiction review note with the generated analysis', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'genuine_conflict', reasoning: 'These claims directly conflict on the deadline date.', confidence: 0.85, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({ vaultPath: tempDir });
    const candidate = {
      pageA: 'wiki/decisions/a.md',
      pageB: 'wiki/decisions/b.md',
      claimA: 'Deadline is March',
      claimB: 'Deadline is not March',
      conflictType: 'potential_factual',
      reviewPath: 'review/test-contradiction.md',
    };

    const path = await writeContradictionReview(vault, config, tempDir, candidate);
    expect(await vault.exists(path)).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain('Contradiction');
    expect(content).toContain('Deadline is March');
    expect(content).toContain('unreviewed');
    expect(content).toContain('These claims directly conflict on the deadline date.');
    expect(content).toContain('genuine_conflict');

    const { data } = parseNote(content);
    expect(data.confidence).toBe('high');
  });
```

(add `import { parseNote } from '../../src/vault/frontmatter.js';` to the top imports if not already present)

Replace the existing `'writes duplicate review note'` test:

```typescript
  it('writes duplicate review note with the generated analysis', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'same_entity', reasoning: 'Both describe the same engineer; Alice Smith is more complete.', confidence: 0.3, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({ vaultPath: tempDir });
    const candidate = {
      pathA: 'wiki/entities/alice.md',
      pathB: 'wiki/entities/alice-smith.md',
      titleA: 'Alice',
      titleB: 'Alice Smith',
      similarity: 85,
      reviewPath: 'review/duplicate-alice.md',
    };

    const path = await writeDuplicateReview(vault, config, tempDir, candidate);
    expect(await vault.exists(path)).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain('85%');
    expect(content).toContain('Alice');
    expect(content).toContain('Alice Smith is more complete.');

    const { data } = parseNote(content);
    expect(data.confidence).toBe('low');
  });
```

Note: `tempDir` is the `let tempDir: string;` variable already declared in each `describe` block's scope in this file — the two edited tests live in the `'Contradiction detection'` and `'Duplicate detection'` `describe` blocks respectively, each of which already has its own `tempDir`/`vault` via `beforeEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/review/review.test.ts`
Expected: FAIL — `writeContradictionReview`/`writeDuplicateReview` don't accept 4 arguments yet (TypeScript error), and `generateReviewAnalysis` isn't mocked-and-consumed by the current implementation.

- [ ] **Step 3: Write minimal implementation**

In `src/review/contradiction-detector.ts`, add imports:

```typescript
import type { KarpathyConfig } from '../config/schema.js';
import { generateReviewAnalysis, bucketConfidence } from './generate-review-analysis.js';
import { createReviewItem } from './create-review-item.js';
```

Replace `writeContradictionReview` in full:

```typescript
export async function writeContradictionReview(
  vault: VaultAdapter,
  config: KarpathyConfig,
  projectRoot: string,
  candidate: ContradictionCandidate,
): Promise<string> {
  const titleA = candidate.pageA.split('/').pop()?.replace(/\.md$/, '') ?? candidate.pageA;
  const titleB = candidate.pageB.split('/').pop()?.replace(/\.md$/, '') ?? candidate.pageB;

  const analysis = await generateReviewAnalysis(config, projectRoot, {
    kind: 'contradiction',
    pageATitle: titleA,
    pageBTitle: titleB,
    claimA: candidate.claimA,
    claimB: candidate.claimB,
  });

  const body = `
# Contradiction Candidate

## Page A
**Source:** [[${titleA}]]
> ${candidate.claimA}

## Page B
**Source:** [[${titleB}]]
> ${candidate.claimB}

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}

**Verdict:** ${analysis.verdict} (confidence: ${analysis.confidence.toFixed(2)})
${CLOSE_TAG('analysis')}
`;

  const slug = candidate.reviewPath.replace(/^review\//, '').replace(/\.md$/, '');

  const path = await createReviewItem(vault, {
    slug,
    title: `Contradiction: ${candidate.pageA} vs ${candidate.pageB}`,
    claimA: candidate.claimA,
    claimB: candidate.claimB,
    sourceRefs: [candidate.pageA, candidate.pageB],
    links: [candidate.pageA, candidate.pageB],
    conflictType: candidate.conflictType,
    confidence: bucketConfidence(analysis.confidence),
    body,
  });

  log.info('Contradiction review created', { path });
  return path;
}
```

This deletes the old `frontmatter`/`serializeNote`/`vault.exists`/`vault.write`/`vault.create` block entirely — `createReviewItem` already does exactly that. The `nanoid`, `serializeNote` imports may now be unused in this file — check with `grep -n "nanoid\|serializeNote" src/review/contradiction-detector.ts` after the edit and remove any import no longer referenced (the detection logic above `writeContradictionReview` doesn't use them, only the old write code did).

In `src/review/duplicate-detector.ts`, same shape. Add the same three imports (adjusting nothing — same relative depth). `PageInfo` and `DuplicateCandidate` each gain an excerpt field:

```typescript
interface PageInfo {
  path: string;
  title: string;
  words: Set<string>;
  excerpt: string;
  entityKind?: string;
  aliases: string[];
  sourceRefs: string[];
}
```

In `detectDuplicates`'s existing per-page loop, add one field to the pushed `PageInfo`:
```typescript
    pages.push({
      path,
      title,
      words,
      excerpt: body.trim().slice(0, 400),
      entityKind: data.entity_kind as string | undefined,
      aliases: (data.aliases as string[] | undefined) ?? [],
      sourceRefs: (data.source_refs as string[] | undefined) ?? [],
    });
```

`DuplicateCandidate` gains two fields:
```typescript
export interface DuplicateCandidate {
  pathA: string;
  pathB: string;
  titleA: string;
  titleB: string;
  excerptA: string;
  excerptB: string;
  similarity: number;
  reviewPath: string;
}
```

Populate them where candidates are built:
```typescript
        candidates.push({
          pathA: pages[i].path,
          pathB: pages[j].path,
          titleA: pages[i].title,
          titleB: pages[j].title,
          excerptA: pages[i].excerpt,
          excerptB: pages[j].excerpt,
          similarity: Math.round(sim * 100),
          reviewPath: `review/${slug}.md`,
        });
```

Replace `writeDuplicateReview` in full:

```typescript
export async function writeDuplicateReview(
  vault: VaultAdapter,
  config: KarpathyConfig,
  projectRoot: string,
  candidate: DuplicateCandidate,
): Promise<string> {
  const analysis = await generateReviewAnalysis(config, projectRoot, {
    kind: 'duplicate',
    titleA: candidate.titleA,
    titleB: candidate.titleB,
    excerptA: candidate.excerptA,
    excerptB: candidate.excerptB,
    wordOverlapPercent: candidate.similarity,
  });

  const body = `
# Duplicate Candidate (${candidate.similarity}% similarity)

## Page A
**[[${candidate.titleA}]]** — \`${candidate.pathA}\`

## Page B
**[[${candidate.titleB}]]** — \`${candidate.pathB}\`

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}

**Verdict:** ${analysis.verdict} (confidence: ${analysis.confidence.toFixed(2)})
${CLOSE_TAG('analysis')}
`;

  const slug = candidate.reviewPath.replace(/^review\//, '').replace(/\.md$/, '');

  const path = await createReviewItem(vault, {
    slug,
    title: `Duplicate: ${candidate.titleA} / ${candidate.titleB}`,
    claimA: `Page: ${candidate.titleA}`,
    claimB: `Page: ${candidate.titleB}`,
    sourceRefs: [candidate.pathA, candidate.pathB],
    links: [candidate.pathA, candidate.pathB],
    conflictType: 'duplicate_candidate',
    confidence: bucketConfidence(analysis.confidence),
    body,
  });

  log.info('Duplicate review created', { path });
  return path;
}
```

Same cleanup check: `grep -n "nanoid\|serializeNote" src/review/duplicate-detector.ts` after editing, remove now-unused imports.

In `src/jobs/handlers/detect-contradictions.ts`, change the call site:
```typescript
      await writeContradictionReview(context.vault, context.config, context.projectRoot, candidate);
```

In `src/jobs/handlers/detect-duplicates.ts`, change the call site:
```typescript
      await writeDuplicateReview(context.vault, context.config, context.projectRoot, candidate);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/review/review.test.ts test/jobs/handlers/detect-contradictions.test.ts test/jobs/handlers/detect-duplicates.test.ts`
Expected: PASS — the two handler tests are unaffected (they only exercise the empty-vault/0-candidates path, so `writeContradictionReview`/`writeDuplicateReview` are never actually invoked there).

- [ ] **Step 5: Commit**

```bash
git add src/review/contradiction-detector.ts src/review/duplicate-detector.ts src/jobs/handlers/detect-contradictions.ts src/jobs/handlers/detect-duplicates.ts test/review/review.test.ts
git commit -m "feat(review): unify contradiction/duplicate review notes onto createReviewItem with real analysis"
```

---

### Task 7: Ambiguous-entity integration (`link-concepts.ts`)

**Files:**
- Modify: `src/jobs/handlers/link-concepts.ts`
- Test: `test/jobs/handlers/link-concepts.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `generateReviewAnalysis`/`bucketConfidence` from Task 4.
- Produces: nothing new — this is a leaf consumer.

- [ ] **Step 1: Write the failing test**

Add to `test/jobs/handlers/link-concepts.test.ts`. First add near the top, alongside existing imports:

```typescript
import { parseNote } from '../../../src/vault/frontmatter.js';

vi.mock('../../../src/review/generate-review-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/review/generate-review-analysis.js')>();
  return { ...actual, generateReviewAnalysis: vi.fn() };
});
```

(add `vi` to the existing `import { describe, it, expect, beforeEach, afterEach } from 'vitest';` line)

Then, right after:

```typescript
import { generateReviewAnalysis } from '../../../src/review/generate-review-analysis.js';
```

Add a new test inside `describe('link-concepts handler', ...)`:

```typescript
  it('writes an ambiguous-entity review note with the generated analysis, validating a real matchedPath', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/alex-chen.md',
      serializeNote(
        { id: 'e1', type: 'entity', title: 'Alex Chen', canonical_name: 'Alex Chen', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Chen\n\nBackend engineer.\n',
      ),
    );
    await vault.create(
      'Curated/wiki/entities/alex-park.md',
      serializeNote(
        { id: 'e2', type: 'entity', title: 'Alex Park', canonical_name: 'Alex Park', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Park\n\nProduct manager.\n',
      ),
    );
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'match', matchedPath: 'Curated/wiki/entities/alex-chen.md',
      reasoning: 'The PR-review context fits the backend engineer.', confidence: 0.8, tier: 'fast',
    });

    const summaryPath = 'sources/s1.md';
    await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
    const ctx = makeCtx();
    await linkConceptsHandler.execute(
      makeJob(summaryPath, { people: [{ name: 'Alex', context: 'Alex reviewed the PR.' }] }),
      ctx,
    );

    const reviewFiles = await vault.listMarkdownFiles('review');
    expect(reviewFiles).toHaveLength(1);
    const content = await vault.read(reviewFiles[0]);
    expect(content).toContain('The PR-review context fits the backend engineer.');
    expect(content).toContain('alex-chen');
    const { data } = parseNote(content);
    expect(data.confidence).toBe('high');
  });

  it('does not trust a matchedPath the model invented outside the real candidate list', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/alex-chen.md',
      serializeNote(
        { id: 'e1', type: 'entity', title: 'Alex Chen', canonical_name: 'Alex Chen', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Chen\n\nBackend engineer.\n',
      ),
    );
    await vault.create(
      'Curated/wiki/entities/alex-park.md',
      serializeNote(
        { id: 'e2', type: 'entity', title: 'Alex Park', canonical_name: 'Alex Park', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Park\n\nProduct manager.\n',
      ),
    );
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'match', matchedPath: 'Curated/wiki/entities/someone-else.md', // not a real candidate
      reasoning: 'Hallucinated match.', confidence: 0.8, tier: 'fast',
    });

    const summaryPath = 'sources/s1.md';
    await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
    const ctx = makeCtx();
    await linkConceptsHandler.execute(
      makeJob(summaryPath, { people: [{ name: 'Alex', context: 'Alex reviewed the PR.' }] }),
      ctx,
    );

    const reviewFiles = await vault.listMarkdownFiles('review');
    const content = await vault.read(reviewFiles[0]);
    expect(content).not.toContain('Suggested match');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/jobs/handlers/link-concepts.test.ts`
Expected: FAIL — the two new tests exercise the ambiguous branch, which today writes the old generic checklist text, not the mocked analysis's reasoning; `generateReviewAnalysis` isn't called by the current implementation.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/handlers/link-concepts.ts`, add imports:

```typescript
import { generateReviewAnalysis, bucketConfidence } from '../../review/generate-review-analysis.js';
```

Replace the body of the `resolution.status === 'ambiguous'` branch:

```typescript
        } else if (resolution.status === 'ambiguous') {
          const candidates = resolution.candidates ?? [];
          const candidateList = candidates
            .map((c) => `- [[${c.path.split('/').pop()?.replace(/\.md$/, '')}]] (confidence: ${c.confidence.toFixed(2)})`)
            .join('\n');

          const candidateDetails = await Promise.all(
            candidates.map(async (c) => {
              const noteContent = await context.vault.read(c.path);
              const { data, body } = parseNote(noteContent);
              return {
                path: c.path,
                title: (data.title as string) ?? c.path.split('/').pop()?.replace(/\.md$/, '') ?? c.path,
                excerpt: body.replace(/%%[\s\S]*?%%/g, '').trim().slice(0, 300),
              };
            }),
          );

          const analysis = await generateReviewAnalysis(context.config, context.projectRoot, {
            kind: 'ambiguous_entity',
            entityName: entity.name,
            entityKind: kind,
            sourceContext: entity.context ?? entity.definition ?? '(no additional context)',
            candidates: candidateDetails,
          });

          const validatedMatch =
            analysis.verdict === 'match' && candidateDetails.some((c) => c.path === analysis.matchedPath)
              ? analysis.matchedPath
              : undefined;

          const matchNote = validatedMatch
            ? `\n\n**Suggested match:** [[${validatedMatch.split('/').pop()?.replace(/\.md$/, '')}]] (unconfirmed — approve or dismiss below)`
            : '';

          await createReviewItem(context.vault, {
            slug: slugify(`ambiguous-${entity.name}`),
            title: `Ambiguous: ${entity.name} (${kind})`,
            claimA: `Entity "${entity.name}" found in ${summaryPath}`,
            claimB: `Multiple matching pages: ${candidates.map((c) => c.path).join(', ')}`,
            sourceRefs: [summaryPath],
            links: candidates.map((c) => c.path),
            conflictType: 'ambiguous_entity',
            confidence: bucketConfidence(analysis.confidence),
            body: `
# Ambiguous Entity: ${entity.name}

**Kind:** ${kind}
**Source:** [[${summaryPath.split('/').pop()?.replace(/\.md$/, '')}]]

## Candidates
${candidateList}

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}${matchNote}
${CLOSE_TAG('analysis')}
`,
          });
          log.warn('Ambiguous entity resolution', { name: entity.name, kind, candidates: candidates.length });
        }
```

`parseNote` must already be imported in this file for this to type-check — check `grep -n "^import" src/jobs/handlers/link-concepts.ts` first; if `parseNote` isn't already imported (it wasn't needed by this file before), add `import { parseNote } from '../../vault/frontmatter.js';` alongside the existing imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/jobs/handlers/link-concepts.test.ts`
Expected: PASS (both new tests, plus all pre-existing tests in this file unaffected — none of them exercise the `ambiguous` branch today, confirmed by the grep in Task 7's context-gathering step, so no existing assertions change meaning)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/handlers/link-concepts.ts test/jobs/handlers/link-concepts.test.ts
git commit -m "feat(review): generate real analysis for ambiguous-entity review notes"
```

---

### Task 8: Uncertain-drop integration (`compiler.ts`)

**Files:**
- Modify: `src/compilation/compiler.ts`
- Test: `test/compilation/compiler.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `generateReviewAnalysis`/`bucketConfidence` from Task 4.
- Produces: nothing new — leaf consumer. This task also fixes a real gap: the `try/catch` around the review-item write in the uncertain-drop branch today only exists to contain a file-write failure (e.g. `EISDIR`) without crashing the whole compile — but once `generateReviewAnalysis` runs inside that same `try`, a real `TransientLLMError` would be silently absorbed by it unless explicitly let through.

- [ ] **Step 1: Write the failing test**

Add to `test/compilation/compiler.test.ts`, inside the existing `describe('compileFromSource — significance gate integration', ...)` block (near the two existing `'llm mode: uncertain drop ...'` tests). First, add near the top of the file, alongside existing imports:

```typescript
vi.mock('../../src/review/generate-review-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/generate-review-analysis.js')>();
  return { ...actual, generateReviewAnalysis: vi.fn() };
});
```

(add `vi` to the existing `import { describe, it, expect, beforeEach, afterEach } from 'vitest';` line)

Then, right after:

```typescript
import { generateReviewAnalysis } from '../../src/review/generate-review-analysis.js';
import { TransientLLMError } from '../../src/shared/errors.js';
```

(`TransientLLMError` is likely already imported in this file from the earlier VPN-retry work's Task 8 — check `grep -n "TransientLLMError" test/compilation/compiler.test.ts` first and don't duplicate the import if it's already there.)

Update the existing `'llm mode: uncertain drop (low confidence) still creates the page AND flags it for review'` test to mock `generateReviewAnalysis` (it will now be called, and without a mock would attempt a real, uncredentialed network call):

```typescript
  it('llm mode: uncertain drop (low confidence) still creates the page AND flags it for review', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'keep', reasoning: 'It is a specific term, not generic jargon.', confidence: 0.6, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    const llm = makeLLM({ action: 'drop', reason: 'maybe jargon', confidence: 0.4 });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });
    expect(result.created).toHaveLength(1);
    const reviewFiles = await vault.listMarkdownFiles('review');
    expect(reviewFiles).toHaveLength(1);
    const { data } = parseNote(await vault.read(reviewFiles[0]));
    expect(data.conflict_type).toBe('uncertain_entity_drop');
    expect(data.links).toEqual(result.created);
    const content = await vault.read(reviewFiles[0]);
    expect(content).toContain('It is a specific term, not generic jargon.');
  });
```

Update the existing `'llm mode: uncertain drop whose review-item write fails does not crash ...'` test the same way — add the `generateReviewAnalysis` mock at its start (it exercises the same branch and would otherwise attempt a real network call):

```typescript
  it('llm mode: uncertain drop whose review-item write fails does not crash — entity still ends up in result.created', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'keep', reasoning: 'Specific term.', confidence: 0.6, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({
      // ...unchanged from here down...
```

(only the mock line is new; the rest of that test's body is unchanged)

Add a new test proving the `TransientLLMError` propagation fix:

```typescript
  it('a TransientLLMError from generateReviewAnalysis during the uncertain-drop review-item write propagates instead of being swallowed', async () => {
    vi.mocked(generateReviewAnalysis).mockRejectedValue(new TransientLLMError('outage'));
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    const llm = makeLLM({ action: 'drop', reason: 'maybe jargon', confidence: 0.4 });

    await expect(
      compileFromSource('sources/s1.md', [makeEntity()], { vault, llm, config, projectRoot: dir }),
    ).rejects.toBeInstanceOf(TransientLLMError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/compilation/compiler.test.ts`
Expected: FAIL — the two existing uncertain-drop tests will fail (the review note doesn't yet contain the mocked reasoning text, since `generateReviewAnalysis` isn't called by the current code) and the new `TransientLLMError` test fails (today's `catch (err) { log.error(...) }` swallows it instead of propagating).

- [ ] **Step 3: Write minimal implementation**

In `src/compilation/compiler.ts`, add the import:

```typescript
import { generateReviewAnalysis, bucketConfidence } from '../review/generate-review-analysis.js';
```

Replace the uncertain-drop review-item block:

```typescript
      if (flaggedForReview) {
        try {
          const analysis = await generateReviewAnalysis(config, projectRoot, {
            kind: 'uncertain_entity_drop',
            entityName: entity.name,
            entityKind: entity.kind,
            entityContext: entity.context,
            dropReason: flaggedForReview.reason,
            gateConfidence: flaggedForReview.confidence ?? 0,
          });

          await createReviewItem(vault, {
            slug: `uncertain-drop-${slug}`,
            title: `Uncertain: ${entity.name} (${entity.kind})`,
            claimA: `Significance gate suggested dropping this entity: ${flaggedForReview.reason}`,
            claimB: `Confidence ${flaggedForReview.confidence} is below the review threshold (${config.enrichment.significanceGateDropConfidence})`,
            sourceRefs: [sourcePath],
            links: [createdPath],
            conflictType: 'uncertain_entity_drop',
            confidence: bucketConfidence(analysis.confidence),
            body: `
# Uncertain: ${entity.name}

**Kind:** ${entity.kind}
**Page created:** [[${slug}]]
**Source:** [[${sourcePath.split('/').pop()?.replace(/\.md$/, '')}]]

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}

**Verdict:** ${analysis.verdict} (confidence: ${analysis.confidence.toFixed(2)})
${CLOSE_TAG('analysis')}
`,
          });
        } catch (err) {
          if (err instanceof TransientLLMError) throw err;
          log.error('Failed to create review item for uncertain drop; entity page was created but is unflagged', {
            name: entity.name,
            path: createdPath,
            error: (err as Error).message,
          });
        }
      }
```

(`TransientLLMError` is already imported in `compiler.ts` from the earlier VPN-retry work — no new import needed for the production file, only confirm it's there via `grep -n "TransientLLMError" src/compilation/compiler.ts` before assuming.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/compilation/compiler.test.ts`
Expected: PASS (all tests in the file, including the two updated ones and the new propagation test)

- [ ] **Step 5: Commit**

```bash
git add src/compilation/compiler.ts test/compilation/compiler.test.ts
git commit -m "feat(review): generate real analysis for uncertain-drop review notes; let TransientLLMError propagate through the write"
```

---

## Post-plan manual verification (not automated)

With a real vault and `config.llm.provider: 'litellm'` (or `'bedrock'` with a bearer token):
1. Trigger each of the four review-note-producing paths at least once (e.g. `karpathy review detect` for contradiction/duplicate; ingest content with a genuinely ambiguous entity name; ingest content with a low-signal entity that the significance gate flags uncertain).
2. Open each resulting note under `review/` and confirm the Analysis section contains real, content-grounded reasoning — not the old static placeholder text.
3. Temporarily set `review.confidenceEscalationThreshold: 1.0` (forces every fast-tier result to escalate) and confirm a medium-tier call actually fires (check logs for the `tier: 'medium'` outcome) and the note still gets written correctly.
4. Temporarily set `review.analysisEnabled: false` and confirm all four paths fall back to today's placeholder text with no LLM calls at all.

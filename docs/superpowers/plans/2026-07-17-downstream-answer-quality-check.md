# Downstream Answer-Quality Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test whether retrieval differences between grep-first, as-deployed, and full-cov-hybrid actually change the final answer a user gets — not just which documents get returned — for the items where variants genuinely disagree.

**Architecture:** Task 1 computes the real disagreement-item sample from existing `runs.json`/`judgments.json` data (no new retrieval needed to identify it). Task 2 generates a real answer per item per contending variant, using a fixed prompt and each variant's actual retrieved document content. Task 3 does blind pairwise LLM judging with seeded randomized A/B assignment, aggregates results, and renders a report.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, existing `eval/pool/llm.ts` (`createLLMForTier`), existing `LLMClient` interface (`complete`/`extractStructured`), existing `mulberry32` seeded-PRNG convention (`eval/score/bootstrap.ts`).

## Global Constraints

- Depends on `2026-07-17-eval-methodology-hardening.md` Task 4 (eval expansion) and Task 8 (final re-run) having landed first — this plan's sample selection should run against the largest, most current disagreement-item pool, not the pre-expansion 89-item dataset.
- `RunHit` (`eval/run/types.ts:20-27`) only carries `path` and `excerpt`, not full note text — answer generation must read each retrieved doc's real full content via `VaultAdapter.read(path): Promise<string>`, not rely on the excerpt.
- `EvalItem.subtype` is a closed union (`'lookup' | 'synthesis' | 'relationship' | 'absent'`) — unchanged by this plan.
- `LLMClient` (`src/enrichment/llm-client.ts`): `complete(prompt, options?): Promise<string>` and `extractStructured<T>(prompt, schema): Promise<T>`. `createLLMForTier(config, tier, maxTokensOverride?)` (`eval/pool/llm.ts`) constructs one.
- Use the `heavy` tier for the blind pairwise judge (matches the existing dual-judge convention's higher-quality tier), a cheaper tier (e.g. `medium`) for answer generation.
- All new files use `.js` extensions on relative imports.
- Long-running LLM-backed commands in this project's eval pipeline have repeatedly been silently auto-backgrounded and killed — verify real completion via output file state, never command return alone.

---

### Task 1: Disagreement-item sample selection

**Files:**
- Create: `eval/report/answer-quality-sample.ts`
- Test: `test/eval/answer-quality-sample.test.ts`

**Interfaces:**
- Produces: `computeDisagreementSample(runsResults: RunResult[], judgments: Judgment[], contenders: string[]): DisagreementItem[]`, where `DisagreementItem = { itemId: string; query: string; variantHits: Record<string, { docIds: string[] }> }` (used by Task 2).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeDisagreementSample } from '../../eval/report/answer-quality-sample.js';
import type { RunResult } from '../../eval/run/types.js';
import type { Judgment } from '../../eval/pool/judge.js';

function hit(path: string, rank: number): RunResult['returned'][number] {
  return { path, rank, final: 1 - rank * 0.1, excerpt: '' };
}

describe('computeDisagreementSample', () => {
  it('includes an item where variants retrieve different top-3 sets and ground truth has a relevant doc only some variants found', () => {
    const runsResults: RunResult[] = [
      { itemId: 'fuzzy-002', variant: 'grep-first', query: 'q', returned: [hit('docA.md', 0)], searchMode: 'keyword-only', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
      { itemId: 'fuzzy-002', variant: 'as-deployed', query: 'q', returned: [hit('docB.md', 0)], searchMode: 'hybrid', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
    ];
    const judgments: Judgment[] = [
      { item_id: 'fuzzy-002', doc_id: 'docB.md', label: 2, reason: 'r', label_provenance: 'llm' },
    ];
    const result = computeDisagreementSample(runsResults, judgments, ['grep-first', 'as-deployed']);
    expect(result).toHaveLength(1);
    expect(result[0].itemId).toBe('fuzzy-002');
    expect(result[0].variantHits['grep-first'].docIds).toEqual(['docA.md']);
    expect(result[0].variantHits['as-deployed'].docIds).toEqual(['docB.md']);
  });

  it('excludes an item where all variants retrieve the identical top-3 set', () => {
    const runsResults: RunResult[] = [
      { itemId: 'plaud-001', variant: 'grep-first', query: 'q', returned: [hit('docA.md', 0)], searchMode: 'keyword-only', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
      { itemId: 'plaud-001', variant: 'as-deployed', query: 'q', returned: [hit('docA.md', 0)], searchMode: 'hybrid', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
    ];
    const judgments: Judgment[] = [
      { item_id: 'plaud-001', doc_id: 'docA.md', label: 2, reason: 'r', label_provenance: 'llm' },
    ];
    const result = computeDisagreementSample(runsResults, judgments, ['grep-first', 'as-deployed']);
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/answer-quality-sample.test.ts`
Expected: FAIL — `eval/report/answer-quality-sample.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `eval/report/answer-quality-sample.ts`:

```ts
import type { RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';

export interface DisagreementItem {
  itemId: string;
  query: string;
  variantHits: Record<string, { docIds: string[] }>;
}

/** Finds items where at least two contenders disagree on their top-3
 * retrieved doc set in a way that matters: some relevant document (label
 * >= 1) was retrieved by at least one contender's top-3 but not by
 * another's. Items where every contender's top-3 sets are identical are
 * excluded — there's no retrieval difference for a downstream answer to
 * possibly reflect (spec: downstream-answer-quality-check-design.md §3). */
export function computeDisagreementSample(
  runsResults: RunResult[],
  judgments: Judgment[],
  contenders: string[],
): DisagreementItem[] {
  const relevantByItem = new Map<string, Set<string>>();
  for (const j of judgments) {
    if (j.label < 1) continue;
    if (!relevantByItem.has(j.item_id)) relevantByItem.set(j.item_id, new Set());
    relevantByItem.get(j.item_id)!.add(j.doc_id);
  }

  const itemIds = new Set(runsResults.map((r) => r.itemId));
  const sample: DisagreementItem[] = [];

  for (const itemId of itemIds) {
    const variantHits: Record<string, { docIds: string[] }> = {};
    let query = '';
    for (const contender of contenders) {
      const result = runsResults.find((r) => r.itemId === itemId && r.variant === contender);
      if (!result) continue;
      query = result.query;
      const top3 = [...result.returned].sort((a, b) => a.rank - b.rank).slice(0, 3);
      variantHits[contender] = { docIds: top3.map((h) => h.path) };
    }

    const presentContenders = Object.keys(variantHits);
    if (presentContenders.length < 2) continue;

    const allSetsIdentical = presentContenders.every((c) => {
      const a = new Set(variantHits[c].docIds);
      const b = new Set(variantHits[presentContenders[0]].docIds);
      return a.size === b.size && [...a].every((x) => b.has(x));
    });
    if (allSetsIdentical) continue;

    const relevant = relevantByItem.get(itemId) ?? new Set();
    const someRelevantOnlyInSomeVariants = [...relevant].some((docId) => {
      const foundBy = presentContenders.filter((c) => variantHits[c].docIds.includes(docId));
      return foundBy.length > 0 && foundBy.length < presentContenders.length;
    });
    if (!someRelevantOnlyInSomeVariants) continue;

    sample.push({ itemId, query, variantHits });
  }

  return sample;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/answer-quality-sample.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eval/report/answer-quality-sample.ts test/eval/answer-quality-sample.test.ts
git commit -m "feat(eval): compute the real disagreement-driven answer-quality sample"
```

---

### Task 2: Answer generation from real retrieved context

**Files:**
- Create: `eval/report/generate-answers.ts`
- Test: `test/eval/generate-answers.test.ts`

**Interfaces:**
- Consumes: `DisagreementItem` from Task 1.
- Produces: `generateAnswers(items: DisagreementItem[], vault: VaultAdapter, llm: LLMClient, docCharCap: number): Promise<AnswerSet[]>`, where `AnswerSet = { itemId: string; query: string; answers: Array<{ variant: string; answer: string; retrievedDocIds: string[] }> }` (used by Task 3).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { generateAnswers } from '../../eval/report/generate-answers.js';
import type { DisagreementItem } from '../../eval/report/answer-quality-sample.js';
import type { VaultAdapter } from '../../src/vault/adapter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

describe('generateAnswers', () => {
  it('builds a fixed prompt per variant using that variant\'s real retrieved doc content, and calls the LLM once per variant per item', async () => {
    const items: DisagreementItem[] = [
      { itemId: 'fuzzy-002', query: 'What was decided about X?', variantHits: {
        'grep-first': { docIds: ['docA.md'] },
        'full-cov-hybrid': { docIds: ['docB.md'] },
      } },
    ];
    const fakeVault: Pick<VaultAdapter, 'read'> = {
      read: vi.fn(async (path: string) => (path === 'docA.md' ? 'Content of A' : 'Content of B')),
    };
    const fakeLLM: LLMClient = {
      complete: vi.fn(async (prompt: string) => `Answer based on: ${prompt.includes('Content of A') ? 'A' : 'B'}`),
      extractStructured: vi.fn(),
    };

    const result = await generateAnswers(items, fakeVault as VaultAdapter, fakeLLM, 5000);

    expect(result).toHaveLength(1);
    expect(result[0].answers).toHaveLength(2);
    const grepAnswer = result[0].answers.find((a) => a.variant === 'grep-first')!;
    expect(grepAnswer.answer).toContain('A');
    const hybridAnswer = result[0].answers.find((a) => a.variant === 'full-cov-hybrid')!;
    expect(hybridAnswer.answer).toContain('B');
    expect(fakeLLM.complete).toHaveBeenCalledTimes(2);
  });

  it('generates a real "cannot answer" response for a variant with zero retrieved docs, rather than skipping it', async () => {
    const items: DisagreementItem[] = [
      { itemId: 'fuzzy-003', query: 'Q', variantHits: { 'grep-first': { docIds: [] }, 'full-cov-hybrid': { docIds: ['docC.md'] } } },
    ];
    const fakeVault: Pick<VaultAdapter, 'read'> = { read: vi.fn(async () => 'Content of C') };
    const fakeLLM: LLMClient = {
      complete: vi.fn(async (prompt: string) => (prompt.includes('(no documents retrieved)') ? "I don't know" : 'Real answer')),
      extractStructured: vi.fn(),
    };

    const result = await generateAnswers(items, fakeVault as VaultAdapter, fakeLLM, 5000);
    const grepAnswer = result[0].answers.find((a) => a.variant === 'grep-first')!;
    expect(grepAnswer.answer).toBe("I don't know");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/generate-answers.test.ts`
Expected: FAIL — `eval/report/generate-answers.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `eval/report/generate-answers.ts`:

```ts
import type { VaultAdapter } from '../../src/vault/adapter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { DisagreementItem } from './answer-quality-sample.js';

export interface AnswerSet {
  itemId: string;
  query: string;
  answers: Array<{ variant: string; answer: string; retrievedDocIds: string[] }>;
}

const ANSWER_PROMPT_TEMPLATE = (query: string, contextBlock: string) => `You are answering a question using only the provided context. Do not use any knowledge beyond what's given below — if the context doesn't contain enough information to answer, say so explicitly rather than guessing.

Question: ${query}

Context (retrieved notes, in ranked order):
${contextBlock}

Answer:`;

/** Generates one real answer per (item, contending variant) pair, using a
 * FIXED prompt template and the SAME LLM for every generation — the only
 * variable across a given item's answers is which variant's retrieved
 * documents got substituted into the context block. This isolates
 * retrieval as the sole independent variable (spec:
 * downstream-answer-quality-check-design.md §4.1). `docCharCap` truncates
 * each retrieved doc's content to avoid one long document crowding out
 * the rest of a variant's context window unfairly relative to a variant
 * that retrieved several shorter docs. */
export async function generateAnswers(
  items: DisagreementItem[],
  vault: Pick<VaultAdapter, 'read'>,
  llm: LLMClient,
  docCharCap: number,
): Promise<AnswerSet[]> {
  const results: AnswerSet[] = [];

  for (const item of items) {
    const answers: AnswerSet['answers'] = [];
    for (const [variant, hits] of Object.entries(item.variantHits)) {
      let contextBlock: string;
      if (hits.docIds.length === 0) {
        contextBlock = '(no documents retrieved)';
      } else {
        const docTexts = await Promise.all(
          hits.docIds.map(async (docId) => {
            const raw = await vault.read(docId);
            const truncated = raw.length > docCharCap ? raw.slice(0, docCharCap) + '\n[...truncated...]' : raw;
            return `--- ${docId} ---\n${truncated}`;
          }),
        );
        contextBlock = docTexts.join('\n\n');
      }

      const prompt = ANSWER_PROMPT_TEMPLATE(item.query, contextBlock);
      const answer = await llm.complete(prompt);
      answers.push({ variant, answer, retrievedDocIds: hits.docIds });
    }
    results.push({ itemId: item.itemId, query: item.query, answers });
  }

  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/generate-answers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eval/report/generate-answers.ts test/eval/generate-answers.test.ts
git commit -m "feat(eval): generate real per-variant answers from actual retrieved context"
```

---

### Task 3: Blind pairwise judging, aggregation, and report

**Files:**
- Create: `eval/report/judge-answer-quality.ts`
- Create: `eval/report/main.ts` (real-execution entrypoint, following the existing `eval/pool/judge-full.ts`-style `main()` pattern)
- Test: `test/eval/judge-answer-quality.test.ts`
- Modify: `package.json` (new `eval:answer-quality` script)

**Interfaces:**
- Consumes: `AnswerSet` from Task 2.
- Produces: `judgeAnswerQuality(answerSets: AnswerSet[], llm: LLMClient, seed?: number): Promise<AnswerQualityResult[]>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { judgeAnswerQuality } from '../../eval/report/judge-answer-quality.js';
import type { AnswerSet } from '../../eval/report/generate-answers.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

describe('judgeAnswerQuality', () => {
  it('blinds the variant identity from the judge prompt, then un-blinds only at the result mapping step', async () => {
    const answerSets: AnswerSet[] = [
      { itemId: 'fuzzy-002', query: 'Q', answers: [
        { variant: 'grep-first', answer: 'Answer one.', retrievedDocIds: ['docA.md'] },
        { variant: 'full-cov-hybrid', answer: 'Answer two.', retrievedDocIds: ['docB.md'] },
      ] },
    ];
    let capturedPrompt = '';
    const fakeLLM: LLMClient = {
      complete: vi.fn(),
      extractStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { verdict: 'A', reason: 'More complete.' };
      }),
    };

    const result = await judgeAnswerQuality(answerSets, fakeLLM, 42);

    expect(capturedPrompt).not.toMatch(/grep-first|full-cov-hybrid/);
    expect(result).toHaveLength(1);
    expect(result[0].comparisons).toHaveLength(1);
    const comparison = result[0].comparisons[0];
    expect(['grep-first', 'full-cov-hybrid']).toContain(comparison.winner);
    expect(comparison.reason).toBe('More complete.');
  });

  it('is reproducible given the same seed — same A/B assignment across two runs', async () => {
    const answerSets: AnswerSet[] = [
      { itemId: 'fuzzy-002', query: 'Q', answers: [
        { variant: 'grep-first', answer: 'Answer one.', retrievedDocIds: [] },
        { variant: 'as-deployed', answer: 'Answer two.', retrievedDocIds: [] },
      ] },
    ];
    const fakeLLM: LLMClient = {
      complete: vi.fn(),
      extractStructured: vi.fn(async () => ({ verdict: 'tie', reason: 'Equivalent.' })),
    };

    const run1 = await judgeAnswerQuality(answerSets, fakeLLM, 7);
    const run2 = await judgeAnswerQuality(answerSets, fakeLLM, 7);
    expect(run1[0].comparisons[0].variantA).toBe(run2[0].comparisons[0].variantA);
  });

  it('generates one comparison per pair for a 3-variant item (N choose 2 = 3)', async () => {
    const answerSets: AnswerSet[] = [
      { itemId: 'relationship-005', query: 'Q', answers: [
        { variant: 'grep-first', answer: 'A1', retrievedDocIds: [] },
        { variant: 'as-deployed', answer: 'A2', retrievedDocIds: [] },
        { variant: 'full-cov-hybrid', answer: 'A3', retrievedDocIds: [] },
      ] },
    ];
    const fakeLLM: LLMClient = {
      complete: vi.fn(),
      extractStructured: vi.fn(async () => ({ verdict: 'tie', reason: 'r' })),
    };
    const result = await judgeAnswerQuality(answerSets, fakeLLM, 1);
    expect(result[0].comparisons).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/judge-answer-quality.test.ts`
Expected: FAIL — `eval/report/judge-answer-quality.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `eval/report/judge-answer-quality.ts`:

```ts
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { AnswerSet } from './generate-answers.js';

export interface AnswerQualityResult {
  item_id: string;
  query: string;
  answers: Array<{ variant: string; answer: string; retrieved_doc_ids: string[] }>;
  comparisons: Array<{
    variantA: string;
    variantB: string;
    winner: string | 'tie';
    reason: string;
  }>;
}

const JudgeVerdictSchema = z.object({
  verdict: z.enum(['A', 'B', 'tie']),
  reason: z.string(),
});

/** Deterministic PRNG matching this project's existing seeded-resampling
 * convention (eval/score/bootstrap.ts's mulberry32) — used here for
 * reproducible A/B position assignment, not resampling. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairwiseCombinations<T>(items: T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}

const JUDGE_PROMPT_TEMPLATE = (query: string, answerA: string, answerB: string) => `You are comparing two candidate answers to the same question, to judge which one is more helpful and accurate. You do not know which system produced which answer — judge only on the answers' merit.

Question: ${query}

Answer A:
${answerA}

Answer B:
${answerB}

Which answer is more helpful and accurate?`;

/** Blind pairwise comparison of every 2-way combination of a multi-variant
 * answer set. `seed` makes the A/B position assignment reproducible for a
 * given input (spec: downstream-answer-quality-check-design.md §5.1). The
 * judge prompt (JUDGE_PROMPT_TEMPLATE) never includes a variant name —
 * un-blinding happens only when mapping the returned 'A'/'B' verdict back
 * to real variant names, after the LLM call returns. */
export async function judgeAnswerQuality(
  answerSets: AnswerSet[],
  llm: LLMClient,
  seed = 42,
): Promise<AnswerQualityResult[]> {
  const rand = mulberry32(seed);
  const results: AnswerQualityResult[] = [];

  for (const set of answerSets) {
    const pairs = pairwiseCombinations(set.answers);
    const comparisons: AnswerQualityResult['comparisons'] = [];

    for (const [first, second] of pairs) {
      const flip = rand() < 0.5;
      const positionA = flip ? second : first;
      const positionB = flip ? first : second;

      const prompt = JUDGE_PROMPT_TEMPLATE(set.query, positionA.answer, positionB.answer);
      const { verdict, reason } = await llm.extractStructured(prompt, JudgeVerdictSchema);

      const winner = verdict === 'tie' ? 'tie' : verdict === 'A' ? positionA.variant : positionB.variant;
      comparisons.push({ variantA: positionA.variant, variantB: positionB.variant, winner, reason });
    }

    results.push({
      item_id: set.itemId,
      query: set.query,
      answers: set.answers.map((a) => ({ variant: a.variant, answer: a.answer, retrieved_doc_ids: a.retrievedDocIds })),
      comparisons,
    });
  }

  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/judge-answer-quality.test.ts`
Expected: PASS

- [ ] **Step 5: Write the real-execution entrypoint and markdown renderer**

Create `eval/report/main.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createLLMForTier } from '../pool/llm.js';
import { computeDisagreementSample } from './answer-quality-sample.js';
import { generateAnswers } from './generate-answers.js';
import { judgeAnswerQuality, type AnswerQualityResult } from './judge-answer-quality.js';
import { findLatestRunsFile } from '../score/build-scorecard.js';
import type { RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONTENDERS = ['grep-first', 'as-deployed', 'full-cov-hybrid'];
const DOC_CHAR_CAP = 8000;

function renderMarkdown(results: AnswerQualityResult[]): string {
  const lines: string[] = ['# Downstream Answer-Quality Check', ''];
  const tally = new Map<string, { wins: number; losses: number; ties: number }>();

  for (const result of results) {
    lines.push(`## ${result.item_id}`, '', `**Query:** ${result.query}`, '');
    for (const comparison of result.comparisons) {
      lines.push(`- **${comparison.variantA} vs ${comparison.variantB}**: ${comparison.winner === 'tie' ? 'tie' : `${comparison.winner} wins`} — ${comparison.reason}`);
      for (const variant of [comparison.variantA, comparison.variantB]) {
        if (!tally.has(variant)) tally.set(variant, { wins: 0, losses: 0, ties: 0 });
      }
      if (comparison.winner === 'tie') {
        tally.get(comparison.variantA)!.ties++;
        tally.get(comparison.variantB)!.ties++;
      } else {
        tally.get(comparison.winner)!.wins++;
        const loser = comparison.winner === comparison.variantA ? comparison.variantB : comparison.variantA;
        tally.get(loser)!.losses++;
      }
    }
    lines.push('');
  }

  lines.push('## Aggregate tally', '', '| Variant | Wins | Losses | Ties |', '|---|---|---|---|');
  for (const [variant, counts] of tally) {
    lines.push(`| ${variant} | ${counts.wins} | ${counts.losses} | ${counts.ties} |`);
  }
  return lines.join('\n');
}

async function main() {
  const config = await loadConfig(REPO_ROOT);
  const vault = createFsAdapter(config.vaultPath);

  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  const runsResults: RunResult[] = JSON.parse(readFileSync(findLatestRunsFile(resultsDir), 'utf-8')).results;
  const judgments: Judgment[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf-8'));

  const sample = computeDisagreementSample(runsResults, judgments, CONTENDERS);
  process.stdout.write(`Found ${sample.length} disagreement-driven items.\n`);

  const answerLLM = createLLMForTier(config, 'medium');
  const answerSets = await generateAnswers(sample, vault, answerLLM, DOC_CHAR_CAP);

  const judgeLLM = createLLMForTier(config, 'heavy');
  const results = await judgeAnswerQuality(answerSets, judgeLLM);

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(REPO_ROOT, `eval/results/${today}-answer-quality.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(REPO_ROOT, `eval/results/${today}-answer-quality.md`), renderMarkdown(results));
  process.stdout.write(`Wrote eval/results/${today}-answer-quality.{json,md}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`findLatestRunsFile(resultsDir: string): string` is already exported from `eval/score/build-scorecard.ts:223-228` (added for issue I14 — globs for `<date>-runs.json`, picks the most recent) — reused directly above, not reimplemented.

- [ ] **Step 6: Add the `eval:answer-quality` script**

In `package.json`, add alongside the existing `eval:*` scripts:

```json
    "eval:answer-quality": "tsx eval/report/main.ts",
```

- [ ] **Step 7: Run the full eval test suite**

Run: `npx vitest run test/eval/`
Expected: all pass.

- [ ] **Step 8: Real execution**

```bash
pnpm eval:answer-quality
```

Run as a genuine blocking call (real LLM calls for both answer generation and judging) — verify completion via the new `eval/results/<today>-answer-quality.{json,md}` files' existence and content, not command return alone. Report the real aggregate win/loss/tie tally and a sample of the judge's stated reasons in your task report — including whether the reasons look like genuine factual/helpfulness assessments or suspicious fluency-bias (per the spec's §8 risk).

- [ ] **Step 9: Commit**

```bash
git add eval/report/judge-answer-quality.ts eval/report/main.ts test/eval/judge-answer-quality.test.ts package.json
git commit -m "feat(eval): blind pairwise answer-quality judging + report"
```

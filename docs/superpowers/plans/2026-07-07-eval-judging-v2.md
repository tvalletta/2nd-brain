# Eval Judging v2 (Dual-Judge, Behavioral-First, No Human Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the unworkable human-calibration-review step and replace it with behavioral-signal-as-ground-truth, a heavy-tier cross-judge against the existing medium-tier judge with automatic reconciliation, a real fix to the shared JSON-extraction bug, and a full-pool (not sample) judging run — ending with a non-blocking diagnostic disagreement log instead of a human gate.

**Architecture:** Six small, independently-testable modules layered on top of the existing Phase 2 pipeline (`eval/pool/build-pool.ts`, `judge.ts`, `llm.ts` — all unchanged in their existing contracts). A new pure `applyBehavioralShortcut` function partitions each item's pool before judging; a new pure `reconcileJudgments` function merges two independent `judgeItem` calls; a new orchestration script (`judge-full.ts`) wires both together across the full 73-item pool. The shared `extractJSON` parser gets a real correctness fix (proper string/bracket-aware scanning) instead of the greedy regex that caused issue I10.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `tsx`, `zod` (`^3.25.76`), `vitest`. Extends `src/enrichment/llm-client.ts` and Phase 2's `eval/pool/*.ts`, `eval/dataset/*.ts`.

## Global Constraints

- ESM with `.js` import extensions on all relative imports (project convention, verbatim: `import { x } from '../../src/foo.js'`).
- Tests MUST live under `test/**/*.test.ts` (vitest `include: ['test/**/*.test.ts']`).
- zod import convention: `import { z } from 'zod';` (matches every existing file).
- LLM-touching code MUST accept an injected `LLMClient`; tests use a fake implementing the interface directly (`{ async complete() {...}, async extractStructured<T>(_p, schema) { return schema.parse(fixedResponse) as T; } }`) — never a real network call in the test suite.
- No shared-budget-tracker calls anywhere in this plan's code (unchanged from Phase 2 — this is a deliberate, manual, one-off research task).
- **`createLLMForTier(config, 'heavy')` already works** — `LLMTier = 'fast' | 'medium' | 'heavy'` and the factory (`eval/pool/llm.ts`, built in Phase 2 Task 1) is already generic across tiers. No change needed to `llm.ts` itself.
- **`label_provenance` gains `'behavioral'`** and the meaning of `'llm'` changes: it now specifically means "dual-judge reconciled," not single-judge as before Phase 2.5. This is a deliberate, documented semantic change — anything reading `judgments.json` downstream must know this.
- **This plan's Task 7 makes real, billed Bedrock calls** (~140, both medium and heavy tier) — `--dry-run` support is required on `judge-full.ts` and must be exercised before the real run.
- Read-only against the live production index for all search operations (unchanged Phase 1/2 invariant — this plan adds no new search calls, only judging/reconciliation logic).
- `doc_id` === vault-relative path (identity, no hash) — unchanged.

---

### Task 1: Fix `extractJSON`'s fallback to be string/bracket-aware and array-capable

**Files:**
- Modify: `src/enrichment/llm-client.ts` (the `extractJSON` function, currently lines 16-42)
- Test: `test/enrichment/llm-client.test.ts` (new file — no test currently exists for this function)

**Interfaces:**
- Consumes: nothing new.
- Produces: `extractJSON(raw: string): unknown` — same exported signature, corrected behavior. Used indirectly by every `LLMClient.extractStructured` call, including the judge/triage calls this plan's later tasks add.

- [ ] **Step 1: Write the failing test**

```ts
// test/enrichment/llm-client.test.ts
import { describe, it, expect } from 'vitest';
import { extractJSON } from '../../src/enrichment/llm-client.js';

describe('extractJSON', () => {
  it('parses a fenced ```json object block (existing behavior, unaffected)', () => {
    const raw = 'Here is the result:\n```json\n{"a":1}\n```\nDone.';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('parses a fenced ```json array block (existing behavior, unaffected)', () => {
    const raw = '```json\n[{"a":1},{"b":2}]\n```';
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('falls back to a bare object when no fence is present', () => {
    const raw = 'some prose {"a":1} more prose';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('does NOT overshoot past trailing prose containing a stray closing brace (the I10 root cause)', () => {
    const raw = 'prose {"a":1} more prose mentioning a config block } stray brace';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('falls back to a bare ARRAY when no fence is present (previously unsupported — the fallback only handled objects)', () => {
    const raw = 'prose [{"a":1},{"b":2}] trailing text with a stray } brace too';
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('respects string boundaries when counting braces (a value containing a brace-like character does not break scanning)', () => {
    const raw = 'prose {"reason":"see the {config} block"} trailing prose with another }';
    expect(extractJSON(raw)).toEqual({ reason: 'see the {config} block' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrichment/llm-client.test.ts`
Expected: FAIL — the "stray closing brace", "bare ARRAY", and "brace-like character in a string value" tests fail against the current greedy-regex fallback (the first three pass already, since they exercise the unaffected fenced-block path or a trivial fallback case).

- [ ] **Step 3: Write minimal implementation**

In `src/enrichment/llm-client.ts`, add this function above `extractJSON` and replace the fallback block inside it:

```ts
/** Scan `raw` from the first `{` or `[`, tracking string/escape state and
 * bracket depth, and return the substring up to the TRUE matching closing
 * bracket of the SAME type as the opener — not just the first/last
 * occurrence anywhere in the text. A naive greedy regex (`/\{[\s\S]*\}/`)
 * can overshoot past trailing prose that happens to contain a stray `}`,
 * and never matched array-shaped JSON at all. This also correctly skips
 * brace-like characters that appear inside string values. */
function findBalancedJsonValue(raw: string): string | null {
  let start = -1;
  let opener = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{' || raw[i] === '[') {
      start = i;
      opener = raw[i];
      break;
    }
  }
  if (start === -1) return null;
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === opener) {
      depth++;
    } else if (ch === closer) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
```

Then replace the fallback block inside `extractJSON` (currently):
```ts
  // Fallback: find outermost { ... } in the raw text
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return JSON.parse(braceMatch[0]);
  }
```
with:
```ts
  // Fallback: find the true balanced { ... } or [ ... ] in the raw text,
  // respecting string boundaries so embedded braces/brackets and trailing
  // prose don't cause overshoot (see findBalancedJsonValue).
  const balanced = findBalancedJsonValue(raw);
  if (balanced) {
    return JSON.parse(balanced);
  }
```

**Honest scope note (do not oversell this fix):** this makes the fallback correctly bounded and array-capable. It does NOT retroactively recover JSON that is genuinely malformed (e.g. a model emitting an unescaped literal quote inside a string value, which breaks the string boundary itself) — that failure mode is addressed separately in Task 2 by reducing how often the model produces it in the first place.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrichment/llm-client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full existing test suite to confirm no regression**

Run: `npx vitest run test/`
Expected: all pre-existing tests still pass — this function is used by every `extractStructured` caller in the codebase, so a regression here would show up broadly.

- [ ] **Step 6: Commit**

```bash
git add src/enrichment/llm-client.ts test/enrichment/llm-client.test.ts
git commit -m "fix(llm-client): make extractJSON's fallback string/bracket-aware

Replaces the greedy first-{-to-last-} regex (issue I10's root cause)
with a proper scanner that respects string boundaries and supports
array-shaped JSON, which the old fallback never matched at all."
```

---

### Task 2: Add quote-escaping instructions to the judge and triage prompts

**Files:**
- Modify: `eval/pool/prompts.ts` (`judgePrompt` and `triagePrompt`)
- Modify: `test/eval/prompts.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `judgePrompt`/`triagePrompt` return the same `string` type, with an added instruction in the text.

- [ ] **Step 1: Write the failing test**

Add to `test/eval/prompts.test.ts` (append inside the existing `describe` blocks):

```ts
describe('judgePrompt escaping instruction', () => {
  it('instructs the model to escape quote characters within string values', () => {
    const prompt = judgePrompt('q', 'i', [{ doc_id: 'a.md', title: 'A', excerpt: 'e' }]);
    expect(prompt.toLowerCase()).toContain('escape');
    expect(prompt).toContain('\\"');
  });
});

describe('triagePrompt escaping instruction', () => {
  it('instructs the model to escape quote characters within string values', () => {
    const prompt = triagePrompt([{ id: 'x', query: 'q', category: 'decisions', subtype: 'lookup', source: 'log', intent: '' }]);
    expect(prompt.toLowerCase()).toContain('escape');
    expect(prompt).toContain('\\"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/prompts.test.ts`
Expected: FAIL — the two new tests fail (current prompts don't mention escaping).

- [ ] **Step 3: Write minimal implementation**

In `eval/pool/prompts.ts`, change `judgePrompt`'s final line from:
```ts
Respond with only the JSON array, wrapped in \`\`\`json code fences.`;
```
to:
```ts
Respond with only the JSON array, wrapped in \`\`\`json code fences. If a title or excerpt contains a double-quote character, escape it as \\" inside your "reason" string so the JSON stays valid.`;
```

And change `triagePrompt`'s final line from:
```ts
Respond with only a JSON array, one object per item, wrapped in \`\`\`json code fences.`;
```
to:
```ts
Respond with only a JSON array, one object per item, wrapped in \`\`\`json code fences. If a query contains a double-quote character, escape it as \\" inside your "reason" string so the JSON stays valid.`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/prompts.test.ts`
Expected: PASS (all prior tests + 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add eval/pool/prompts.ts test/eval/prompts.test.ts
git commit -m "fix(eval): instruct judge/triage prompts to escape quotes in reason strings

Complements the extractJSON parser fix (Task 1) by reducing how often
the model produces genuinely malformed JSON in the first place."
```

---

### Task 3: Widen `Judgment` type and add dual-judge reconciliation

**Files:**
- Modify: `eval/pool/judge.ts` (the `Judgment` interface; add `reconcileJudgments`)
- Modify: `test/eval/judge.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: nothing new (uses the existing `Judgment` shape it's extending).
- Produces: widened `Judgment` interface (`label_provenance` includes `'behavioral'`; new optional fields `judge_a_label`, `judge_b_label`, `disagreement`); `reconcileJudgments(judgeA: Judgment[], judgeB: Judgment[]): Judgment[]` — used by Task 6's orchestration. **This task's widened `label_provenance` union is a compile-time dependency of Task 4** (which assigns `label_provenance: 'behavioral'`) — done first so Task 4 type-checks without any workaround.

- [ ] **Step 1: Write the failing test**

Add to `test/eval/judge.test.ts` (new `describe` block, alongside the existing `judgeItem` tests):

```ts
describe('reconcileJudgments', () => {
  const base = { item_id: 'x-001', reason: 'r' };

  it('averages labels that agree within 1 point and marks no disagreement', () => {
    const a = [{ ...base, doc_id: 'a.md', label: 0, label_provenance: 'llm' as const }];
    const b = [{ ...base, doc_id: 'a.md', label: 1, label_provenance: 'llm' as const }];
    const result = reconcileJudgments(a, b);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ doc_id: 'a.md', label: 1, judge_a_label: 0, judge_b_label: 1, disagreement: false });
  });

  it('uses the lower label and flags disagreement when judges differ by 2+', () => {
    const a = [{ ...base, doc_id: 'a.md', label: 0, label_provenance: 'llm' as const }];
    const b = [{ ...base, doc_id: 'a.md', label: 2, label_provenance: 'llm' as const }];
    const result = reconcileJudgments(a, b);
    expect(result[0]).toMatchObject({ doc_id: 'a.md', label: 0, judge_a_label: 0, judge_b_label: 2, disagreement: true });
  });

  it('falls back to judge A alone when judge B is missing a doc_id (never trust LLM output blindly)', () => {
    const a = [{ ...base, doc_id: 'a.md', label: 1, label_provenance: 'llm' as const }];
    const b: typeof a = [];
    const result = reconcileJudgments(a, b);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ doc_id: 'a.md', label: 1 });
    expect(result[0].judge_b_label).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/judge.test.ts`
Expected: FAIL — `reconcileJudgments` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `eval/pool/judge.ts`, replace the `Judgment` interface:
```ts
export interface Judgment {
  item_id: string;
  doc_id: string;
  label: number;
  reason: string;
  label_provenance: 'llm' | 'human' | 'llm+human';
}
```
with:
```ts
export interface Judgment {
  item_id: string;
  doc_id: string;
  label: number;
  reason: string;
  /** 'llm' means dual-judge reconciled (see reconcileJudgments) — a
   * deliberate semantic change from single-judge Phase 2, since single-judge
   * grading is retired for the full-pool run. 'behavioral' means confirmed
   * by real usage, never judged at all. */
  label_provenance: 'llm' | 'behavioral' | 'human' | 'llm+human';
  judge_a_label?: number;
  judge_b_label?: number;
  disagreement?: boolean;
}
```

Then add this function at the end of the file:
```ts
/** Reconcile two independent judges' gradings of the same item's candidates.
 * Candidates within 1 point of each other average (rounded); candidates 2+
 * points apart use the lower (more conservative) label and are flagged
 * `disagreement: true` for the diagnostic log — never blocking, just
 * recorded. If judge B is missing a doc_id judge A returned (should not
 * normally happen, but never trust LLM output blindly), judge A's own
 * judgment passes through unchanged. */
export function reconcileJudgments(judgeA: Judgment[], judgeB: Judgment[]): Judgment[] {
  const byDocIdB = new Map(judgeB.map((j) => [j.doc_id, j]));
  const reconciled: Judgment[] = [];
  for (const a of judgeA) {
    const b = byDocIdB.get(a.doc_id);
    if (!b) {
      reconciled.push(a);
      continue;
    }
    const diff = Math.abs(a.label - b.label);
    const disagreement = diff >= 2;
    const label = disagreement ? Math.min(a.label, b.label) : Math.round((a.label + b.label) / 2);
    reconciled.push({
      item_id: a.item_id,
      doc_id: a.doc_id,
      label,
      reason: a.reason,
      label_provenance: 'llm',
      judge_a_label: a.label,
      judge_b_label: b.label,
      disagreement,
    });
  }
  return reconciled;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/judge.test.ts`
Expected: PASS (all prior `judgeItem` tests + 3 new `reconcileJudgments` tests).

- [ ] **Step 5: Run the full eval suite to confirm the type widening didn't break Phase 2 code**

Run: `npx vitest run test/eval/`
Expected: all pass — `label_provenance: 'llm' | 'human' | 'llm+human'` widening to include `'behavioral'` is additive and backward-compatible; nothing that assigned the old 3 values breaks.

- [ ] **Step 6: Commit**

```bash
git add eval/pool/judge.ts test/eval/judge.test.ts
git commit -m "feat(eval): widen Judgment for behavioral provenance + dual-judge reconciliation"
```

---

### Task 4: Behavioral shortcut — skip judging for behaviorally-confirmed candidates

**Files:**
- Create: `eval/pool/behavioral-shortcut.ts`
- Test: `test/eval/behavioral-shortcut.test.ts`

**Interfaces:**
- Consumes: `ItemPool`, `PoolCandidate`, `BehavioralEntry` from `eval/pool/build-pool.ts` (all already exported); `Judgment` from `eval/pool/judge.ts` — Task 3 already widened `label_provenance` to include `'behavioral'`, so this task's code type-checks with no workaround needed.
- Produces: `applyBehavioralShortcut(item, pool, behavioral): { shortcut: Judgment[]; remaining: ItemPool }` — used by Task 6's orchestration.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/behavioral-shortcut.test.ts
import { describe, it, expect } from 'vitest';
import { applyBehavioralShortcut } from '../../eval/pool/behavioral-shortcut.js';
import type { ItemPool, BehavioralEntry } from '../../eval/pool/build-pool.js';

describe('applyBehavioralShortcut', () => {
  const pool: ItemPool = {
    item_id: 'x-001',
    candidates: [
      { doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] },
      { doc_id: 'b.md', title: 'B', excerpt: 'exc-b', sources: ['as-deployed'] },
    ],
  };

  it('shortcuts a candidate whose doc_id was actually opened after a matching real search', () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['a.md'] },
    ];
    const { shortcut, remaining } = applyBehavioralShortcut(
      { id: 'x-001', query: 'What did we decide about X' }, // case/whitespace differs, should still match via normalization
      pool,
      behavioral,
    );
    expect(shortcut).toHaveLength(1);
    expect(shortcut[0]).toMatchObject({ item_id: 'x-001', doc_id: 'a.md', label: 2, label_provenance: 'behavioral' });
    expect(remaining.candidates).toHaveLength(1);
    expect(remaining.candidates[0].doc_id).toBe('b.md');
  });

  it('shortcuts nothing when no behavioral entry matches the query', () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'a totally different query', ts: '2026-01-01T00:00:00Z', opened: ['a.md'] },
    ];
    const { shortcut, remaining } = applyBehavioralShortcut({ id: 'x-001', query: 'what did we decide about x' }, pool, behavioral);
    expect(shortcut).toHaveLength(0);
    expect(remaining.candidates).toHaveLength(2);
  });

  it('shortcuts nothing when the matched entry opened a doc_id not in this pool', () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['some-other-doc.md'] },
    ];
    const { shortcut, remaining } = applyBehavioralShortcut({ id: 'x-001', query: 'what did we decide about x' }, pool, behavioral);
    expect(shortcut).toHaveLength(0);
    expect(remaining.candidates).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/behavioral-shortcut.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/behavioral-shortcut.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/behavioral-shortcut.ts
import type { ItemPool, PoolCandidate, BehavioralEntry } from './build-pool.js';
import type { Judgment } from './judge.js';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Split an item's pool into candidates confirmed relevant by real
 * behavioral evidence (Tom actually opened this note after a matching real
 * search) vs. candidates that still need LLM judging. Behaviorally-confirmed
 * candidates never need a judge call — real usage is stronger evidence than
 * any LLM's opinion. */
export function applyBehavioralShortcut(
  item: { id: string; query: string },
  pool: ItemPool,
  behavioral: BehavioralEntry[],
): { shortcut: Judgment[]; remaining: ItemPool } {
  const match = behavioral.find((b) => norm(b.query) === norm(item.query));
  const openedDocIds = new Set(match?.opened ?? []);

  const shortcut: Judgment[] = [];
  const remainingCandidates: PoolCandidate[] = [];
  for (const c of pool.candidates) {
    if (openedDocIds.has(c.doc_id)) {
      shortcut.push({
        item_id: item.id,
        doc_id: c.doc_id,
        label: 2,
        reason: 'Confirmed relevant by real behavioral signal (opened after a matching real search).',
        label_provenance: 'behavioral',
      });
    } else {
      remainingCandidates.push(c);
    }
  }
  return { shortcut, remaining: { item_id: pool.item_id, candidates: remainingCandidates } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/behavioral-shortcut.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/pool/behavioral-shortcut.ts test/eval/behavioral-shortcut.test.ts
git commit -m "feat(eval): behavioral-signal shortcut — skip judging where real usage confirms relevance"
```

---

### Task 5: Diagnostic disagreement log (non-blocking)

**Files:**
- Create: `eval/pool/disagreement-report.ts`
- Test: `test/eval/disagreement-report.test.ts`

**Interfaces:**
- Consumes: `Judgment` from `eval/pool/judge.ts` (Task 3's widened type, specifically the `disagreement`/`judge_a_label`/`judge_b_label` fields).
- Produces: `renderDisagreementReport(judgments: Judgment[]): string`, `writeDisagreementReport(path: string, judgments: Judgment[]): void` — used by Task 6's orchestration.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/disagreement-report.test.ts
import { describe, it, expect } from 'vitest';
import { renderDisagreementReport } from '../../eval/pool/disagreement-report.js';
import type { Judgment } from '../../eval/pool/judge.js';

describe('renderDisagreementReport', () => {
  it('lists only disagreement items, grouped by item_id, with both judges\' labels', () => {
    const judgments: Judgment[] = [
      { item_id: 'x-001', doc_id: 'a.md', label: 0, reason: 'not relevant', label_provenance: 'llm', judge_a_label: 0, judge_b_label: 2, disagreement: true },
      { item_id: 'x-001', doc_id: 'b.md', label: 1, reason: 'supporting', label_provenance: 'llm', judge_a_label: 1, judge_b_label: 1, disagreement: false },
      { item_id: 'x-002', doc_id: 'c.md', label: 2, reason: 'confirmed', label_provenance: 'behavioral' },
    ];
    const report = renderDisagreementReport(judgments);
    expect(report).toContain('x-001');
    expect(report).toContain('a.md');
    expect(report).toContain('medium judge: 0');
    expect(report).toContain('heavy judge: 2');
    expect(report).not.toContain('b.md'); // agreement, should not appear
    expect(report).not.toContain('x-002'); // no disagreement field at all, should not appear
  });

  it('reports "no disagreements found" when none exist', () => {
    const judgments: Judgment[] = [
      { item_id: 'x-001', doc_id: 'a.md', label: 1, reason: 'r', label_provenance: 'llm', judge_a_label: 1, judge_b_label: 1, disagreement: false },
    ];
    expect(renderDisagreementReport(judgments)).toContain('No disagreements found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/disagreement-report.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/disagreement-report.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/disagreement-report.ts
import { writeFileSync } from 'node:fs';
import type { Judgment } from './judge.js';

/** Render a small, non-blocking diagnostic report listing every candidate
 * where the two judges disagreed by 2+ points. No checkboxes, no gate — for
 * whenever a human chooses to look, not something anyone must review. */
export function renderDisagreementReport(judgments: Judgment[]): string {
  const disagreements = judgments.filter((j) => j.disagreement);
  const lines: string[] = [
    '# Judge Disagreement Log',
    '',
    `${disagreements.length} candidate(s) where the two judges disagreed by 2+ points (out of ${judgments.length} total judgments). This is a diagnostic artifact, not a review requirement — nothing is blocked on it.`,
    '',
  ];
  if (disagreements.length === 0) {
    lines.push('No disagreements found.');
    return lines.join('\n');
  }
  const byItem = new Map<string, Judgment[]>();
  for (const j of disagreements) {
    if (!byItem.has(j.item_id)) byItem.set(j.item_id, []);
    byItem.get(j.item_id)!.push(j);
  }
  for (const [itemId, items] of byItem) {
    lines.push(`## ${itemId}`, '');
    for (const j of items) {
      lines.push(`- **${j.doc_id}** — medium judge: ${j.judge_a_label}, heavy judge: ${j.judge_b_label}, reconciled to: ${j.label} — ${j.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeDisagreementReport(path: string, judgments: Judgment[]): void {
  writeFileSync(path, renderDisagreementReport(judgments));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/disagreement-report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/pool/disagreement-report.ts test/eval/disagreement-report.test.ts
git commit -m "feat(eval): non-blocking diagnostic disagreement log"
```

---

### Task 6: Full-pool orchestration (behavioral shortcut + dual-judge, wired together)

**Files:**
- Create: `eval/pool/judge-full.ts`
- Modify: `package.json` (add `eval:judge-full` script)
- Test: `test/eval/judge-full.test.ts`

**Interfaces:**
- Consumes: `reconcileJudgments`, `Judgment` (Task 3), `applyBehavioralShortcut` (Task 4), `writeDisagreementReport` (Task 5), `judgeItem` (existing, Phase 2), `ItemPool`, `BehavioralEntry` (existing, `build-pool.ts`), `createLLMForTier` (existing, `llm.ts`).
- Produces: `judgeItemFull(judgeA, judgeB, item, pool, behavioral): Promise<Judgment[]>` — the pure, testable per-item orchestration core. `main()`'s CLI wraps this across the full pool; not itself unit-tested (consistent with every other task's CLI-wrapper convention this project uses).

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/judge-full.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgeItemFull } from '../../eval/pool/judge-full.js';
import type { ItemPool } from '../../eval/pool/build-pool.js';
import type { BehavioralEntry } from '../../eval/pool/build-pool.js';

function fakeJudge(response: unknown, calledFlag?: { called: boolean }): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      if (calledFlag) calledFlag.called = true;
      return schema.parse(response) as T;
    },
  };
}

describe('judgeItemFull', () => {
  const item = { id: 'x-001', query: 'what did we decide about x', intent: '' };
  const pool: ItemPool = {
    item_id: 'x-001',
    candidates: [
      { doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] },
      { doc_id: 'b.md', title: 'B', excerpt: 'exc-b', sources: ['as-deployed'] },
    ],
  };

  it('shortcuts behaviorally-confirmed candidates and dual-judges the rest', async () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['a.md'] },
    ];
    const judgeA = fakeJudge([{ doc_id: 'b.md', label: 1, reason: 'a-reason' }]);
    const judgeB = fakeJudge([{ doc_id: 'b.md', label: 1, reason: 'b-reason' }]);
    const judgments = await judgeItemFull(judgeA, judgeB, item, pool, behavioral);

    expect(judgments).toHaveLength(2);
    const behavioralJudgment = judgments.find((j) => j.doc_id === 'a.md');
    expect(behavioralJudgment).toMatchObject({ label: 2, label_provenance: 'behavioral' });
    const dualJudged = judgments.find((j) => j.doc_id === 'b.md');
    expect(dualJudged).toMatchObject({ label: 1, judge_a_label: 1, judge_b_label: 1, disagreement: false });
  });

  it('makes zero LLM calls when every candidate is behaviorally shortcut', async () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['a.md', 'b.md'] },
    ];
    const flagA = { called: false };
    const flagB = { called: false };
    const judgeA = fakeJudge([], flagA);
    const judgeB = fakeJudge([], flagB);
    const judgments = await judgeItemFull(judgeA, judgeB, item, pool, behavioral);

    expect(judgments).toHaveLength(2);
    expect(judgments.every((j) => j.label_provenance === 'behavioral')).toBe(true);
    expect(flagA.called).toBe(false);
    expect(flagB.called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/judge-full.test.ts`
Expected: FAIL — cannot find module `../../eval/pool/judge-full.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/pool/judge-full.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { ItemPool, BehavioralEntry } from './build-pool.js';
import { judgeItem, reconcileJudgments, type Judgment } from './judge.js';
import { applyBehavioralShortcut } from './behavioral-shortcut.js';
import { writeDisagreementReport } from './disagreement-report.js';

/** Judge one item end-to-end: behavioral shortcut first, then dual-judge
 * (medium + heavy tier) reconciliation for whatever candidates remain. Zero
 * LLM calls are made if every candidate is behaviorally shortcut. */
export async function judgeItemFull(
  judgeA: LLMClient,
  judgeB: LLMClient,
  item: { id: string; query: string; intent: string },
  pool: ItemPool,
  behavioral: BehavioralEntry[],
): Promise<Judgment[]> {
  const { shortcut, remaining } = applyBehavioralShortcut(item, pool, behavioral);
  if (remaining.candidates.length === 0) return shortcut;

  const [judgmentsA, judgmentsB] = await Promise.all([
    judgeItem(judgeA, item, remaining),
    judgeItem(judgeB, item, remaining),
  ]);
  const reconciled = reconcileJudgments(judgmentsA, judgmentsB);
  return [...shortcut, ...reconciled];
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pools: ItemPool[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), 'utf8'));
  const items: { id: string; query: string; intent: string }[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  const behavioral: BehavioralEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/behavioral-signal.json'), 'utf8'),
  );
  const itemById = new Map(items.map((it) => [it.id, it]));

  if (dryRun) {
    let shortcutCount = 0;
    let itemsNeedingJudging = 0;
    for (const pool of pools) {
      const item = itemById.get(pool.item_id);
      if (!item) continue;
      const { shortcut, remaining } = applyBehavioralShortcut(item, pool, behavioral);
      shortcutCount += shortcut.length;
      if (remaining.candidates.length > 0) itemsNeedingJudging += 1;
    }
    console.log(
      `[dry-run] ${pools.length} items; ${shortcutCount} candidates behaviorally shortcut; ${itemsNeedingJudging} items need dual-judge grading (~${itemsNeedingJudging * 2} real LLM calls)`,
    );
    return;
  }

  const { loadConfig } = await import('../../src/config/loader.js');
  const { createLLMForTier } = await import('./llm.js');
  const config = await loadConfig(REPO_ROOT);
  const judgeA = createLLMForTier(config, 'medium');
  const judgeB = createLLMForTier(config, 'heavy');

  const allJudgments: Judgment[] = [];
  const failedItemIds = new Set<string>();
  for (const pool of pools) {
    const item = itemById.get(pool.item_id);
    if (!item) continue;
    try {
      const judgments = await judgeItemFull(judgeA, judgeB, item, pool, behavioral);
      allJudgments.push(...judgments);
      const disagreements = judgments.filter((j) => j.disagreement).length;
      console.log(`${item.id}: ${judgments.length} judgments (${disagreements} disagreements)`);
    } catch (err) {
      console.error(`Judge call FAILED for ${item.id} (${pool.candidates.length} candidates) — skipping: ${(err as Error).message}`);
      failedItemIds.add(item.id);
    }
  }

  if (failedItemIds.size > 0) {
    console.error(`${failedItemIds.size} item(s) failed judging and were skipped: ${[...failedItemIds].join(', ')}`);
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), JSON.stringify(allJudgments, null, 2));
  console.log(`Wrote eval/dataset/judgments.json: ${allJudgments.length} judgments across ${pools.length} items`);

  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const disagreementPath = join(outDir, `${date}-disagreements.md`);
  writeDisagreementReport(disagreementPath, allJudgments);
  console.log(`Wrote disagreement log to eval/results/${date}-disagreements.md`);
}

if (process.argv[1]?.endsWith('judge-full.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/judge-full.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the eval:judge-full script**

Modify `package.json` scripts (after the existing `eval:calibration` line):

```json
"eval:judge-full": "tsx eval/pool/judge-full.ts",
```

- [ ] **Step 6: Run the full eval test suite**

Run: `npx vitest run test/eval/`
Expected: PASS — all Phase 2 tests plus this plan's Tasks 3-6 tests, all green.

- [ ] **Step 7: Commit**

```bash
git add eval/pool/judge-full.ts test/eval/judge-full.test.ts package.json
git commit -m "feat(eval): full-pool dual-judge orchestration with behavioral shortcut"
```

---

### Task 7: Real end-to-end run (heavy-tier probe, full judging, roadmap update)

**Files:**
- No new source files. Real execution + `docs/superpowers/ROADMAP.md` update.

**Interfaces:**
- Consumes: everything built in Tasks 1-6.
- Produces: the real `eval/dataset/judgments.json` (full pool, supersedes the 20-item partial file) and `eval/results/<date>-disagreements.md`.

- [ ] **Step 1: Verify the full test suite is green before spending real money**

Run: `npx vitest run`
Expected: all tests pass (project-wide, not just `eval/`).

- [ ] **Step 2: Real heavy-tier probe (do this before the full run — heavy tier has not been exercised by this pipeline before; only medium tier was verified in an earlier session)**

Get the Bedrock bearer token from Control Center's vault HTTP API, piped directly into an env var in one command so it is never printed:
```bash
export BEDROCK_BEARER_TOKEN=$(curl -s "http://localhost:7100/api/vault/credentials/bedrock-aws1812-dev/reveal?confirm=true" | python3 -c "import json,sys; print(json.load(sys.stdin)['secretValue'])")
```
Then, from the repo root, run a tiny real probe (create a throwaway script, run it, delete it — do not commit it):
```bash
cat > ./probe-heavy.mjs <<'EOF'
import { createLLMForTier } from './eval/pool/llm.js';
import { loadConfig } from './src/config/loader.js';
import { z } from 'zod';
const config = await loadConfig(process.cwd());
const llm = createLLMForTier(config, 'heavy');
const result = await llm.extractStructured(
  'Reply with {"ok": true} as JSON in a ```json fence.',
  z.object({ ok: z.boolean() }),
);
console.log('HEAVY TIER SUCCESS:', JSON.stringify(result));
EOF
npx tsx probe-heavy.mjs
rm -f probe-heavy.mjs
```
Expected: `HEAVY TIER SUCCESS: {"ok":true}`. If this fails (permissions, model access, anything), STOP — do not proceed to the full run until this specific probe succeeds. Do not guess at a workaround; report the exact error.

- [ ] **Step 3: Dry-run the full pipeline**

```bash
npx tsx eval/pool/judge-full.ts --dry-run
```
Expected: prints item count, behaviorally-shortcut candidate count, and an estimated real-call count (should be in the neighborhood of ~140, per the design spec's estimate — if wildly different, e.g. 0 or 500+, investigate before proceeding rather than assuming it's fine).

- [ ] **Step 4: Real full run**

With `BEDROCK_BEARER_TOKEN` still exported in the same shell session (re-export it in the same command if your tool doesn't preserve env vars across calls):
```bash
export BEDROCK_BEARER_TOKEN=$(curl -s "http://localhost:7100/api/vault/credentials/bedrock-aws1812-dev/reveal?confirm=true" | python3 -c "import json,sys; print(json.load(sys.stdin)['secretValue'])")
pnpm eval:judge-full
```
Expected: takes several minutes (73 items, up to 2 real calls each). Writes `eval/dataset/judgments.json` and `eval/results/<date>-disagreements.md`. Watch the per-item console output for any `Judge call FAILED` lines — a small number is acceptable (log them), a large fraction (e.g. more than 5-10) means something is wrong and should be investigated before declaring success.

- [ ] **Step 5: Sanity-check the results**

```bash
python3 -c "
import json
j = json.load(open('eval/dataset/judgments.json'))
print('total judgments:', len(j))
print('by provenance:', {p: sum(1 for x in j if x['label_provenance']==p) for p in set(x['label_provenance'] for x in j)})
print('disagreements:', sum(1 for x in j if x.get('disagreement')))
"
cat eval/results/*-disagreements.md | head -40
```
Confirm: a meaningful fraction has `label_provenance: 'behavioral'` (proving the shortcut fired), the rest are `'llm'` (dual-judge reconciled), and the disagreement count is a small fraction of the total (if it's a large fraction, e.g. >20%, that's worth noting as a real finding, not silently accepting).

- [ ] **Step 6: Update the roadmap**

In `docs/superpowers/ROADMAP.md`: mark issue I10 **resolved** (real fix landed in Task 1/2 of this plan, not the skip-and-log workaround). Add a note that `eval/dataset/judgments.json` now reflects the full 73-item pool via dual-judge + behavioral-shortcut grading, superseding the earlier 20-item partial file from the retired human-calibration run. Record the real counts from Step 5 (total judgments, provenance breakdown, disagreement count) and the real cost incurred (approximate call count from the dry-run estimate). Note that the human calibration gate is retired per this plan's design doc, and `eval/results/2026-07-07-calibration-sample.md` remains only as a historical record of Tom's initial (abandoned) review attempt.

- [ ] **Step 7: Commit**

```bash
git add eval/dataset/judgments.json eval/results/*-disagreements.md docs/superpowers/ROADMAP.md
git commit -m "feat(eval): real full-pool dual-judge run — supersedes 20-item calibration sample

Real run against the live production index: 73 items judged via
behavioral-shortcut + dual-judge (medium + heavy tier) reconciliation.
Issue I10 (JSON-escaping bug) fixed for real in this plan's Tasks 1-2,
not worked around. See docs/superpowers/ROADMAP.md for exact counts."
```

---

## Notes for the next plan (out of scope here)

- **Phase 3 scoring/scorecard**: consumes the completed `judgments.json` (now full-pool, dual-judge) + Phase 1's `eval/results/*-runs.json` to compute recall/precision/MRR per the original Track A spec §7. Unaffected by *how* judgments.json was produced.
- **Passive telemetry refresh cadence**: document in `eval/README.md` (or ROADMAP) that re-running `eval:mine`'s behavioral-signal extraction before any future full-pool judging run picks up new real usage since the last run — a process note, not new code, per this design's §6.

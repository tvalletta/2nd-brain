# Quality-Layer Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire three fully-implemented but dormant mechanisms — the significance gate, contradiction/duplicate review detection, and entity-dedup auto-merge — into the real ingest and scheduling paths, so `config.maintenance.reviewEnabled` and `config.enrichment.significanceGate` actually do something.

**Architecture:** No new subsystems. Every piece of logic this plan needs (heuristic/LLM gating, contradiction/duplicate detection, entity merge, job scheduling) already exists in the codebase — it's just never called from the code paths that run in production. This plan adds call sites, one new small shared helper (`createReviewItem`), two new schema fields, and test coverage; it does not invent new algorithms.

**Tech Stack:** TypeScript (ESM), Zod, Vitest, the existing job-queue/scheduler system.

**Source of truth:** `docs/superpowers/specs/2026-07-23-quality-layer-activation-design.md` — read it before starting if anything here seems underspecified. This plan supersedes the spec's pseudocode with exact, verified code (the spec was corrected twice during planning after reading the real source; those corrections are folded in below).

## Global Constraints

- `pnpm build`, `pnpm test`, and `pnpm lint` (tsc --noEmit, strict) must all pass before every commit.
- ESM only — all relative imports use `.js` extensions, even for `.ts` source files.
- Protected regions use `OPEN_TAG`/`CLOSE_TAG` from `src/vault/protected-regions.js` — never hardcode `%% begin:id %%` strings.
- All vault filesystem access goes through `VaultAdapter` — never Node's `fs` directly.
- Use `layoutFromConfig(config)` for any vault path — never hardcode `wiki/` or similar.
- New scheduled jobs need a `dedupeKey` to prevent duplicate enqueues.
- Commit after each task, not each step within a task.

---

### Task 1: Extend the significance gate with a confidence signal, and make the LLM path actually reachable

**Files:**
- Modify: `src/intelligence/significance-gate.ts`
- Modify: `src/config/schema.ts`
- Test: `test/intelligence/significance-gate.test.ts` (new file)

**Interfaces:**
- Produces: `GateDecision`'s `drop` variant gains an optional `confidence?: number`; `llmGate()` and `heuristicGate()` keep their existing signatures (`(input: ExtractedEntity, candidates: ExistingEntity[]) => GateDecision`, and the async LLM variant `(llm, input, candidates) => Promise<GateDecision>`). `KarpathyConfig['enrichment']` gains `significanceGateDropConfidence: number` and `significanceGate`'s default changes from `'heuristic'` to `'llm'`.
- Consumes: nothing new — this task only touches `significance-gate.ts` and `config/schema.ts`.

**Context:** `llmGate()` currently has **zero callers anywhere in the codebase** (verified via `grep -rn "llmGate(" src/ test/`). It also short-circuits — `if (candidates.length === 0) return heuristic;` — before ever calling the LLM. Task 3 will call it with an empty candidates array (there's no similarity lookup to populate it with — see Task 3's context note), which means today's short-circuit would make the LLM permanently unreachable. Removing it is safe: nothing depends on the current behavior since nothing calls this function yet.

- [ ] **Step 1: Write the failing tests**

Create `test/intelligence/significance-gate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { heuristicGate, llmGate } from '../../src/intelligence/significance-gate.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function makeLLM(response: unknown): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(response);
    },
  };
}

describe('significance-gate', () => {
  describe('heuristicGate', () => {
    it('drops names shorter than 3 characters with no confidence field', () => {
      const decision = heuristicGate({ name: 'ai', kind: 'tool' }, []);
      expect(decision).toEqual({ action: 'drop', reason: 'name too short' });
    });

    it('keeps ordinary names when there is nothing similar to compare against', () => {
      const decision = heuristicGate({ name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(decision).toEqual({ action: 'keep' });
    });
  });

  describe('llmGate', () => {
    it('actually calls the LLM even when candidates is empty', async () => {
      let called = false;
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
          called = true;
          return schema.parse({ action: 'keep' });
        },
      };
      await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(called).toBe(true);
    });

    it('propagates confidence through on a drop verdict', async () => {
      const llm = makeLLM({ action: 'drop', reason: 'generic jargon', confidence: 0.4 });
      const decision = await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(decision).toEqual({ action: 'drop', reason: 'generic jargon', confidence: 0.4 });
    });

    it('leaves confidence undefined when the LLM response omits it', async () => {
      const llm = makeLLM({ action: 'drop', reason: 'generic jargon' });
      const decision = await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect((decision as { confidence?: number }).confidence).toBeUndefined();
    });

    it('short-circuits to the heuristic without calling the LLM for obvious drops', async () => {
      let called = false;
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
          called = true;
          return schema.parse({});
        },
      };
      const decision = await llmGate(llm, { name: 'ai', kind: 'tool' }, []);
      expect(called).toBe(false);
      expect(decision).toEqual({ action: 'drop', reason: 'name too short' });
    });

    it('falls back to keep when the LLM call throws', async () => {
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured() {
          throw new Error('LLM call failed');
        },
      };
      const decision = await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(decision).toEqual({ action: 'keep' });
    });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm exec vitest run test/intelligence/significance-gate.test.ts --reporter=verbose
```

Expected: the "actually calls the LLM even when candidates is empty" test fails (`called` stays `false`) — this is the bug Task 1 fixes. The confidence-propagation tests fail on a schema-validation error, since `confidence` isn't in `GateResultSchema` yet.

- [ ] **Step 3: Add `confidence` to the type and schema**

In `src/intelligence/significance-gate.ts`, replace:

```typescript
export type GateDecision =
  | { action: 'keep' }
  | { action: 'merge'; intoSlug: string }
  | { action: 'drop'; reason: string };
```

with:

```typescript
export type GateDecision =
  | { action: 'keep' }
  | { action: 'merge'; intoSlug: string }
  | { action: 'drop'; reason: string; confidence?: number };
```

and replace:

```typescript
const GateResultSchema = z.object({
  action: z.enum(['keep', 'merge', 'drop']),
  into_slug: z.string().nullable().optional(),
  reason: z.string().optional(),
});
```

with:

```typescript
const GateResultSchema = z.object({
  action: z.enum(['keep', 'merge', 'drop']),
  into_slug: z.string().nullable().optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
```

- [ ] **Step 4: Remove the empty-candidates short-circuit and propagate confidence**

Replace the entire `llmGate` function body with:

```typescript
export async function llmGate(
  llm: LLMClient,
  extracted: ExtractedEntity,
  candidates: ExistingEntity[],
): Promise<GateDecision> {
  // Always run the heuristic first to short-circuit obvious cases.
  const heuristic = heuristicGate(extracted, candidates);
  if (heuristic.action !== 'keep') return heuristic;
  // NOTE: this used to also `return heuristic` whenever candidates.length
  // === 0. That made the LLM unreachable for brand-new entities judged in
  // isolation (no similar existing entities to compare against) — exactly
  // the case the caller needs this for. The LLM can still judge keep/drop
  // from name+kind+context alone; only the "merge" suggestion needs
  // candidates, so an empty list just means merge is off the table.

  const candidatesBlock =
    candidates.length > 0
      ? candidates
          .slice(0, 5)
          .map((c, i) => `[${i + 1}] slug=${c.slug} name=${c.name} kind=${c.kind} sim=${c.similarity.toFixed(2)}`)
          .join('\n')
      : '(none — judge this entity on its own merits)';
  const prompt = `Decide whether the extracted entity below deserves its own page in our knowledge base.

Extracted:
  name: ${extracted.name}
  kind: ${extracted.kind}
  context: ${extracted.context ?? '(none)'}

Existing similar entities:
${candidatesBlock}

Return JSON:
{
  "action": "keep" | "merge" | "drop",
  "into_slug": "<slug from above if action=merge>",
  "reason": "<brief why>",
  "confidence": <0.0-1.0, how certain you are in this judgment — especially important for "drop": a low-confidence drop means you're not sure this isn't a real, worth-keeping entity>
}

Use "merge" when the extracted name is the same entity under a slightly different spelling (alias). Use "drop" when the name is generic, ambiguous, or low-signal. Use "keep" otherwise.

Output ONLY a single fenced \`\`\`json block.`;
  try {
    const result = await llm.extractStructured(prompt, GateResultSchema);
    if (result.action === 'merge' && result.into_slug) {
      return { action: 'merge', intoSlug: result.into_slug };
    }
    if (result.action === 'drop') {
      return { action: 'drop', reason: result.reason ?? 'LLM-judged low signal', confidence: result.confidence };
    }
    return { action: 'keep' };
  } catch {
    // On LLM failure, fall back to keep — the legacy behaviour.
    return { action: 'keep' };
  }
}
```

- [ ] **Step 5: Update the config schema**

In `src/config/schema.ts`, replace:

```typescript
  /** D4: Significance gate — `off` legacy behaviour, `heuristic` (cheap), or `llm` (Bedrock-backed). */
  significanceGate: z.enum(['off', 'heuristic', 'llm']).default('heuristic'),
});
```

with:

```typescript
  /** D4: Significance gate — `off` legacy behaviour, `heuristic` (cheap), or `llm` (Bedrock-backed). */
  significanceGate: z.enum(['off', 'heuristic', 'llm']).default('llm'),
  /** Below this confidence, an LLM "drop" verdict creates the page anyway and flags it for review instead of silently discarding it. */
  significanceGateDropConfidence: z.number().min(0).max(1).default(0.7),
});
```

(This is the closing of `EnrichmentConfigSchema` at `src/config/schema.ts:210-221` — the edit is the last two lines before the closing `});`.)

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/intelligence/significance-gate.test.ts --reporter=verbose
```

Expected: all 8 tests pass.

- [ ] **Step 7: Run the full test suite to check for regressions from the config default change**

```bash
pnpm test
```

Expected: all pass. Pay particular attention to `test/jobs/handlers/link-concepts.test.ts` (explicitly sets `significanceGate: 'off'`, unaffected by the default change) and `test/hooks/hooks.test.ts` / `test/agent/tool-registry.test.ts` (construct `KarpathyConfig` object literals by hand — if either fails to typecheck or fails an equality assertion because of the new `significanceGateDropConfidence` field or the changed default, fix the literal to include the field explicitly rather than relying on the default).

- [ ] **Step 8: Commit**

```bash
git add src/intelligence/significance-gate.ts src/config/schema.ts test/intelligence/significance-gate.test.ts
git commit -m "feat(gate): add confidence signal to significance gate; default to llm mode"
```

---

### Task 2: Extract a shared `createReviewItem` helper and refactor `link-concepts.ts` to use it

**Files:**
- Create: `src/review/create-review-item.ts`
- Modify: `src/jobs/handlers/link-concepts.ts`
- Test: `test/review/create-review-item.test.ts` (new file)

**Interfaces:**
- Produces: `createReviewItem(vault: VaultAdapter, input: ReviewItemInput): Promise<string>` (returns the written path) — Task 3 will import and call this.
- Consumes: nothing new.

**Context:** `get_review_queue` (`src/review/review-queue.ts:listReviewItems`) only lists files inside the `review/` folder — it does not scan the vault for a `review_state` frontmatter value, and every newly-created entity page already defaults to `review_state: 'unreviewed'` regardless (`src/ingest/entity-writer.ts:185`). So "flag for review" must mean "write a review-item note into `review/`," which `link-concepts.ts` already does today for ambiguous entity resolution via a private `createAmbiguousReviewItem` function (`link-concepts.ts:198-260`). This task extracts that into a shared, generalized helper so Task 3 can reuse it instead of duplicating the logic.

- [ ] **Step 1: Write the failing test**

Create `test/review/create-review-item.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { createReviewItem } from '../../src/review/create-review-item.js';

describe('createReviewItem', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-review-item-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a review note under review/ with the expected frontmatter', async () => {
    const path = await createReviewItem(vault, {
      slug: 'test-item',
      title: 'Uncertain: Zephyr Protocol (concept)',
      claimA: 'claim A',
      claimB: 'claim B',
      sourceRefs: ['sources/s1.md'],
      links: ['wiki/concepts/zephyr-protocol.md'],
      conflictType: 'uncertain_entity_drop',
      body: '\n# Uncertain: Zephyr Protocol\n\nBody text.\n',
    });

    expect(path).toBe('review/test-item.md');
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    expect(data.type).toBe('contradiction');
    expect(data.conflict_type).toBe('uncertain_entity_drop');
    expect(data.review_state).toBe('unreviewed');
    expect(data.resolution_state).toBe('open');
    expect(data.source_refs).toEqual(['sources/s1.md']);
    expect(data.links).toEqual(['wiki/concepts/zephyr-protocol.md']);
    expect(body).toContain('Body text.');
  });

  it('overwrites an existing review note with the same slug', async () => {
    await createReviewItem(vault, {
      slug: 'test-item',
      title: 'First',
      claimA: 'a',
      claimB: 'b',
      sourceRefs: [],
      links: [],
      conflictType: 'x',
      body: 'first body',
    });
    await createReviewItem(vault, {
      slug: 'test-item',
      title: 'Second',
      claimA: 'a2',
      claimB: 'b2',
      sourceRefs: [],
      links: [],
      conflictType: 'x',
      body: 'second body',
    });
    const { data, body } = parseNote(await vault.read('review/test-item.md'));
    expect(data.title).toBe('Second');
    expect(body).toContain('second body');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm exec vitest run test/review/create-review-item.test.ts --reporter=verbose
```

Expected: FAIL — cannot find module `src/review/create-review-item.js`.

- [ ] **Step 3: Create `src/review/create-review-item.ts`**

```typescript
import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { nowISO } from '../shared/date-utils.js';

export interface ReviewItemInput {
  /** Filename (without `.md`) under `review/` — caller is responsible for slugifying. */
  slug: string;
  title: string;
  claimA: string;
  claimB: string;
  sourceRefs: string[];
  links: string[];
  conflictType: string;
  /** Full markdown body, including any protected-region tags the caller wants preserved. */
  body: string;
}

/**
 * Write (or overwrite) a `type: contradiction` review note into `review/`,
 * surfaced by the `get_review_queue` MCP tool. Shared by the ambiguous-entity
 * path (link-concepts.ts) and the significance-gate uncertain-drop path
 * (compiler.ts) — both need "flag this for a human without deleting or
 * guessing," and this is the vault's one existing mechanism for that.
 */
export async function createReviewItem(vault: VaultAdapter, input: ReviewItemInput): Promise<string> {
  await vault.ensureFolder('review');
  const reviewPath = `review/${input.slug}.md`;

  const frontmatter = {
    id: nanoid(),
    type: 'contradiction',
    title: input.title,
    status: 'draft',
    confidence: 'low',
    review_state: 'unreviewed',
    created_at: nowISO(),
    updated_at: nowISO(),
    conflict_type: input.conflictType,
    claim_a: input.claimA,
    claim_b: input.claimB,
    resolution_state: 'open',
    source_refs: input.sourceRefs,
    derived_from: [],
    aliases: [],
    links: input.links,
    change_origin: 'heuristic_review',
    protected_regions: ['analysis'],
  };

  const content = `---\n${Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n---\n${input.body}`;

  if (await vault.exists(reviewPath)) {
    await vault.write(reviewPath, content);
  } else {
    await vault.create(reviewPath, content);
  }
  return reviewPath;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm exec vitest run test/review/create-review-item.test.ts --reporter=verbose
```

- [ ] **Step 5: Refactor `link-concepts.ts` to use the shared helper**

In `src/jobs/handlers/link-concepts.ts`:

Remove the `nanoid` import (line 8: `import { nanoid } from 'nanoid';`) — it will no longer be used in this file.

Add an import: `import { createReviewItem } from '../../review/create-review-item.js';`

Replace:

```typescript
        } else if (resolution.status === 'ambiguous') {
          // Create review item for ambiguous resolution
          await createAmbiguousReviewItem(context, entity.name, kind, resolution.candidates ?? [], summaryPath);
          log.warn('Ambiguous entity resolution', { name: entity.name, kind, candidates: resolution.candidates?.length });
        }
```

with:

```typescript
        } else if (resolution.status === 'ambiguous') {
          const candidates = resolution.candidates ?? [];
          const candidateList = candidates
            .map((c) => `- [[${c.path.split('/').pop()?.replace(/\.md$/, '')}]] (confidence: ${c.confidence.toFixed(2)})`)
            .join('\n');
          await createReviewItem(context.vault, {
            slug: slugify(`ambiguous-${entity.name}`),
            title: `Ambiguous: ${entity.name} (${kind})`,
            claimA: `Entity "${entity.name}" found in ${summaryPath}`,
            claimB: `Multiple matching pages: ${candidates.map((c) => c.path).join(', ')}`,
            sourceRefs: [summaryPath],
            links: candidates.map((c) => c.path),
            conflictType: 'ambiguous_entity',
            body: `
# Ambiguous Entity: ${entity.name}

**Kind:** ${kind}
**Source:** [[${summaryPath.split('/').pop()?.replace(/\.md$/, '')}]]

## Candidates
${candidateList}

## Analysis
${OPEN_TAG('analysis')}
Multiple pages match the entity "${entity.name}". Please review and resolve by:
1. Merging duplicate pages
2. Adding an alias to the correct page
3. Dismissing incorrect candidates
${CLOSE_TAG('analysis')}
`,
          });
          log.warn('Ambiguous entity resolution', { name: entity.name, kind, candidates: candidates.length });
        }
```

Delete the entire `createAmbiguousReviewItem` function (currently `link-concepts.ts:198-260`, from `async function createAmbiguousReviewItem(` through its closing `}`) — it's now unused.

Check remaining imports in the file: `slugify` (still used at the new call site), `OPEN_TAG`/`CLOSE_TAG` (still used at the new call site) — both stay. `nanoid` — no longer used anywhere in the file, remove its import.

- [ ] **Step 6: Run the existing link-concepts tests**

```bash
pnpm exec vitest run test/jobs/handlers/link-concepts.test.ts --reporter=verbose
```

Expected: PASS (the existing test only covers the non-ambiguous happy path, so this refactor doesn't change its assertions — but it does exercise the file's imports/compilation).

- [ ] **Step 7: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add src/review/create-review-item.ts src/jobs/handlers/link-concepts.ts test/review/create-review-item.test.ts
git commit -m "refactor(review): extract createReviewItem helper from link-concepts ambiguous-entity path"
```

---

### Task 3: Wire the significance gate into `compiler.ts`

**Files:**
- Modify: `src/compilation/compiler.ts`
- Modify: `src/jobs/handlers/compile-entities.ts`
- Test: `test/compilation/compiler.test.ts` (new file — no test file exists for `compiler.ts` today)

**Interfaces:**
- Consumes: `heuristicGate`/`llmGate` from Task 1, `createReviewItem` from Task 2, `createBudgetTrackerFromConfig` from `src/shared/budget.ts` (existing, used today by `src/jobs/handlers/topic-refresh.ts` the same way).
- Produces: `compileFromSource`'s `context` parameter gains a required `projectRoot: string` field — Task 3 updates its one caller (`compile-entities.ts`) to pass it.

**Context:** `compiler.ts` is the shared choke-point both the production rich-extraction path (`compile-entities.ts`) and the legacy path (`link-concepts.ts`, via manual re-enrichment) eventually run entity creation through — but today it calls `createEntityPage()` unconditionally with no gate at all. `candidates` is passed as `[]` to the gate here, matching the only existing precedent (`link-concepts.ts` also calls the heuristic gate with `[]`) — there's no similarity-lookup helper anywhere in the codebase to populate it with, and building one is out of scope (full duplicate detection across the vault is Task 4's job, via a much more thorough pairwise scan). This means the gate's `merge` action is unreachable in this wiring — that's fine, `keep`/`drop` is all this call site needs.

- [ ] **Step 1: Write the failing tests**

Create `test/compilation/compiler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { compileFromSource, type CompilableEntity } from '../../src/compilation/compiler.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function makeEntity(overrides: Partial<CompilableEntity> = {}): CompilableEntity {
  return {
    name: 'Zephyr Protocol',
    kind: 'concept',
    context: 'A protocol discussed in the meeting.',
    relationships: [],
    chunkRefs: [],
    ...overrides,
  };
}

function makeLLM(response: unknown): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(response);
    },
  };
}

describe('compileFromSource — significance gate integration', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-compiler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gate off: always creates the page regardless of gate logic', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'off' },
    });
    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'ai' })], // would be dropped by heuristic if the gate were on
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('heuristic mode: confident drop creates no page and no review item', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'heuristic' },
    });
    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'ai' })], // < 3 chars -> heuristic drop, no confidence field
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual(['ai']);
    expect(await vault.listMarkdownFiles('wiki/concepts')).toHaveLength(0);
    expect(await vault.listMarkdownFiles('review')).toHaveLength(0);
  });

  it('llm mode: confident drop (high confidence) creates no page and no review item', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    const llm = makeLLM({ action: 'drop', reason: 'generic jargon', confidence: 0.95 });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual(['Zephyr Protocol']);
    expect(await vault.listMarkdownFiles('review')).toHaveLength(0);
  });

  it('llm mode: uncertain drop (low confidence) still creates the page AND flags it for review', async () => {
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
  });

  it('llm mode: keep verdict creates the page normally with no review item', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm' },
    });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm: makeLLM({ action: 'keep' }),
      config,
      projectRoot: dir,
    });
    expect(result.created).toHaveLength(1);
    expect(await vault.listMarkdownFiles('review')).toHaveLength(0);
  });

  it('llm mode: falls back to the heuristic (keep) when the daily budget is exhausted', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm' },
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 50, heavy: 10 } } },
    });
    let called = false;
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        called = true;
        return schema.parse({ action: 'drop', reason: 'x', confidence: 0.99 });
      },
    };
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });
    expect(called).toBe(false); // budget exhausted -> never reserved -> heuristic path used instead
    expect(result.created).toHaveLength(1); // heuristic keeps non-trivial names
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm exec vitest run test/compilation/compiler.test.ts --reporter=verbose
```

Expected: FAIL — `compileFromSource`'s context type doesn't accept `projectRoot` yet (TS error), and the gate-related assertions fail since no gate is wired in.

- [ ] **Step 3: Replace `src/compilation/compiler.ts` with the gate-aware version**

Full file contents:

```typescript
import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { EntityKind } from '../ingest/entity-resolver.js';
import { buildEntityIndex, resolveEntity } from '../ingest/entity-resolver.js';
import { createEntityPage } from '../ingest/entity-writer.js';
import { compileEntityPage } from './entity-compiler.js';
import { layoutFromConfig } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';
import { heuristicGate, llmGate } from '../intelligence/significance-gate.js';
import { createReviewItem } from '../review/create-review-item.js';
import { createBudgetTrackerFromConfig } from '../shared/budget.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';

const log = createLogger('compiler');

export interface CompilationResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

export interface CompilableEntity {
  name: string;
  kind: EntityKind;
  context: string;
  role?: string;
  status?: string;
  definition?: string;
  relationships: Array<{
    target: string;
    targetKind: string;
    relationship: string;
  }>;
  chunkRefs: string[];
}

export async function compileFromSource(
  sourcePath: string,
  entities: CompilableEntity[],
  context: { vault: VaultAdapter; llm: LLMClient; config: KarpathyConfig; projectRoot: string },
): Promise<CompilationResult> {
  const { vault, llm, config, projectRoot } = context;
  const layout = layoutFromConfig(config);
  const budget = createBudgetTrackerFromConfig(config, projectRoot);
  const result: CompilationResult = {
    created: [],
    updated: [],
    skipped: [],
  };

  log.info('Starting compilation', { sourcePath, entityCount: entities.length });

  const entityIndex = await buildEntityIndex(vault, layout);

  for (const entity of entities) {
    const resolution = resolveEntity(
      { name: entity.name, kind: entity.kind },
      entityIndex,
      layout,
    );

    log.debug('Entity resolution', {
      name: entity.name,
      kind: entity.kind,
      status: resolution.status,
      matchedPath: resolution.matchedPath,
    });

    if (resolution.status === 'ambiguous') {
      log.warn('Ambiguous entity match, skipping', {
        name: entity.name,
        kind: entity.kind,
        candidates: resolution.candidates?.map((c) => c.path),
      });
      result.skipped.push(entity.name);
      continue;
    }

    let existingPagePath: string | null = null;

    if (resolution.status === 'new') {
      // D4 significance gate: decide whether this brand-new entity deserves
      // a page before creating one. `candidates` is always [] here — no
      // similarity lookup is built for this call site; full duplicate/merge
      // detection across the vault is handled separately by the scheduled
      // detect-entity-dupes job. See
      // docs/superpowers/specs/2026-07-23-quality-layer-activation-design.md
      // §5.2 for why.
      let flaggedForReview: { reason: string; confidence?: number } | undefined;

      if (config.enrichment.significanceGate !== 'off') {
        const gateInput = { name: entity.name, kind: entity.kind, context: entity.context };
        const decision =
          config.enrichment.significanceGate === 'llm' && budget.tryReserve('fast')
            ? await llmGate(llm, gateInput, [])
            : heuristicGate(gateInput, []);

        if (decision.action === 'drop') {
          const threshold = config.enrichment.significanceGateDropConfidence;
          const isUncertain = decision.confidence !== undefined && decision.confidence < threshold;
          if (!isUncertain) {
            log.debug('Significance gate dropped entity', { name: entity.name, reason: decision.reason });
            result.skipped.push(entity.name);
            continue;
          }
          flaggedForReview = { reason: decision.reason, confidence: decision.confidence };
          log.debug('Significance gate uncertain, creating and flagging for review', {
            name: entity.name,
            reason: decision.reason,
            confidence: decision.confidence,
          });
        }
      }

      // Create a new page using entity-writer, then compile on top
      const createdPath = await createEntityPage(vault, resolution, {
        name: entity.name,
        kind: entity.kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs,
      }, sourcePath, layout);

      existingPagePath = createdPath;

      log.info('Created new entity page', { path: createdPath, name: entity.name });

      // Update the index so subsequent entities can find this page
      const slug = createdPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
      entityIndex.bySlug.set(slug, createdPath);
      entityIndex.byCanonicalName.set(entity.name.toLowerCase(), createdPath);

      result.created.push(createdPath);

      if (flaggedForReview) {
        await createReviewItem(vault, {
          slug: `uncertain-drop-${slug}`,
          title: `Uncertain: ${entity.name} (${entity.kind})`,
          claimA: `Significance gate suggested dropping this entity: ${flaggedForReview.reason}`,
          claimB: `Confidence ${flaggedForReview.confidence} is below the review threshold (${config.enrichment.significanceGateDropConfidence})`,
          sourceRefs: [sourcePath],
          links: [createdPath],
          conflictType: 'uncertain_entity_drop',
          body: `
# Uncertain: ${entity.name}

**Kind:** ${entity.kind}
**Page created:** [[${slug}]]
**Source:** [[${sourcePath.split('/').pop()?.replace(/\.md$/, '')}]]

## Analysis
${OPEN_TAG('analysis')}
The significance gate suggested dropping "${entity.name}" (${flaggedForReview.reason}), but confidence ${flaggedForReview.confidence} was below the review threshold, so the page was created rather than silently discarded. Review [[${slug}]] and decide whether it deserves to exist — approve to keep it, reject to remove it.
${CLOSE_TAG('analysis')}
`,
        });
      }
    } else {
      // Matched existing page
      existingPagePath = resolution.matchedPath!;
    }

    try {
      const compiledPath = await compileEntityPage(
        entity,
        existingPagePath,
        sourcePath,
        { vault, llm },
      );

      if (resolution.status === 'matched' && !result.created.includes(compiledPath)) {
        result.updated.push(compiledPath);
      }
    } catch (err) {
      log.error('Failed to compile entity page', {
        name: entity.name,
        path: existingPagePath,
        error: (err as Error).message,
      });
      result.skipped.push(entity.name);
    }
  }

  log.info('Compilation complete', {
    created: result.created.length,
    updated: result.updated.length,
    skipped: result.skipped.length,
  });

  return result;
}
```

- [ ] **Step 4: Pass `projectRoot` from the job handler**

In `src/jobs/handlers/compile-entities.ts`, replace:

```typescript
    // 2. Call compileFromSource
    const result = await compileFromSource(sourceSummaryPath, compilable, {
      vault: context.vault,
      llm: context.llm,
      config: context.config,
    });
```

with:

```typescript
    // 2. Call compileFromSource
    const result = await compileFromSource(sourceSummaryPath, compilable, {
      vault: context.vault,
      llm: context.llm,
      config: context.config,
      projectRoot: context.projectRoot,
    });
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/compilation/compiler.test.ts --reporter=verbose
```

- [ ] **Step 6: Run the full test suite**

```bash
pnpm test
```

Expected: all pass, including `test/jobs/handlers/compile-entities.test.ts` if it exists (verify it still compiles with the new `projectRoot` field — check for any hand-built `CompilationContext`-shaped test fixtures that might need the field added).

- [ ] **Step 7: Commit**

```bash
git add src/compilation/compiler.ts src/jobs/handlers/compile-entities.ts test/compilation/compiler.test.ts
git commit -m "feat(compiler): wire significance gate into the real entity-creation path"
```

---

### Task 4: Entity-dedup auto-merge routing

**Files:**
- Modify: `src/compilation/entity-merger.ts`
- Modify: `src/jobs/handlers/detect-entity-dupes.ts`
- Modify: `test/jobs/handlers/detect-entity-dupes.test.ts` (extend existing file)

**Interfaces:**
- Produces: `AUTO_MERGE_THRESHOLD` exported constant (`0.85`) from `entity-merger.ts`.
- Consumes: existing `detectMergeCandidates`, `mergeEntities` (`entity-merger.ts`), `refreshQueue` (`src/maintenance/reconciliation-queue.ts`), `appendLogEntry` (`src/maintenance/vault-log.ts`) — no signature changes to any of these.

**Context:** `mergeEntities`'s real signature is `mergeEntities(sourcePath: string, targetPath: string, vault: VaultAdapter, layout?: VaultLayout)` — parameter order matters, verified by reading `entity-merger.ts` directly. The existing test "writes candidates to reconciliation queue" (Alice/Alise, Levenshtein distance 1, confidence 0.8) stays below the 0.85 auto-merge threshold and will continue to land in the queue unmodified. The existing "is idempotent" test (currently Dave/"Dave S") is a **substring match**, which scores confidence 0.9 — **above** the new auto-merge threshold — so it would get auto-merged on the first run instead of queued, silently weakening what that test proves. Step 5 fixes this by changing the second name to a small typo instead of a substring, keeping it in Levenshtein-match territory (confidence 0.8, stays queued).

- [ ] **Step 1: Export `AUTO_MERGE_THRESHOLD` from `entity-merger.ts`**

In `src/compilation/entity-merger.ts`, immediately above the `autoMerge` function, add:

```typescript
/** Confidence at or above which a detected duplicate is merged without human review. */
export const AUTO_MERGE_THRESHOLD = 0.85;

```

Then replace the `autoMerge` signature:

```typescript
export async function autoMerge(
  vault: VaultAdapter,
  threshold = 0.85,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<MergeResult[]> {
```

with:

```typescript
export async function autoMerge(
  vault: VaultAdapter,
  threshold = AUTO_MERGE_THRESHOLD,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<MergeResult[]> {
```

- [ ] **Step 2: Run existing entity-merger tests to confirm no regression**

```bash
pnpm exec vitest run test/compilation/entity-merger.test.ts --reporter=verbose
```

Expected: PASS (default value unchanged, just named now).

- [ ] **Step 3: Write the new failing tests for detect-entity-dupes routing**

Append to `test/jobs/handlers/detect-entity-dupes.test.ts` (inside the existing `describe('detect-entity-dupes handler', ...)` block, after the existing three `it(...)` blocks, before the closing `});`):

```typescript
  it('auto-merges candidates at or above the 0.85 confidence threshold', async () => {
    // Alias-overlap match scores confidence 0.95 in entity-merger.ts, well above threshold.
    const shared = 'outputs/source-summaries/source3.md';
    const fmA = {
      id: 'p1',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Patricia Vaughn',
      title: 'Patricia Vaughn',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: ['Pat Vaughn'],
    };
    const fmB = {
      id: 'p2',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Pat Vaughn',
      title: 'Pat Vaughn',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    await vault.create('wiki/entities/people/patricia-vaughn.md', serializeNote(fmA, ''));
    await vault.create('wiki/entities/people/pat-vaughn.md', serializeNote(fmB, ''));

    const ctx = makeCtx();
    await detectEntityDupesHandler.execute(makeJob(), ctx);

    // One of the two pages should have been deleted by the auto-merge.
    const remaining = await vault.listMarkdownFiles('wiki/entities/people');
    expect(remaining).toHaveLength(1);

    const layout = KarpathyConfigSchema.parse({ vaultPath: dir }).layout;
    const queue = await readReconciliationQueue(vault, layout);
    // The auto-merged pair should NOT also be sitting in the manual-review queue.
    expect(queue.entries).toHaveLength(0);
  });

  it('queues candidates below the auto-merge threshold instead of merging them', async () => {
    // Levenshtein distance 2, 1 shared source -> confidence 0.8, below threshold.
    const shared = 'outputs/source-summaries/source4.md';
    const fmA = {
      id: 'q1',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Dave',
      title: 'Dave',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    const fmB = {
      id: 'q2',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Daev',
      title: 'Daev',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    await vault.create('wiki/entities/people/dave.md', serializeNote(fmA, ''));
    await vault.create('wiki/entities/people/daev.md', serializeNote(fmB, ''));

    const ctx = makeCtx();
    await detectEntityDupesHandler.execute(makeJob(), ctx);

    // Neither page should have been deleted (below auto-merge threshold).
    const remaining = await vault.listMarkdownFiles('wiki/entities/people');
    expect(remaining).toHaveLength(2);

    const layout = KarpathyConfigSchema.parse({ vaultPath: dir }).layout;
    const queue = await readReconciliationQueue(vault, layout);
    expect(queue.entries.length).toBeGreaterThan(0);
  });
```

Also update the existing "is idempotent" test's `fmY` to avoid the substring-match confidence bump (find the test named `'is idempotent — running twice does not duplicate queue entries'`): change

```typescript
    const fmY = { id: 'y1', type: 'entity', entity_kind: 'person', canonical_name: 'Dave S', title: 'Dave S', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_refs: [shared], aliases: [] };
    await vault.create('wiki/entities/people/dave.md', serializeNote(fmX, ''));
    await vault.create('wiki/entities/people/dave-s.md', serializeNote(fmY, ''));
```

to:

```typescript
    const fmY = { id: 'y1', type: 'entity', entity_kind: 'person', canonical_name: 'Daev', title: 'Daev', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_refs: [shared], aliases: [] };
    await vault.create('wiki/entities/people/dave.md', serializeNote(fmX, ''));
    await vault.create('wiki/entities/people/daev.md', serializeNote(fmY, ''));
```

(This keeps the pair as a Levenshtein-distance-2 match, confidence 0.8, so it still lands in the queue and the idempotency assertion remains meaningful post-auto-merge-routing.)

- [ ] **Step 4: Run the tests to confirm the two new ones fail**

```bash
pnpm exec vitest run test/jobs/handlers/detect-entity-dupes.test.ts --reporter=verbose
```

Expected: the two new tests fail (nothing auto-merges yet); the modified idempotency test should still pass unchanged (routing doesn't exist yet, so it behaves exactly as before).

- [ ] **Step 5: Implement the routing in `detect-entity-dupes.ts`**

Replace the entire contents of `src/jobs/handlers/detect-entity-dupes.ts` with:

```typescript
import type { JobHandler, Job, JobContext } from '../types.js';
import { detectMergeCandidates, mergeEntities, AUTO_MERGE_THRESHOLD } from '../../compilation/entity-merger.js';
import { refreshQueue } from '../../maintenance/reconciliation-queue.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { createLogger } from '../../shared/logger.js';
import { layoutFromConfig } from '../../vault/paths.js';

const log = createLogger('handler:detect-entity-dupes');

export const detectEntityDupesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const layout = layoutFromConfig(context.config);
    const candidates = await detectMergeCandidates(context.vault);

    const autoCandidates = candidates.filter((c) => c.confidence >= AUTO_MERGE_THRESHOLD);
    const queueCandidates = candidates.filter((c) => c.confidence < AUTO_MERGE_THRESHOLD);

    let merged = 0;
    for (const c of autoCandidates) {
      try {
        await mergeEntities(c.sourcePath, c.targetPath, context.vault, layout);
        merged++;
        await appendLogEntry(
          context.vault,
          { kind: 'entity:automerge', message: `${c.sourceName} → ${c.targetName} (confidence ${c.confidence.toFixed(2)})` },
          layout,
        );
      } catch (err) {
        // Isolate per-candidate failures (e.g. target deleted concurrently)
        // so one bad candidate doesn't abort the rest of the run. The next
        // daily scan re-detects from scratch and will retry.
        log.warn('Auto-merge failed; leaving candidate for next scan', {
          sourcePath: c.sourcePath,
          targetPath: c.targetPath,
          error: (err as Error).message,
        });
      }
    }

    const added = queueCandidates.length > 0 ? await refreshQueue(context.vault, queueCandidates, layout) : 0;

    await appendLogEntry(
      context.vault,
      { kind: 'entity:dedupe', message: `${candidates.length} scanned → ${merged} auto-merged, ${added} newly queued` },
      layout,
    );

    log.info('Entity dupe detection complete', {
      detected: candidates.length,
      autoMerged: merged,
      newlyQueued: added,
    });
  },
};
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/jobs/handlers/detect-entity-dupes.test.ts --reporter=verbose
```

- [ ] **Step 7: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add src/compilation/entity-merger.ts src/jobs/handlers/detect-entity-dupes.ts test/jobs/handlers/detect-entity-dupes.test.ts
git commit -m "feat(dedup): auto-merge high-confidence entity duplicates, queue the rest"
```

---

### Task 5: Schedule review-detection and entity-dedup jobs; add observability logging

**Files:**
- Modify: `src/intelligence/scheduler.ts`
- Modify: `src/bin/intel-command.ts`
- Modify: `src/jobs/handlers/detect-contradictions.ts`
- Modify: `src/jobs/handlers/detect-duplicates.ts`
- Modify: `test/intelligence/scheduler.test.ts` (extend existing file)
- Test: `test/jobs/handlers/detect-contradictions.test.ts` (new file — none exists today)
- Test: `test/jobs/handlers/detect-duplicates.test.ts` (new file — none exists today)

**Interfaces:**
- Produces: `defaultSchedule(opts?: { reviewEnabled?: boolean }): ScheduledJob[]` — signature change, but the parameter is optional with a default, so the one existing call in `intel-command.ts` and all existing test calls (`defaultSchedule()`) keep working unchanged.
- Consumes: nothing new from earlier tasks — independent of Tasks 1-4, can be done in any order relative to them, but is listed last here since it's the piece that actually turns the other three on.

- [ ] **Step 1: Write the new failing scheduler tests**

Append to `test/intelligence/scheduler.test.ts` (inside the existing `describe('intelligence scheduler', ...)` block, after the existing tests, before the closing `});`):

```typescript
  it('defaultSchedule({}) matches the 6 baseline jobs (reviewEnabled defaults off)', () => {
    const schedule = defaultSchedule();
    expect(schedule).toHaveLength(6);
    expect(schedule.map((j) => j.type)).not.toContain('detect-contradictions');
  });

  it('defaultSchedule({ reviewEnabled: true }) adds the 3 review/dedup jobs', () => {
    const schedule = defaultSchedule({ reviewEnabled: true });
    expect(schedule).toHaveLength(9);
    const types = schedule.map((j) => j.type);
    expect(types).toContain('detect-contradictions');
    expect(types).toContain('detect-duplicates');
    expect(types).toContain('detect-entity-dupes');

    const contradictions = schedule.find((j) => j.type === 'detect-contradictions')!;
    expect(contradictions.cadence).toBe('daily');
    expect(contradictions.intervalSec).toBe(86_400);
    expect(contradictions.priority).toBe(80);
    expect(contradictions.dedupeKey).toBe('detect-contradictions');
  });

  it('defaultSchedule({ reviewEnabled: false }) is identical to defaultSchedule()', () => {
    expect(defaultSchedule({ reviewEnabled: false })).toEqual(defaultSchedule());
  });
```

- [ ] **Step 2: Run the tests to confirm the two new ones fail**

```bash
pnpm exec vitest run test/intelligence/scheduler.test.ts --reporter=verbose
```

Expected: the `reviewEnabled: true` test fails (`defaultSchedule` doesn't accept an argument yet — TS error or runtime ignoring it). The other two should already pass by coincidence (calling `defaultSchedule()` with no args still returns 6 today).

- [ ] **Step 3: Add `ScheduleOptions` and the 3 new schedule entries**

In `src/intelligence/scheduler.ts`, replace:

```typescript
export function defaultSchedule(): ScheduledJob[] {
  return [
```

with:

```typescript
export interface ScheduleOptions {
  /** When true, adds the daily review-detection and entity-dedup jobs. */
  reviewEnabled?: boolean;
}

export function defaultSchedule(opts: ScheduleOptions = {}): ScheduledJob[] {
  const schedule: ScheduledJob[] = [
```

and change the closing of the function from:

```typescript
    {
      type: 'rebuild-vault-artifacts',
      cadence: 'daily',
      intervalSec: 86_400,
      priority: 92,
      dedupeKey: 'rebuild-vault-artifacts',
    },
  ];
}
```

to:

```typescript
    {
      type: 'rebuild-vault-artifacts',
      cadence: 'daily',
      intervalSec: 86_400,
      priority: 92,
      dedupeKey: 'rebuild-vault-artifacts',
    },
  ];

  if (opts.reviewEnabled) {
    schedule.push(
      {
        type: 'detect-contradictions',
        cadence: 'daily',
        intervalSec: 86_400,
        priority: 80,
        dedupeKey: 'detect-contradictions',
      },
      {
        type: 'detect-duplicates',
        cadence: 'daily',
        intervalSec: 86_400,
        priority: 80,
        dedupeKey: 'detect-duplicates',
      },
      {
        type: 'detect-entity-dupes',
        cadence: 'daily',
        intervalSec: 86_400,
        priority: 80,
        dedupeKey: 'detect-entity-dupes',
      },
    );
  }

  return schedule;
}
```

(Every other entry in the array — `sync-fts-index`, `decay-scan`, `research-propose`, `rot-scan`, `digest-weekly` — stays exactly as it is today; only the enclosing `return [ ... ]` becomes `const schedule: ScheduledJob[] = [ ... ]` followed by the conditional push and an explicit `return schedule`.)

- [ ] **Step 4: Wire `intel-command.ts` to pass the config-aware schedule**

In `src/bin/intel-command.ts`, replace:

```typescript
      const tickResult = await tickScheduler({
        stateDir,
        enqueue: async (i) => queue.enqueue(i),
      });
```

with:

```typescript
      const tickResult = await tickScheduler({
        stateDir,
        enqueue: async (i) => queue.enqueue(i),
        schedule: defaultSchedule({ reviewEnabled: config.maintenance.reviewEnabled }),
      });
```

`defaultSchedule` is already imported in this file (`import { tickScheduler, readSchedulerState } from '../intelligence/scheduler.js';` — add `defaultSchedule` to that import list). `config` is already in scope in this function (used earlier for `config.vaultPath`).

- [ ] **Step 5: Run the scheduler tests to confirm they pass**

```bash
pnpm exec vitest run test/intelligence/scheduler.test.ts --reporter=verbose
```

- [ ] **Step 6: Add log.md entries to the review detectors — write the failing tests first**

Create `test/jobs/handlers/detect-contradictions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { detectContradictionsHandler } from '../../../src/jobs/handlers/detect-contradictions.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(): Job {
  return {
    id: 'test-detect-contradictions',
    type: 'detect-contradictions',
    status: 'running',
    priority: 80,
    payload: {},
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('detect-contradictions handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) =>
        ({
          ...input,
          id: 'enq',
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: 0,
          priority: input.priority ?? 50,
          payload: input.payload ?? {},
          trigger: input.trigger ?? 'cascade',
        }) as Job,
      llm: {} as never,
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-contradictions-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs without error on an empty vault and logs a run entry', async () => {
    const ctx = makeCtx();
    await expect(detectContradictionsHandler.execute(makeJob(), ctx)).resolves.not.toThrow();

    const log = await vault.read('Curated/log.md').catch(() => vault.read('log.md'));
    expect(log).toContain('review:contradictions');
    expect(log).toContain('0 candidates flagged');
  });
});
```

Create `test/jobs/handlers/detect-duplicates.test.ts` (identical shape, swap in `detect-duplicates`):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { detectDuplicatesHandler } from '../../../src/jobs/handlers/detect-duplicates.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(): Job {
  return {
    id: 'test-detect-duplicates',
    type: 'detect-duplicates',
    status: 'running',
    priority: 80,
    payload: {},
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('detect-duplicates handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) =>
        ({
          ...input,
          id: 'enq',
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: 0,
          priority: input.priority ?? 50,
          payload: input.payload ?? {},
          trigger: input.trigger ?? 'cascade',
        }) as Job,
      llm: {} as never,
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-duplicates-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs without error on an empty vault and logs a run entry', async () => {
    const ctx = makeCtx();
    await expect(detectDuplicatesHandler.execute(makeJob(), ctx)).resolves.not.toThrow();

    const log = await vault.read('Curated/log.md').catch(() => vault.read('log.md'));
    expect(log).toContain('review:duplicates');
    expect(log).toContain('0 candidates flagged');
  });
});
```

- [ ] **Step 7: Run both new test files to confirm they fail**

```bash
pnpm exec vitest run test/jobs/handlers/detect-contradictions.test.ts test/jobs/handlers/detect-duplicates.test.ts --reporter=verbose
```

Expected: FAIL — `log.md` is never written today (neither handler logs anything).

- [ ] **Step 8: Add logging to both handlers**

Replace `src/jobs/handlers/detect-contradictions.ts` entirely:

```typescript
import type { JobHandler, Job, JobContext } from '../types.js';
import { detectContradictions, writeContradictionReview } from '../../review/contradiction-detector.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:detect-contradictions');

export const detectContradictionsHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const candidates = await detectContradictions(context.vault);

    for (const candidate of candidates) {
      await writeContradictionReview(context.vault, candidate);
    }

    await appendLogEntry(
      context.vault,
      { kind: 'review:contradictions', message: `${candidates.length} candidates flagged` },
      layoutFromConfig(context.config),
    );

    log.info('Contradiction detection complete', { found: candidates.length });
  },
};
```

Replace `src/jobs/handlers/detect-duplicates.ts` entirely:

```typescript
import type { JobHandler, Job, JobContext } from '../types.js';
import { detectDuplicates, writeDuplicateReview } from '../../review/duplicate-detector.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:detect-duplicates');

export const detectDuplicatesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const candidates = await detectDuplicates(context.vault);

    for (const candidate of candidates) {
      await writeDuplicateReview(context.vault, candidate);
    }

    await appendLogEntry(
      context.vault,
      { kind: 'review:duplicates', message: `${candidates.length} candidates flagged` },
      layoutFromConfig(context.config),
    );

    log.info('Duplicate detection complete', { found: candidates.length });
  },
};
```

- [ ] **Step 9: Run the new tests to confirm they pass**

```bash
pnpm exec vitest run test/jobs/handlers/detect-contradictions.test.ts test/jobs/handlers/detect-duplicates.test.ts --reporter=verbose
```

If the log-path assertion fails because the default layout's `vaultLog` path differs from what the test expects, check `layoutFromConfig`'s default (`DEFAULT_LAYOUT.vaultLog`) and adjust the test's read path to match — don't hardcode a guess.

- [ ] **Step 10: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 11: Commit**

```bash
git add src/intelligence/scheduler.ts src/bin/intel-command.ts src/jobs/handlers/detect-contradictions.ts src/jobs/handlers/detect-duplicates.ts test/intelligence/scheduler.test.ts test/jobs/handlers/detect-contradictions.test.ts test/jobs/handlers/detect-duplicates.test.ts
git commit -m "feat(scheduler): schedule review-detection and entity-dedup jobs behind reviewEnabled"
```

---

### Task 6: Manual end-to-end verification

Not automated — a final sanity check that the whole activated pipeline actually behaves as designed against a throwaway copy of config, before calling this done.

- [ ] **Step 1: Build**

```bash
pnpm build
```

Expected: no errors.

- [ ] **Step 2: Run the full test suite one more time**

```bash
pnpm test
```

Expected: all pass (matching the pre-existing baseline — check `pnpm test` output before this plan started if you need a reference count).

- [ ] **Step 3: Confirm `reviewEnabled: true` actually schedules the 3 new jobs**

```bash
node -e "
const { defaultSchedule } = require('./dist/intelligence/scheduler.js');
console.log(defaultSchedule({ reviewEnabled: true }).map(j => j.type));
"
```

Expected output includes `detect-contradictions`, `detect-duplicates`, `detect-entity-dupes` alongside the 6 existing job types.

- [ ] **Step 4: Confirm the significance gate default actually changed**

```bash
node -e "
const { KarpathyConfigSchema } = require('./dist/config/schema.js');
const cfg = KarpathyConfigSchema.parse({ vaultPath: '/tmp/karpathy-verify' });
console.log(cfg.enrichment.significanceGate, cfg.enrichment.significanceGateDropConfidence);
"
```

Expected output: `llm 0.7`.

- [ ] **Step 5: Confirm no regression in the existing manual CLI paths**

```bash
# Should still work exactly as before, unaffected by this plan's scheduling changes:
node dist/bin/karpathy.js review detect --help 2>&1 | head -5
node dist/bin/karpathy.js merge --auto --help 2>&1 | head -5
```

Expected: both commands still exist and describe themselves normally (this plan didn't touch the CLI surface, only the scheduler and compiler internals — this step exists to catch an accidental import-path break).

- [ ] **Step 6: Confirm `pnpm lint` passes clean**

```bash
pnpm lint
```

Expected: no errors (strict `tsc --noEmit`).

If all six steps pass, this plan is complete. Sub-projects B (taxonomy & extraction redesign), C (draft/archival lifecycle), and D (research-queue redesign) are separate specs/plans, not part of this one.

# Taxonomy & Extraction Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate concepts into a glossary, recover the silently-dropped `action_items` extraction field into a tracked per-project/rollup checklist, tighten decision criteria and fix a real synthesis bug that's kept decision `context`/`outcome` regions permanently unmaintained, filter self-referential karpathy-development content out of entity extraction, and broaden tool/organization noise filtering.

**Architecture:** No new subsystems beyond two small maintenance modules. Concept glossary and action-items both follow the existing "read protected region → parse → mutate → serialize → `atomicWrite`" pattern already used by `research-queue.ts`; action-items additionally reuses `project-hub.ts`'s existing `createProjectSpec`/`updateProjectSpec` machinery rather than inventing new file-creation logic. All extraction/prompt fixes are surgical edits to existing functions. The one genuinely new capability — a concept migration script — includes a `--dry-run` mode, because the last plan's manual-verification step accidentally executed real mutating commands against the live production vault, and this plan's migration step is *inherently* about mutating that same live vault on purpose.

**Tech Stack:** TypeScript (ESM), Zod, Vitest, existing job-queue/vault-adapter system.

**Source of truth:** `docs/superpowers/specs/2026-07-24-taxonomy-extraction-redesign-design.md`. This plan supersedes a few of the spec's assumptions after reading the real source (documented inline below): `cwd-classifier.ts` uses `'_general'`/`'_discovery'` (underscore-prefixed), not `'general'`/`'discovery'`; action-items reuses `project-hub.ts`'s existing spec-file machinery instead of writing its own; the concept-glossary/action-items serialization format is plain markdown (checklists, headed sections) parsed with a line-based regex — matching `research-queue.ts`'s pattern, not `reconciliation-queue.ts`'s JSON-blob pattern, because these files need to be human-readable/editable directly in Obsidian.

## Global Constraints

- `pnpm build`, `pnpm test`, and `pnpm lint` (tsc --noEmit, strict) must all pass before every commit.
- ESM only — all relative imports use `.js` extensions, even for `.ts` source files.
- Protected regions use `OPEN_TAG`/`CLOSE_TAG` from `src/vault/protected-regions.js` — never hardcode marker strings.
- All vault filesystem access goes through `VaultAdapter` — never Node's `fs` directly.
- Use `layoutFromConfig(config)` for any vault path — never hardcode `wiki/`.
- **No task in this plan writes to the real production vault.** Every test uses a scratch `mkdtemp` directory via `createFsAdapter(dir)`, exactly like every existing test file in this repo. The one task that touches the real vault (Task 7) is manual, human-supervised, and gated on a dry-run review — see that task for the full protocol.
- Commit after each task, not each step within a task.

---

### Task 1: Extraction & synthesis prompt fixes (decisions, action items, organizations)

**Files:**
- Modify: `src/enrichment/entity-extractor-rich.ts`
- Modify: `src/enrichment/prompts.ts`
- Test: `test/enrichment/entity-extractor-rich.test.ts` (check if it exists; extend or create)
- Test: `test/compilation/entity-compiler.test.ts` (check if it exists; extend or create)

**Interfaces:**
- Produces: `RichExtractedEntitiesSchema` gains `actionItems: Array<{task: string; owner?: string; dueDate?: string; status: 'open'|'done'; confidence: number; chunkRefs: string[]}>`. `RichExtractedEntities` (the inferred type) gains the `actionItems` field — Task 3 and Task 5 consume this exact shape.
- Consumes: nothing from other tasks.

**Context:** Three separate, small fixes bundled because they all touch `prompts.ts` and are all "make extraction/synthesis say what it means" fixes:
1. The extraction prompt already asks the LLM for `"action_items": [{task, owner, due_date, status}]`, but the Zod schema has no field for it, so it's silently discarded. This step recovers it.
2. Add explicit decision-vs-action-item-vs-trivia criteria to the extraction prompt's `decisions` description.
3. Add product-vs-organization criteria to the extraction prompt's `organizations` description.
4. Fix `compileEntityPrompt`'s decision-specific section labels (`SUMMARY/PEOPLE/PROJECTS/TOPICS/SOURCES`) to match `entity-compiler.ts`'s actual `KIND_SECTIONS.decision = ['context', 'outcome', 'people', 'sources']` — today only `people`/`sources` ever get synthesized because none of the other labels match.

- [ ] **Step 1: Check for existing test files**

```bash
ls test/enrichment/entity-extractor-rich.test.ts test/compilation/entity-compiler.test.ts 2>&1
```

Note which exist — steps below assume neither exists (new files); if one does, extend it instead of creating a duplicate, following its existing style.

- [ ] **Step 2: Write the failing test for `action_items` recovery**

Create `test/enrichment/entity-extractor-rich.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractEntitiesRich } from '../../src/enrichment/entity-extractor-rich.js';
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

describe('extractEntitiesRich — action_items recovery', () => {
  it('preserves action_items from the raw LLM response instead of silently dropping them', async () => {
    const llm = makeLLM({
      people: [],
      projects: [],
      concepts: [],
      topics: [],
      decisions: [],
      tools: [],
      organizations: [],
      action_items: [
        { task: 'Investigate root cause of missing project enrichment', owner: 'tom', due_date: null, status: 'open', confidence: 0.8 },
      ],
      open_questions: [],
    });

    const result = await extractEntitiesRich(llm, 'Some text mentioning a to-do.');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.data.actionItems).toHaveLength(1);
    expect(result.data.actionItems[0].task).toBe('Investigate root cause of missing project enrichment');
    expect(result.data.actionItems[0].status).toBe('open');
  });

  it('defaults actionItems to an empty array when the LLM omits the field entirely', async () => {
    const llm = makeLLM({
      people: [], projects: [], concepts: [], topics: [], decisions: [], tools: [], organizations: [], open_questions: [],
    });
    const result = await extractEntitiesRich(llm, 'Text with nothing to extract.');
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.data.actionItems).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
pnpm exec vitest run test/enrichment/entity-extractor-rich.test.ts --reporter=verbose
```

Expected: FAIL — `result.data.actionItems` is `undefined` (the schema doesn't have this field yet, and the raw `action_items` key is silently stripped).

- [ ] **Step 4: Recover the schema field in `entity-extractor-rich.ts`**

Add to `RichExtractedEntitiesSchema` (after the `organizations` field, before `open_questions`):

```typescript
  actionItems: z.array(z.object({
    task: z.string(),
    owner: optStr,
    dueDate: optStr,
    status: z.enum(['open', 'done']).default('open'),
    confidence: z.number().min(0).max(1).default(0.5),
    chunkRefs: z.array(z.string()).default([]),
  })).default([]),
```

Update `EMPTY_ENTITIES` to add `actionItems: []`.

Update `tagChunkRefs` to add:
```typescript
    actionItems: entities.actionItems.map((a) => ({ ...a, chunkRefs: a.chunkRefs.length ? a.chunkRefs : [chunkId] })),
```

Update `mergeRichExtractedEntities` to add:
```typescript
    actionItems: mergeByKey(results.flatMap((r) => r.actionItems), 'task'),
```

Now handle the raw key rename. `llm.extractStructured` calls `schema.parse(parsed)` on the raw LLM JSON object directly (see `src/enrichment/llm-client.ts`) — the raw object has key `action_items`, but the schema field is `actionItems`. Since Zod strips unknown keys by default and doesn't rename them, add a pre-parse remap. In `extractEntitiesRich` and the per-chunk path in `extractEntitiesRichFromChunks`, the LLM call currently is:

```typescript
const data = await llm.extractStructured(extractEntitiesRichPrompt(text), RichExtractedEntitiesSchema);
```

Change `RichExtractedEntitiesSchema` itself to accept the snake_case key directly instead of remapping in each call site — add a `.transform()` is not right here (transforms run post-validation on the object's own declared shape, and the mismatch is a raw *key name*, not a value). Instead, give the schema a preprocessing step:

```typescript
const RichExtractedEntitiesSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && 'action_items' in raw && !('actionItems' in raw)) {
      const { action_items, ...rest } = raw as Record<string, unknown>;
      return { ...rest, actionItems: action_items };
    }
    return raw;
  },
  z.object({
    people: z.array(z.object({
      name: z.string(),
      role: optStr,
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    projects: z.array(z.object({
      name: z.string(),
      status: optStr,
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    concepts: z.array(z.object({
      name: z.string(),
      definition: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    topics: z.array(z.object({
      name: z.string(),
      definition: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    decisions: z.array(z.object({
      title: z.string(),
      status: optStr,
      date: optStr,
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    tools: z.array(z.object({
      name: z.string(),
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    organizations: z.array(z.object({
      name: z.string(),
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    actionItems: z.array(z.object({
      task: z.string(),
      owner: optStr,
      dueDate: optStr,
      status: z.enum(['open', 'done']).default('open'),
      confidence: z.number().min(0).max(1).default(0.5),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
    open_questions: z.array(z.object({
      question: z.string(),
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
  }),
);
```

Every field above except `actionItems` is byte-identical to the schema's current content (§ reference: `src/enrichment/entity-extractor-rich.ts:19-79` as read during planning) — only the wrapping `z.preprocess(...)` and the new `actionItems` field are additions. Also update `EMPTY_ENTITIES`, `tagChunkRefs`, and `mergeRichExtractedEntities` per the bullet points below (unchanged for every field except the three explicit `actionItems` additions).

`z.preprocess`'s first argument runs before validation on the raw unknown input, so it can safely rename a key regardless of the object's shape. This applies to every call site automatically (both `extractEntitiesRich` and the chunked path in `extractEntitiesRichFromChunks`) since they all pass through this one schema — no per-call-site changes needed beyond the schema definition itself. `RichExtractedEntities` (`z.output<typeof RichExtractedEntitiesSchema>`) is unaffected by wrapping in `z.preprocess` — the output type still matches the inner `z.object(...)`'s shape.

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/enrichment/entity-extractor-rich.test.ts --reporter=verbose
```

- [ ] **Step 6: Add decision/organization criteria to the extraction prompts**

In `src/enrichment/prompts.ts`, both `extractEntitiesRichPrompt` and `extractEntitiesRichChunkPrompt` have this identical line:

```
- "decisions": [{title, status, date, context, confidence, relationships: [{target, targetKind, relationship}]}]
```

Replace it (in **both** functions) with:

```
- "decisions": [{title, status, date, context, confidence, relationships: [{target, targetKind, relationship}]}] — a decision is a choice that was actually committed to, not a stated preference, an observed fact, or a task still to be done. If the text describes a task someone needs to do, extract it under "action_items" instead. If it's just background/context/preference with no choice being made, don't extract it as either.
```

And this identical line (in **both** functions):

```
- "organizations": [{name, context, confidence, relationships: [{target, targetKind, relationship}]}]
```

Replace it with:

```
- "organizations": [{name, context, confidence, relationships: [{target, targetKind, relationship}]}] — only genuine organizations (companies, teams, departments), not products, services, or subscription tiers (e.g. "Workfront" is a product, not an organization; skip it or extract its parent company instead).
```

- [ ] **Step 7: Write the failing test for the decision-synthesis label fix**

Create `test/compilation/entity-compiler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote, serializeNote } from '../../src/vault/frontmatter.js';
import { compileEntityPage } from '../../src/compilation/entity-compiler.js';
import type { CompilableEntity } from '../../src/compilation/compiler.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function makeLLM(response: string): LLMClient {
  return {
    async complete() {
      return response;
    },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

describe('compileEntityPage — decision section labels', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-entity-compiler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/decisions');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes CONTEXT and OUTCOME sections into the context/outcome protected regions', async () => {
    const path = 'wiki/decisions/some-decision.md';
    await vault.create(
      path,
      serializeNote(
        {
          id: 'd1', type: 'decision', title: 'Some Decision', decision_status: 'proposed',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
          source_refs: [], aliases: [], links: [],
          protected_regions: ['context', 'outcome', 'people', 'sources'],
        },
        `
# Some Decision

## Context
%% begin:context %%
Pending enrichment.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%

## Key People
%% begin:people %%
%% end:people %%

## Source References
%% begin:sources %%
%% end:sources %%
`,
      ),
    );

    const llmResponse = `CONTEXT:
We decided to use Bedrock because it integrates with existing AWS infra.

OUTCOME:
Deployed successfully in Q2.

PEOPLE:
(none)

SOURCES:
- source1.md`;

    const entity: CompilableEntity = {
      name: 'Some Decision',
      kind: 'decision',
      context: 'We decided to use Bedrock.',
      relationships: [],
      chunkRefs: [],
    };

    await compileEntityPage(entity, path, 'sources/source1.md', { vault, llm: makeLLM(llmResponse) });

    const { body } = parseNote(await vault.read(path));
    expect(body).toContain('We decided to use Bedrock because it integrates with existing AWS infra.');
    expect(body).toContain('Deployed successfully in Q2.');
  });
});
```

- [ ] **Step 8: Run the test to confirm it fails**

```bash
pnpm exec vitest run test/compilation/entity-compiler.test.ts --reporter=verbose
```

Expected: FAIL — the compiled body still contains "Pending enrichment." in the context region and nothing in outcome, since `SUMMARY:`/`PROJECTS:`/`TOPICS:` (the current decision labels) never match `context`/`outcome`.

- [ ] **Step 9: Fix the decision section labels in `compileEntityPrompt`**

In `src/enrichment/prompts.ts`, replace the `case 'decision':` branch of `compileEntityPrompt`'s `sectionInstructions` switch:

```typescript
    case 'decision':
      sectionInstructions = `Output the following sections in exactly this format:

CONTEXT:
(The situation and reasoning that led to this decision, synthesized from all sources so far)

OUTCOME:
(What actually happened as a result, if known. Write "(pending)" if the outcome isn't yet known.)

PEOPLE:
(Bulleted list of people involved as [[wikilinks]] with their role)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
```

- [ ] **Step 10: Run the test to confirm it passes**

```bash
pnpm exec vitest run test/compilation/entity-compiler.test.ts --reporter=verbose
```

- [ ] **Step 11: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 12: Commit**

```bash
git add src/enrichment/entity-extractor-rich.ts src/enrichment/prompts.ts test/enrichment/entity-extractor-rich.test.ts test/compilation/entity-compiler.test.ts
git commit -m "fix(extraction): recover action_items field; tighten decision/org criteria; fix decision section-label mismatch"
```

---

### Task 2: Concept glossary module and routing

**Files:**
- Create: `src/maintenance/concept-glossary.ts`
- Modify: `src/jobs/handlers/compile-entities.ts`
- Modify: `src/compilation/entity-compiler.ts`
- Test: `test/maintenance/concept-glossary.test.ts`
- Test: `test/jobs/handlers/compile-entities.test.ts` (check if exists; extend or create)

**Interfaces:**
- Consumes: `RichExtractedEntities.concepts` (unchanged shape from Task 1 — `actionItems` doesn't affect this).
- Produces: `upsertConceptMention(vault: VaultAdapter, layout: VaultLayout, concept: {name: string; gloss: string; sourceRef: string}): Promise<void>` — Task 6 (migration script) also calls this.

**Context:** Concepts stop being individual pages. `Curated/wiki/concepts/glossary.md` becomes the one file holding every concept, as sections with mentions. Deliberately not `_index.md` (the auto-generated category index) to avoid any collision with `rebuildVaultIndex()`.

- [ ] **Step 1: Write the failing tests**

Create `test/maintenance/concept-glossary.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';
import { upsertConceptMention } from '../../src/maintenance/concept-glossary.js';

describe('concept-glossary', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-glossary-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the glossary file on first mention', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency',
      gloss: 'A benchmark for evaluating audit findings.',
      sourceRef: 'wiki/topics/architectural-best-practices.md',
    });

    const path = 'wiki/concepts/glossary.md';
    expect(await vault.exists(path)).toBe(true);
    const content = await vault.read(path);
    expect(content).toContain('## Efficiency');
    expect(content).toContain('A benchmark for evaluating audit findings.');
    expect(content).toContain('[[architectural-best-practices]]');
  });

  it('appends a second mention of the same concept under the same heading', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'First gloss.', sourceRef: 'wiki/topics/a.md',
    });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'Second gloss.', sourceRef: 'wiki/topics/b.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    const headingCount = (content.match(/^## Efficiency$/gm) ?? []).length;
    expect(headingCount).toBe(1);
    expect(content).toContain('First gloss.');
    expect(content).toContain('Second gloss.');
  });

  it('is idempotent on the same (name, sourceRef) pair', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'First gloss.', sourceRef: 'wiki/topics/a.md',
    });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'First gloss (reworded).', sourceRef: 'wiki/topics/a.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    const mentionLines = content.split('\n').filter((l) => l.includes('[[a]]'));
    expect(mentionLines).toHaveLength(1);
  });

  it('normalizes concept name casing to avoid duplicate headings', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'From source A.', sourceRef: 'wiki/topics/a.md',
    });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'efficiency', gloss: 'From source B.', sourceRef: 'wiki/topics/b.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    const headingCount = (content.match(/^## Efficiency$/gim) ?? []).length;
    expect(headingCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm exec vitest run test/maintenance/concept-glossary.test.ts --reporter=verbose
```

Expected: FAIL — cannot find module `src/maintenance/concept-glossary.js`.

- [ ] **Step 3: Create `src/maintenance/concept-glossary.ts`**

```typescript
// Concept glossary at `{layout.wiki}/concepts/glossary.md`.
//
// Concepts no longer become individual wiki pages. Every concept mention
// across all ingested sources lands as a bulleted line under that concept's
// heading in this one file. Deliberately not `_index.md` — that file is
// auto-rebuilt by rebuildVaultIndex() and this glossary needs to survive
// that rebuild untouched.

import type { VaultAdapter } from '../vault/adapter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { normalizeName } from '../ingest/entity-resolver.js';

const REGION_ID = 'glossary-entries';

export function conceptGlossaryPath(layout: VaultLayout): string {
  return `${layout.wiki}/concepts/glossary.md`;
}

const HEADER = `---
type: index
title: Concept glossary
---

# Concept glossary

Every concept mentioned across ingested sources, consolidated here instead
of as individual pages. Each entry lists every source that mentioned it.

`;

export interface ConceptMention {
  sourceRef: string;
  gloss: string;
  date: string;
}

export interface ConceptEntry {
  name: string;
  mentions: ConceptMention[];
}

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function parseGlossary(inner: string): Map<string, ConceptEntry> {
  const entries = new Map<string, ConceptEntry>();
  const lines = inner.split('\n');
  let current: ConceptEntry | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^## (.+)$/);
    if (headingMatch) {
      current = { name: headingMatch[1].trim(), mentions: [] };
      entries.set(normalizeName(current.name), current);
      continue;
    }
    if (!current) continue;
    // Match: - "gloss text" — [[slug]] (YYYY-MM-DD)
    const mentionMatch = line.match(/^- "(.*)" — \[\[(.+?)\]\] \((.+?)\)$/);
    if (mentionMatch) {
      current.mentions.push({ gloss: mentionMatch[1], sourceRef: mentionMatch[2], date: mentionMatch[3] });
    }
  }

  return entries;
}

function renderGlossary(entries: Map<string, ConceptEntry>): string {
  const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return sorted
    .map((entry) => {
      const lastMention = entry.mentions[entry.mentions.length - 1];
      const mentionLines = entry.mentions
        .map((m) => `- "${m.gloss}" — [[${m.sourceRef}]] (${m.date})`)
        .join('\n');
      return `## ${entry.name}\n*Last mentioned: ${lastMention?.date ?? 'unknown'}*\n${mentionLines}`;
    })
    .join('\n\n');
}

export async function upsertConceptMention(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
  concept: { name: string; gloss: string; sourceRef: string },
): Promise<void> {
  const path = conceptGlossaryPath(layout);
  await vault.ensureFolder(`${layout.wiki}/concepts`);

  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);

  let inner = '';
  if (await vault.exists(path)) {
    const content = await vault.read(path);
    const openIdx = content.indexOf(open);
    const closeIdx = openIdx >= 0 ? content.indexOf(close, openIdx + open.length) : -1;
    if (openIdx >= 0 && closeIdx >= 0) {
      inner = content.slice(openIdx + open.length, closeIdx);
    }
  }

  const entries = parseGlossary(inner);
  const key = normalizeName(concept.name);
  const sourceRefSlug = extractSlug(concept.sourceRef);
  const today = new Date().toISOString().slice(0, 10);

  const existing = entries.get(key);
  const alreadyMentioned = existing?.mentions.some((m) => m.sourceRef === sourceRefSlug) ?? false;
  if (alreadyMentioned) return;

  if (existing) {
    existing.mentions.push({ gloss: concept.gloss, sourceRef: sourceRefSlug, date: today });
  } else {
    entries.set(key, {
      name: concept.name,
      mentions: [{ gloss: concept.gloss, sourceRef: sourceRefSlug, date: today }],
    });
  }

  const body = `${HEADER}${open}\n${renderGlossary(entries)}\n${close}\n`;
  await vault.atomicWrite(path, body);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/maintenance/concept-glossary.test.ts --reporter=verbose
```

- [ ] **Step 5: Route concepts to the glossary in `compile-entities.ts`**

In `src/jobs/handlers/compile-entities.ts`, add the import:

```typescript
import { upsertConceptMention } from '../../maintenance/concept-glossary.js';
import { layoutFromConfig } from '../../vault/paths.js';
```

Replace the existing concept loop:

```typescript
    for (const concept of (entities.concepts ?? [])) {
      if (!shouldInclude(concept.name, 'concept', concept.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: concept.name,
        kind: 'concept' as EntityKind,
        context: '',
        definition: concept.definition,
        relationships: concept.relationships ?? [],
        chunkRefs: concept.chunkRefs ?? [],
      });
    }
```

with:

```typescript
    const layout = layoutFromConfig(context.config);
    for (const concept of (entities.concepts ?? [])) {
      if (!shouldInclude(concept.name, 'concept', concept.confidence)) { filteredOut++; continue; }
      await upsertConceptMention(context.vault, layout, {
        name: concept.name,
        gloss: concept.definition ?? '',
        sourceRef: sourceSummaryPath,
      });
    }
```

(Concepts no longer flow into `compilable` at all — they never reach `compileFromSource`/`compiler.ts`, which is left otherwise unchanged.)

- [ ] **Step 6: Remove the now-dead concept branch in `entity-compiler.ts`**

Since concepts never reach `compileEntityPage` anymore, the web-enrichment fallback's concept case is unreachable. In `src/compilation/entity-compiler.ts`, change:

```typescript
  if (
    (entity.kind === 'concept' || entity.kind === 'topic') &&
    isDefinitionThin(getProtectedRegion(updatedBody, 'definition'))
  ) {
```

to:

```typescript
  if (
    entity.kind === 'topic' &&
    isDefinitionThin(getProtectedRegion(updatedBody, 'definition'))
  ) {
```

Also remove `'concept'` from `KIND_SECTIONS` if nothing else references it — check first:

```bash
grep -rn "KIND_SECTIONS" src/ test/
```

If `KIND_SECTIONS.concept` is only read via `KIND_SECTIONS[entity.kind]` (which will simply never be indexed with `'concept'` again since no concept-kind `CompilableEntity` is ever constructed), it's safe to leave the object's `concept` key in place — removing it isn't required for correctness, and `EntityKind` (the type) still includes `'concept'` as a valid kind elsewhere (e.g. `entity-resolver.ts`, `entity-writer.ts`) since deleting it from that shared type would be a much larger, unrelated change. Leave `KIND_SECTIONS.concept` as dead-but-harmless.

- [ ] **Step 7: Check for an existing compile-entities handler test, run it**

```bash
ls test/jobs/handlers/compile-entities.test.ts 2>&1
pnpm exec vitest run test/jobs/handlers/compile-entities.test.ts --reporter=verbose 2>&1 || echo "no existing test file"
```

If a test file exists and asserts on concept page creation, update those assertions to instead check `wiki/concepts/glossary.md` content (following this task's own test patterns in Step 1). If no file exists, skip — Task 3's routing is covered by Step 1's unit tests on `concept-glossary.ts` directly plus this task's manual reasoning; a full handler-level integration test isn't required since `compile-entities.ts`'s existing test coverage (if any) already exercises the surrounding loop structure.

- [ ] **Step 8: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 9: Commit**

```bash
git add src/maintenance/concept-glossary.ts src/jobs/handlers/compile-entities.ts src/compilation/entity-compiler.ts test/maintenance/concept-glossary.test.ts
git commit -m "feat(concepts): consolidate concept extraction into a single glossary file"
```

---

### Task 3: Action items module and routing

**Files:**
- Create: `src/maintenance/action-items.ts`
- Modify: `src/jobs/handlers/compile-entities.ts`
- Test: `test/maintenance/action-items.test.ts`

**Interfaces:**
- Consumes: `RichExtractedEntities.actionItems` from Task 1; `getOrCreateProjectHub`, `createProjectSpec`, `updateProjectSpec` from `src/compilation/project-hub.ts` (existing, unchanged); `upsertConceptMention`'s sibling pattern from Task 2 (parse/render/atomicWrite) — not a shared function, just the same idiom.
- Produces: `upsertActionItem(vault: VaultAdapter, layout: VaultLayout, item: {task: string; owner?: string; dueDate?: string; sourceRef: string; projectSlug: string}): Promise<void>`.

**Context:** Reuses `project-hub.ts`'s existing spec-file machinery (`decisions.md`/`product.md` are already just "project specs" with different `specType` values via `createProjectSpec`) instead of writing new file-creation logic — this task only needs its own checklist parse/render logic, then calls the existing `createProjectSpec`/`updateProjectSpec` functions to do the actual read/write. `'_general'`/`'_discovery'` (underscore-prefixed, per `cwd-classifier.ts`) route to the rollup only, skipping the per-project file.

- [ ] **Step 1: Write the failing tests**

Create `test/maintenance/action-items.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';
import { upsertActionItem } from '../../src/maintenance/action-items.js';

describe('action-items', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-action-items-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a per-project action-items.md and the rollup on first item', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Investigate root cause', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });

    const projectPath = 'wiki/projects/2nd-brain/action-items.md';
    const rollupPath = 'wiki/_system/action-items.md';
    expect(await vault.exists(projectPath)).toBe(true);
    expect(await vault.exists(rollupPath)).toBe(true);

    const projectContent = await vault.read(projectPath);
    expect(projectContent).toContain('- [ ] Investigate root cause');
    expect(projectContent).toContain('[[s1]]');

    const rollupContent = await vault.read(rollupPath);
    expect(rollupContent).toContain('- [ ] Investigate root cause');
    expect(rollupContent).toContain('(2nd-brain)');
  });

  it('routes _general and _discovery project slugs to the rollup only', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Some ad-hoc task', sourceRef: 'sources/s2.md', projectSlug: '_general',
    });

    expect(await vault.exists('wiki/projects/_general/action-items.md')).toBe(false);
    const rollupContent = await vault.read('wiki/_system/action-items.md');
    expect(rollupContent).toContain('Some ad-hoc task');
  });

  it('preserves a hand-toggled [x] checkbox across a re-run that adds a new item', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'First task', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });

    // Simulate Tom checking the box in Obsidian.
    const projectPath = 'wiki/projects/2nd-brain/action-items.md';
    const content = await vault.read(projectPath);
    await vault.write(projectPath, content.replace('- [ ] First task', '- [x] First task'));

    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Second task', sourceRef: 'sources/s2.md', projectSlug: '2nd-brain',
    });

    const updated = await vault.read(projectPath);
    expect(updated).toContain('- [x] First task');
    expect(updated).toContain('- [ ] Second task');
  });

  it('is idempotent on the same (task, sourceRef) pair', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Repeat task', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Repeat task', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });

    const content = await vault.read('wiki/projects/2nd-brain/action-items.md');
    const matches = content.split('\n').filter((l) => l.includes('Repeat task'));
    expect(matches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm exec vitest run test/maintenance/action-items.test.ts --reporter=verbose
```

Expected: FAIL — cannot find module `src/maintenance/action-items.js`.

- [ ] **Step 3: Create `src/maintenance/action-items.ts`**

Note before writing this: `createProjectSpec`/`updateProjectSpec` (`src/compilation/project-hub.ts`) always read/write a region hardcoded to the literal name `'content'` — not configurable per caller. The per-project `action-items.md` file (created via `createProjectSpec`) must therefore be parsed/rendered against the `'content'` region specifically. The rollup file, by contrast, is entirely custom-authored by this module, so it uses its own region name. `owner`/`dueDate` are captured by Task 1's schema but intentionally not yet rendered in the checklist line in this pass — scoped out to keep the line-format regex simple; adding them later doesn't require a schema change, just a render/parse update.

```typescript
// Action items, recovered from the extraction pipeline's action_items field.
// Tracked as a markdown checklist, not individual pages: per-project at
// `{layout.wiki}/projects/{slug}/action-items.md` (reusing the existing
// project-spec mechanism in project-hub.ts, which always targets a region
// literally named 'content') plus a vault-wide rollup at
// `{layout.system}/action-items.md` (this module's own 'action-item-entries'
// region). '_general'/'_discovery' project slugs (cwd-classifier.ts's
// non-project buckets) skip the per-project file.

import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { getProtectedRegion, updateProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { nowISO } from '../shared/date-utils.js';
import { getOrCreateProjectHub, createProjectSpec, updateProjectSpec } from '../compilation/project-hub.js';

const ROLLUP_REGION_ID = 'action-item-entries';
const NON_PROJECT_SLUGS = new Set(['_general', '_discovery']);

export interface ActionItem {
  id: string;
  task: string;
  sourceRef: string;
  projectSlug?: string; // present only on rollup entries
  status: 'open' | 'done';
}

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

// Render order is: checkbox, task, optional "(projectSlug)", then the
// source/id suffix — the parse regex below must mirror this exact order.
const ITEM_RE = /^- \[( |x)\] (.+?)(?: \((.+?)\))? — from \[\[(.+?)\]\] `id:([a-zA-Z0-9_-]+)`$/;

function parseChecklist(inner: string): ActionItem[] {
  const items: ActionItem[] = [];
  for (const line of inner.split('\n')) {
    const m = line.match(ITEM_RE);
    if (!m) continue;
    items.push({
      status: m[1] === 'x' ? 'done' : 'open',
      task: m[2],
      projectSlug: m[3] || undefined,
      sourceRef: m[4],
      id: m[5],
    });
  }
  return items;
}

function renderChecklist(items: ActionItem[], includeProject: boolean): string {
  return items
    .map((item) => {
      const box = item.status === 'done' ? 'x' : ' ';
      const projectPart = includeProject && item.projectSlug ? ` (${item.projectSlug})` : '';
      return `- [${box}] ${item.task}${projectPart} — from [[${extractSlug(item.sourceRef)}]] \`id:${item.id}\``;
    })
    .join('\n');
}

function mergeNewItem(existing: ActionItem[], task: string, sourceRef: string, projectSlug?: string): ActionItem[] {
  const alreadyPresent = existing.some((i) => i.task === task && i.sourceRef === sourceRef && i.projectSlug === projectSlug);
  if (alreadyPresent) return existing;
  return [...existing, { id: nanoid(8), task, sourceRef, projectSlug, status: 'open' }];
}

export async function upsertActionItem(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
  item: { task: string; sourceRef: string; projectSlug: string },
): Promise<void> {
  // --- Rollup: fully custom file/region, always updated. ---
  const rollupPath = `${layout.system}/action-items.md`;
  const open = OPEN_TAG(ROLLUP_REGION_ID);
  const close = CLOSE_TAG(ROLLUP_REGION_ID);

  const rollupExists = await vault.exists(rollupPath);
  let rollupInner = '';
  if (rollupExists) {
    rollupInner = getProtectedRegion(await vault.read(rollupPath), ROLLUP_REGION_ID) ?? '';
  } else {
    await vault.ensureFolder(layout.system);
  }
  const rollupRendered = renderChecklist(
    mergeNewItem(parseChecklist(rollupInner), item.task, item.sourceRef, item.projectSlug),
    true,
  );

  if (rollupExists) {
    const content = await vault.read(rollupPath);
    const { data, body } = parseNote(content);
    const updatedBody = updateProtectedRegion(body, ROLLUP_REGION_ID, rollupRendered);
    await vault.atomicWrite(rollupPath, serializeNote({ ...data, updated_at: nowISO() }, updatedBody));
  } else {
    const now = nowISO();
    const frontmatter = { id: nanoid(), type: 'index', title: 'Action items', created_at: now, updated_at: now, protected_regions: [ROLLUP_REGION_ID] };
    const body = `\n# Action items\n\nEvery open action item across all projects.\n\n## Items\n${open}\n${rollupRendered}\n${close}\n`;
    await vault.atomicWrite(rollupPath, serializeNote(frontmatter, body));
  }

  if (NON_PROJECT_SLUGS.has(item.projectSlug)) return;

  // --- Per-project: reuses project-hub.ts's spec-file mechanism. ---
  await getOrCreateProjectHub(vault, item.projectSlug, item.projectSlug, item.sourceRef, layout);
  const specPath = `${layout.wiki}/projects/${item.projectSlug}/action-items.md`;

  if (!(await vault.exists(specPath))) {
    const rendered = renderChecklist(mergeNewItem([], item.task, item.sourceRef), false);
    await createProjectSpec(vault, item.projectSlug, 'action-items', 'Action Items', rendered, item.sourceRef, layout);
    return;
  }

  const existingContent = getProtectedRegion(await vault.read(specPath), 'content') ?? '';
  const mergedItems = mergeNewItem(parseChecklist(existingContent), item.task, item.sourceRef);
  await updateProjectSpec(vault, specPath, renderChecklist(mergedItems, false), false, item.sourceRef);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/maintenance/action-items.test.ts --reporter=verbose
```

- [ ] **Step 5: Route action items in `compile-entities.ts`**

Add import: `import { upsertActionItem } from '../../maintenance/action-items.js';`

Add a new loop (after the organizations loop, before the `log.info('Compiling entities', ...)` call):

```typescript
    // NOTE: Task 4 introduces a shared `projectSlug` read at the top of this
    // handler and will replace this temporary inline read with a reference
    // to that shared variable — this inline version exists so Task 3 builds
    // and passes its own tests standalone, without depending on Task 4 having
    // landed yet.
    const actionItemsProjectSlug = (parseNote(summaryContent).data.project_slug as string | undefined) ?? '_general';
    for (const item of (entities.actionItems ?? [])) {
      if (!shouldInclude(item.task, 'action_item', item.confidence)) { filteredOut++; continue; }
      await upsertActionItem(context.vault, layout, {
        task: item.task,
        sourceRef: sourceSummaryPath,
        projectSlug: actionItemsProjectSlug,
      });
    }
```

(`summaryContent` is the same summary-note content this handler already reads for the `data.links = ...` update a few lines above — reuse that read, don't add a third one. `owner`/`dueDate` aren't passed through — `upsertActionItem`'s signature intentionally doesn't render them yet, per Task 3's Step 3 scope note.)

- [ ] **Step 6: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add src/maintenance/action-items.ts src/jobs/handlers/compile-entities.ts test/maintenance/action-items.test.ts
git commit -m "feat(action-items): recover action_items into tracked per-project and rollup checklists"
```

---

### Task 4: Self-reference filtering

**Files:**
- Modify: `src/jobs/handlers/compile-entities.ts`
- Test: `test/jobs/handlers/compile-entities.test.ts` (extend, or create if it doesn't exist)

**Interfaces:**
- Consumes: `context.projectRoot` (existing `JobContext` field, already used since Sub-project A's Task 3); `slugify` from `src/vault/paths.js`.
- Produces: nothing new for other tasks — this is the last routing change to `compile-entities.ts` in this plan. Also finalizes the `projectSlug` variable Task 3's Step 5 referenced.

**Context:** Reads the source summary's `project_slug` before any entity work happens; if it matches the tool's own project (computed dynamically from `context.projectRoot`, no config needed), skips all entity/concept/decision/tool/organization/action-item creation but still marks the source as `linked` so it doesn't stay pending forever.

- [ ] **Step 1: Write the failing test**

Create (or extend) `test/jobs/handlers/compile-entities.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { compileEntitiesHandler } from '../../../src/jobs/handlers/compile-entities.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(summaryPath: string, entities: Record<string, unknown>): Job {
  return {
    id: 'test-compile-entities', type: 'compile-entities', status: 'running', priority: 50,
    targetPath: summaryPath, payload: { entities }, trigger: 'cascade',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('compile-entities handler — self-reference filtering', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(), config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-selfref-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips entity creation when project_slug matches the tool\'s own project root', async () => {
    // dir's basename is the "self" project slug for this test run.
    const { slugify } = await import('../../../src/vault/paths.js');
    const selfSlug = slugify(dir.split('/').pop()!);

    const summaryPath = 'sources/self-session.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        { id: 's1', type: 'source_summary', title: 'Self session', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: selfSlug },
        '\nBody.\n',
      ),
    );

    const ctx = makeCtx();
    await compileEntitiesHandler.execute(
      makeJob(summaryPath, { concepts: [{ name: 'Some Concept', definition: 'x', confidence: 0.9 }] }),
      ctx,
    );

    expect(await vault.exists('wiki/concepts/glossary.md')).toBe(false);
    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
  });

  it('does not skip entity creation for a different project_slug', async () => {
    const summaryPath = 'sources/other-session.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        { id: 's2', type: 'source_summary', title: 'Other session', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: 'some-other-project' },
        '\nBody.\n',
      ),
    );

    const ctx = makeCtx();
    await compileEntitiesHandler.execute(
      makeJob(summaryPath, { concepts: [{ name: 'Some Concept', definition: 'x', confidence: 0.9 }] }),
      ctx,
    );

    expect(await vault.exists('wiki/concepts/glossary.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to confirm the first one fails**

```bash
pnpm exec vitest run test/jobs/handlers/compile-entities.test.ts --reporter=verbose
```

Expected: the self-referential test FAILs (glossary gets created because there's no filter yet); the other-project test already passes.

- [ ] **Step 3: Add the self-reference check to `compile-entities.ts`**

Add imports: `import { slugify } from '../../vault/paths.js';` and `import { basename } from 'node:path';`

At the very top of the handler's `execute` function, before the `entitiesPayload` check, read the source summary once and compute the self-check:

```typescript
    const summaryContentEarly = await context.vault.read(sourceSummaryPath);
    const { data: summaryDataEarly } = parseNote(summaryContentEarly);
    const projectSlug = (summaryDataEarly.project_slug as string | undefined) ?? '_general';
    const selfSlug = slugify(basename(context.projectRoot));

    if (projectSlug === selfSlug) {
      log.debug('Skipping entity creation for self-referential source', { sourceSummaryPath, projectSlug });
      const updated = { ...summaryDataEarly, ingest_status: 'linked', updated_at: nowISO() };
      await context.vault.atomicWrite(sourceSummaryPath, serializeNote(updated, parseNote(summaryContentEarly).body));
      return;
    }
```

Then, further down where the handler currently does a second `parseNote(await context.vault.read(sourceSummaryPath))` read (Step 3 of the original handler body, around the `data.links = ...` block), reuse `summaryDataEarly`/`summaryContentEarly` instead of re-reading — replace:

```typescript
    const summaryContent = await context.vault.read(sourceSummaryPath);
    const { data, body } = parseNote(summaryContent);
```

with:

```typescript
    const { data, body } = parseNote(summaryContentEarly);
```

(The content on disk hasn't changed between the early read and this point — nothing else in the handler writes to `sourceSummaryPath` before this line — so re-reading was always redundant; this task just makes that explicit by removing the duplicate read.)

Finally, in Task 3's action-items loop, remove the temporary `actionItemsProjectSlug` line entirely and change:

```typescript
        projectSlug: actionItemsProjectSlug,
```

to:

```typescript
        projectSlug,
```

(now referencing the `projectSlug` computed once at the top of the handler by this task's Step 3, instead of Task 3's temporary standalone read).

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/jobs/handlers/compile-entities.test.ts --reporter=verbose
```

- [ ] **Step 5: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add src/jobs/handlers/compile-entities.ts test/jobs/handlers/compile-entities.test.ts
git commit -m "feat(ingest): filter self-referential karpathy-development content from entity extraction"
```

---

### Task 5: Tool & organization noise filtering

**Files:**
- Modify: `src/enrichment/entity-filter.ts`
- Test: `test/enrichment/entity-filter.test.ts` (check if exists; extend or create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks — `isNoiseEntity`'s signature is unchanged, only its internal blocklist grows.

- [ ] **Step 1: Check for an existing test file**

```bash
ls test/enrichment/entity-filter.test.ts 2>&1
```

- [ ] **Step 2: Write the failing tests**

Create (or extend) `test/enrichment/entity-filter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isNoiseEntity } from '../../src/enrichment/entity-filter.js';

describe('isNoiseEntity — broadened tool/state-file filtering', () => {
  it('filters Claude Code built-in tool names', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit']) {
      expect(isNoiseEntity(name, 'tool')).toBe(true);
    }
  });

  it('filters common system state-file names', () => {
    for (const name of ['config.json', 'job-queue.json', 'ingest-tracker.json', 'budget.json']) {
      expect(isNoiseEntity(name, 'tool')).toBe(true);
    }
  });

  it('filters any name ending in -json', () => {
    expect(isNoiseEntity('some-random-file-json', 'tool')).toBe(true);
  });

  it('still allows genuine tools through', () => {
    for (const name of ['AWS Bedrock', 'Slack', 'Obsidian', 'TypeScript']) {
      expect(isNoiseEntity(name, 'tool')).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
pnpm exec vitest run test/enrichment/entity-filter.test.ts --reporter=verbose
```

Expected: FAIL on the built-in-tool-names and state-file tests (current blocklist doesn't cover them).

- [ ] **Step 4: Broaden the blocklist in `entity-filter.ts`**

Add a new set and a pattern check:

```typescript
/** Claude Code's own built-in tool names — never legitimate wiki-worthy tools. */
const CLAUDE_CODE_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'webfetch', 'websearch',
  'todowrite', 'notebookedit', 'askuserquestion', 'exitplanmode',
]);

/** Known system state/config filenames that sometimes get extracted as "tools". */
const KNOWN_STATE_FILES = new Set([
  'config.json', 'job-queue.json', 'ingest-tracker.json', 'budget.json',
]);
```

In `isNoiseEntity`, after the existing `AGENT_TOOL_NAMES` check, add:

```typescript
  // Claude Code's own built-in tools
  if (CLAUDE_CODE_TOOL_NAMES.has(normalized)) {
    log.debug('Filtered noise entity (Claude Code built-in tool)', { name, kind });
    return true;
  }

  // System state/config files
  if (KNOWN_STATE_FILES.has(normalized) || normalized.endsWith('-json')) {
    log.debug('Filtered noise entity (system state file)', { name, kind });
    return true;
  }
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/enrichment/entity-filter.test.ts --reporter=verbose
```

- [ ] **Step 6: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add src/enrichment/entity-filter.ts test/enrichment/entity-filter.test.ts
git commit -m "feat(filter): broaden noise blocklist to catch Claude Code's own tools and state files"
```

---

### Task 6: Concept migration script

**Files:**
- Create: `src/jobs/handlers/migrate-concept-glossary.ts`
- Modify: `src/jobs/types.ts` (add `'migrate-concept-glossary'` to `JobType` enum)
- Modify: `src/jobs/handlers/index.ts` (register the new handler)
- Modify: `src/bin/karpathy.ts` (add a CLI command to enqueue/run it)
- Test: `test/jobs/handlers/migrate-concept-glossary.test.ts`

**Interfaces:**
- Consumes: `upsertConceptMention` from Task 2; `mergeEntities`'s wikilink-rewriting helper pattern from `src/compilation/entity-merger.ts` (read, not imported directly — this task writes its own simpler rewrite since it targets a heading anchor, not a bare slug).
- Produces: nothing consumed by other tasks — this is the last piece before the manual execution in Task 7.

**Context:** This task only writes and tests the migration logic against scratch vaults — per this plan's Global Constraints, it never touches the real vault. Task 7 is the separate, human-supervised step that actually runs it against production.

- [ ] **Step 1: Write the failing test**

Create `test/jobs/handlers/migrate-concept-glossary.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { migrateConceptGlossaryHandler } from '../../../src/jobs/handlers/migrate-concept-glossary.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(dryRun: boolean): Job {
  return {
    id: 'test-migrate', type: 'migrate-concept-glossary', status: 'running', priority: 50,
    payload: { dryRun }, trigger: 'cli',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('migrate-concept-glossary handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: {} as never, config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-migrate-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/concepts/efficiency.md',
      serializeNote(
        {
          id: 'c1', type: 'concept', title: 'Efficiency', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z',
          source_refs: ['wiki/topics/architectural-best-practices.md'], aliases: [], links: [],
          protected_regions: ['definition'],
        },
        '\n# Efficiency\n\n## Definition\n%% begin:definition %%\nBenchmark for evaluating audit findings.\n%% end:definition %%\n',
      ),
    );
    await vault.create(
      'wiki/decisions/some-decision.md',
      serializeNote(
        { id: 'd1', type: 'decision', title: 'Some Decision', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z', source_refs: [], aliases: [], links: [] },
        '\nSee [[efficiency]] for background.\n',
      ),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dry-run reports what would change without writing anything', async () => {
    const ctx = makeCtx();
    await migrateConceptGlossaryHandler.execute(makeJob(true), ctx);

    // Nothing should have changed on disk.
    expect(await vault.exists('wiki/concepts/efficiency.md')).toBe(true);
    expect(await vault.exists('wiki/concepts/glossary.md')).toBe(false);
    const decisionContent = await vault.read('wiki/decisions/some-decision.md');
    expect(decisionContent).toContain('[[efficiency]]');
  });

  it('real run migrates the page into the glossary, deletes it, and rewrites wikilinks', async () => {
    const ctx = makeCtx();
    await migrateConceptGlossaryHandler.execute(makeJob(false), ctx);

    expect(await vault.exists('wiki/concepts/efficiency.md')).toBe(false);
    const glossary = await vault.read('wiki/concepts/glossary.md');
    expect(glossary).toContain('## Efficiency');
    expect(glossary).toContain('Benchmark for evaluating audit findings.');

    const decisionContent = await vault.read('wiki/decisions/some-decision.md');
    expect(decisionContent).not.toContain('[[efficiency]]');
    expect(decisionContent).toContain('[[glossary#Efficiency]]');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm exec vitest run test/jobs/handlers/migrate-concept-glossary.test.ts --reporter=verbose
```

Expected: FAIL — cannot find module `src/jobs/handlers/migrate-concept-glossary.js`.

- [ ] **Step 3: Add the job type**

In `src/jobs/types.ts`, add `'migrate-concept-glossary',` to the `JobType` enum array (anywhere among the other maintenance-style job types is fine, e.g. near `'rebuild-vault-artifacts'`).

- [ ] **Step 4: Create `src/jobs/handlers/migrate-concept-glossary.ts`**

```typescript
// One-time migration: consolidates existing individual concept pages into
// the glossary (concept-glossary.ts) and deletes them, rewriting any
// wikilinks that pointed at them. Supports a dryRun flag to preview the
// change set without writing anything — see docs/superpowers/plans/
// 2026-07-24-taxonomy-extraction-redesign.md Task 7 for why this exists.
//
// migrateConceptsToGlossary is a plain function (not just a JobHandler) so
// the CLI command in karpathy.ts can call it directly with just
// {vault, config} — matching how mergeCommand() and similar one-off CLI
// commands in that file construct their dependencies, without needing to
// fake a full JobContext (llm/enqueue/etc., which this migration never uses).

import type { JobHandler, Job, JobContext } from '../types.js';
import type { VaultAdapter } from '../../vault/adapter.js';
import type { KarpathyConfig } from '../../config/schema.js';
import { parseNote } from '../../vault/frontmatter.js';
import { getProtectedRegion } from '../../vault/protected-regions.js';
import { layoutFromConfig, wikiContentFolders } from '../../vault/paths.js';
import { upsertConceptMention } from '../../maintenance/concept-glossary.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('migrate-concept-glossary');

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function migrateConceptsToGlossary(
  vault: VaultAdapter,
  config: KarpathyConfig,
  dryRun: boolean,
): Promise<void> {
  const layout = layoutFromConfig(config);
  const conceptsFolder = `${layout.wiki}/concepts`;

  const files = (await vault.listMarkdownFiles(conceptsFolder)).filter(
    (f) => !f.endsWith('_index.md') && !f.endsWith('glossary.md'),
  );

  log.info(dryRun ? 'DRY RUN: would migrate concept pages' : 'Migrating concept pages', { count: files.length });

  for (const path of files) {
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    const title = (data.title as string) ?? extractSlug(path);
    const definition = getProtectedRegion(body, 'definition') ?? '';
    const gloss = definition.trim() && definition.trim() !== 'Pending enrichment.' ? definition.trim() : '(no definition recorded)';
    const sourceRefs = (data.source_refs as string[]) ?? [path];
    const slug = extractSlug(path);

    if (dryRun) {
      log.info('DRY RUN: would upsert glossary entry and delete page', { title, path, sourceRefCount: sourceRefs.length });
      continue;
    }

    for (const ref of sourceRefs.length > 0 ? sourceRefs : [path]) {
      await upsertConceptMention(vault, layout, { name: title, gloss, sourceRef: ref });
    }

    let wikilinksRewritten = 0;
    for (const folder of wikiContentFolders(layout)) {
      let candidateFiles: string[];
      try {
        candidateFiles = await vault.listMarkdownFiles(folder);
      } catch {
        continue;
      }
      for (const candidatePath of candidateFiles) {
        if (candidatePath === path) continue;
        const candidateContent = await vault.read(candidatePath);
        const pattern = new RegExp(`\\[\\[${escapeRegex(slug)}(\\|[^\\]]+)?\\]\\]`, 'g');
        if (!pattern.test(candidateContent)) continue;
        const updated = candidateContent.replace(pattern, () => `[[glossary#${title}]]`);
        if (updated !== candidateContent) {
          await vault.atomicWrite(candidatePath, updated);
          wikilinksRewritten++;
        }
      }
    }

    await vault.delete(path);
    log.info('Migrated concept page', { title, path, wikilinksRewritten });
  }
}

export const migrateConceptGlossaryHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    await migrateConceptsToGlossary(context.vault, context.config, Boolean(job.payload.dryRun));
  },
};
```

- [ ] **Step 5: Register the handler**

In `src/jobs/handlers/index.ts`, add the import and registry entry following the existing pattern for every other handler in that file (e.g. next to `detectEntityDupesHandler`):

```typescript
import { migrateConceptGlossaryHandler } from './migrate-concept-glossary.js';
// ...
'migrate-concept-glossary': migrateConceptGlossaryHandler,
```

- [ ] **Step 6: Add a CLI command**

`src/bin/karpathy.ts` has an established pattern for simple one-off maintenance commands like this — `mergeCommand` (around line 969) constructs just `config`/`vault` directly (no job runner, no LLM client) since it doesn't need them:

```typescript
async function mergeCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  // ...
}
```

Add a new function immediately after `mergeCommand` (or any convenient existing command function), following that exact shape:

```typescript
async function migrateConceptsCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const dryRun = args.includes('--dry-run');

  await migrateConceptsToGlossary(vault, config, dryRun);

  process.stdout.write(
    dryRun
      ? 'Dry run complete — see logs above for what would change.\n'
      : 'Migration complete.\n',
  );
}
```

Add the import at the top of `karpathy.ts` alongside the other job-handler/maintenance imports:

```typescript
import { migrateConceptsToGlossary } from '../jobs/handlers/migrate-concept-glossary.js';
```

Wire it into the command dispatcher. Find `case 'merge':` (around line 1790) in the main `switch`/`if` dispatch block and add a sibling case immediately after it, matching the exact same call convention:

```typescript
    case 'migrate-concepts-to-glossary':
      await migrateConceptsCommand(args.slice(1));
      break;
```

If the file's dispatch block uses a different statement terminator than `break` for neighboring cases (check the `case 'merge':` block's own ending — it may `return` from an enclosing function instead), match whatever `case 'merge':` actually does rather than assuming `break`.

- [ ] **Step 7: Run the tests to confirm they pass**

```bash
pnpm exec vitest run test/jobs/handlers/migrate-concept-glossary.test.ts --reporter=verbose
```

- [ ] **Step 8: Run the full test suite**

```bash
pnpm test
```

- [ ] **Step 9: Commit**

```bash
git add src/jobs/handlers/migrate-concept-glossary.ts src/jobs/types.ts src/jobs/handlers/index.ts src/bin/karpathy.ts test/jobs/handlers/migrate-concept-glossary.test.ts
git commit -m "feat(migration): add concept-to-glossary migration job with dry-run support"
```

---

### Task 7: Manual migration execution (human-supervised)

**Not automated.** This is the one task in this plan that touches the real production vault. Follow this protocol exactly — it exists because a previous plan's "manual verification" step accidentally executed real mutating CLI commands against the live vault (see `docs/superpowers/plans/2026-07-24-quality-layer-activation.md`'s Task 6 incident note). This time the mutation is *intentional*, but the same care applies: never run a command against the real vault without first previewing it, and never assume a flag behaves safely without having verified it against a scratch copy first.

- [ ] **Step 1: Build**

```bash
pnpm build
```

- [ ] **Step 2: Run the dry-run against a REAL COPY of the vault, not the live one**

```bash
# Copy the real vault to a scratch location — never run against the live path directly, even in dry-run mode, until dry-run's own behavior has been sanity-checked once here.
cp -R "$(node -e "console.log(require('/Users/valletta/.karpathy/config.json').defaults.vaultPath)" 2>/dev/null || echo "/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes")" /tmp/karpathy-vault-migration-check
node dist/bin/karpathy.js migrate-concepts-to-glossary --dry-run --vault-path /tmp/karpathy-vault-migration-check
```

Read the full output. Confirm the count of concept pages it says it would migrate matches what you expect (compare against `vault_status`'s `concept` count). Confirm nothing under `/tmp/karpathy-vault-migration-check` actually changed:

```bash
diff -rq "/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes/Curated/wiki/concepts" /tmp/karpathy-vault-migration-check/Curated/wiki/concepts
```

Expected: no differences reported (dry-run wrote nothing).

- [ ] **Step 3: Run the REAL migration against the same scratch copy**

```bash
node dist/bin/karpathy.js migrate-concepts-to-glossary --vault-path /tmp/karpathy-vault-migration-check
```

Open `/tmp/karpathy-vault-migration-check/Curated/wiki/concepts/glossary.md` and read it. Confirm every concept you expect is present, with sensible-looking mentions and no obviously mangled text. Spot-check 2-3 files elsewhere in the scratch vault that used to link to a concept page — confirm their wikilinks now point at `glossary#ConceptName` and still render sensibly as prose.

- [ ] **Step 4: Only after Step 3 looks right — present the scratch-copy result to Tom and get explicit confirmation before touching the live vault**

Do not proceed to Step 5 without an explicit "yes, run it for real" from Tom, shown the specific counts and at least one example glossary entry from Step 3.

- [ ] **Step 5: Run the real migration against the live vault**

```bash
node dist/bin/karpathy.js migrate-concepts-to-glossary
```

- [ ] **Step 6: Verify the live result**

```bash
# Via the carpathi MCP tool, or CLI equivalent:
# vault_status should now show concept: 0 (or close to it, if any files were skipped)
```

Confirm `Curated/wiki/concepts/glossary.md` exists and looks sensible. Confirm a couple of previously-linking pages now point at `glossary#...`.

- [ ] **Step 7: Manual cleanup of the 2 known-bad organization entries**

```bash
# Read both first to confirm nothing valuable would be lost:
cat "/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes/Curated/wiki/organizations/workfront.md"
cat "/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes/Curated/wiki/organizations/claude-max-enterprise.md"
```

Present the content to Tom; based on his call, either delete both files or move+reclassify them as `tool` entries (matching `entity-writer.ts`'s tool frontmatter shape) rather than `organization`. Do not delete or move anything without his explicit go-ahead on each file, shown its actual content.

- [ ] **Step 8: Clean up the scratch copy**

```bash
rm -rf /tmp/karpathy-vault-migration-check
```

# What Still Needs Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the three "what still needs work" items from the retrieval-eval project's final report: (1) finish the layout-scope bug sweep so entity resolution works correctly in non-default-layout vaults (like the real production vault), (2) fix eval scripts silently requiring manual `.env` loading, (3) add a process gate so `eval:bakeoff` cannot present a clean composite verdict without a fresh, corresponding downstream answer-quality check.

**Architecture:** Three independent workstreams touching disjoint files. The layout-scope sweep threads an already-existing `layout: VaultLayout` parameter (on both `buildEntityIndex` and `resolveEntity`) through the remaining call sites that silently default it instead of sourcing it from the real `config.layout` — no new abstractions, just finishing a pattern already established in commit `9556bc5`. The `.env` fix extracts the loading logic already proven in `src/bin/karpathy.ts` into a new eval-scoped module. The bake-off gate adds a pure freshness-check function plus I/O wiring to `eval/score/build-bakeoff.ts`, following that file's existing separation between pure `buildBakeoff()` logic and its `main()` entry point.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, existing `VaultAdapter`/`fs-adapter` test convention (real temp dirs, no mocking).

## Global Constraints

- All relative imports use `.js` extensions (ESM convention already used throughout this codebase).
- Test convention for this codebase: real temp directories via `mkdtemp(join(tmpdir(), 'karpathy-<name>-'))` + `createFsAdapter`, real `KarpathyConfigSchema.parse({...})` configs — no mocking of `buildEntityIndex`/`resolveEntity`/vault I/O. Follow the exact pattern in `test/compilation/entity-merger.test.ts` (commit `9556bc5`) for every layout-scoped test in this plan.
- The layout-scope sweep's scope is **exactly** these fixes — do not touch other call sites beyond what's named in Tasks 1-6:
  - `src/intelligence/topic-refresh.ts` (buildEntityIndex only)
  - `src/jobs/handlers/link-concepts.ts` (buildEntityIndex + resolveEntity)
  - `src/agent/tools/resolve-entity.ts` (buildEntityIndex + resolveEntity)
  - `src/agent/tools/create-entity.ts` (buildEntityIndex + resolveEntity)
  - `src/bin/karpathy.ts`'s `mergeCommand` (resolveEntity only — buildEntityIndex there was already fixed in a prior round)
  - `src/maintenance/lint.ts` + `src/compilation/graph-builder.ts` (buildEntityIndex AND buildGraph both require a signature extension — see Task 5's scope-correction note)
  - `src/compilation/cross-linker.ts` (buildEntityIndex, requires a signature extension)
- `buildEntityIndex(vault, layout: VaultLayout = DEFAULT_LAYOUT)` and `resolveEntity(entity, index, layout: VaultLayout = DEFAULT_LAYOUT)` (both in `src/ingest/entity-resolver.ts`) already accept an optional `layout` parameter — every fix in this plan is "pass the real value instead of relying on the default", never a signature change to these two functions. **`src/ingest/entity-resolver.ts` itself is never modified by any task in this plan** — `resolveEntity`'s step 4 (`// 4. Cross-folder matches`) is a deliberately ungated fallback (matches by slug/name/alias in any folder, at confidence `0.85`), so omitting `layout` degrades match *confidence*, not match *status* — `buildEntityIndex` omitting `layout` is the severe failure mode (an empty/wrong-folder index has nothing to match against at all). If a task's test seems to require changing `resolveEntity`'s matching logic to pass, the test's assertion is wrong, not the production code — see Task 1's corrected test for the concrete example.
- Do not modify `src/bin/karpathy.ts`'s existing `.env`-loading block (lines 8-21) — the eval `.env` fix is a new, eval-scoped module, not a shared refactor of production CLI code.
- The composite-validation gate must never throw/crash the `eval:bakeoff` script — it warns loudly (`console.error`) and sets `process.exitCode = 1`, while still writing the `.json`/`.md` artifacts so they remain inspectable.

---

### Task 1: Foundational layout-scoped `resolveEntity` test + fix `topic-refresh.ts`

**Files:**
- Modify: `test/ingest/entity-resolver.test.ts`
- Modify: `src/intelligence/topic-refresh.ts:228`
- Modify: `test/intelligence/topic-refresh.test.ts`

**Interfaces:**
- Consumes: `buildEntityIndex(vault, layout?)` and `resolveEntity(entity, index, layout?)` from `src/ingest/entity-resolver.ts` (both already exist, no changes to their signatures).
- Produces: nothing new consumed by later tasks — this task establishes the test pattern (custom `VaultLayout` + `KarpathyConfigSchema.parse` + regression-style assertion) that Tasks 2-4 reuse.

- [ ] **Step 1: Write the failing foundational test proving `resolveEntity` needs `layout` for exact-match confidence**

**Correction found during execution of this task (documented here so the plan and the real code stay in sync):** `resolveEntity` has a 4th matching step — `// 4. Cross-folder matches` — that is a deliberately lenient fallback with **no folder gating at all**: it matches by slug/canonical-name/alias regardless of which folder the match lives in, at confidence `0.85` (vs. the exact-match `1.0` from steps 1-3). This means a caller that omits `layout` does **not** get `status: 'new'` for an entity that exists elsewhere in the index — it still gets `status: 'matched'`, just at the lower `0.85` confidence. Do NOT add a `matchedPath.startsWith(folder)` condition to step 4 to make an "should not match" test pass — that makes step 4 unreachable dead code (any match satisfying `startsWith(folder)` would already have returned at step 1-3), silently deleting the intentional cross-folder-fallback feature. If you find yourself tempted to change `src/ingest/entity-resolver.ts`'s matching logic to make this task's test pass, stop — the fix belongs in the test's assertions, not in production matching logic, which is unchanged by this task per the file list above.

Add this new `describe` block inside the existing `describe('resolveEntity', ...)` block in `test/ingest/entity-resolver.test.ts` (after the existing `it('matches by exact slug', ...)` test, before `it('matches by canonical name', ...)`):

```typescript
    it('matches with lower cross-folder confidence unless the real layout is passed through', async () => {
      // Same vault, but the entity lives under a custom `Curated/wiki` root,
      // not the DEFAULT_LAYOUT `wiki` root the beforeEach folders assume.
      await vault.ensureFolder('Curated/wiki/entities');
      await vault.create(
        'Curated/wiki/entities/jordan-ellis.md',
        serializeNote(
          {
            id: '1',
            type: 'entity',
            title: 'Jordan Ellis',
            canonical_name: 'Jordan Ellis',
            entity_kind: 'person',
            aliases: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          },
          '\n# Jordan Ellis\n\nContent.\n',
        ),
      );

      const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
      const index = await buildEntityIndex(vault, customLayout);

      // Without the real layout, steps 1-3's `startsWith(folder)` check fails
      // (folder computed from DEFAULT_LAYOUT is 'wiki/entities', but the file
      // is under 'Curated/wiki/entities'), so it falls through to step 4's
      // lenient cross-folder fallback: still matched, but at confidence 0.85.
      const withoutLayout = resolveEntity({ name: 'Jordan Ellis', kind: 'person' }, index);
      expect(withoutLayout.status).toBe('matched');
      expect(withoutLayout.confidence).toBe(0.85);

      const withLayout = resolveEntity({ name: 'Jordan Ellis', kind: 'person' }, index, customLayout);
      expect(withLayout.status).toBe('matched');
      expect(withLayout.matchedPath).toBe('Curated/wiki/entities/jordan-ellis.md');
      expect(withLayout.confidence).toBe(1.0);
    });
```

Add `DEFAULT_LAYOUT` and `type VaultLayout` to the existing import from `../../src/vault/paths.js` at the top of the file — change:

```typescript
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
```

to add a second import line right after it:

```typescript
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
```

- [ ] **Step 2: Run the test to verify it passes already (documents existing, correct behavior)**

Run: `npx vitest run test/ingest/entity-resolver.test.ts -t "matches with lower cross-folder confidence"`
Expected: PASS. This test doesn't fail — `resolveEntity`'s own layout-gating already works correctly when the caller passes `layout` explicitly, and its cross-folder fallback already works correctly when it isn't. It exists to document the exact mechanism (folder-prefix gating via `kindToFolder` for exact matches, deliberately ungated for the cross-folder fallback) that Tasks 2-4's real call-site fixes depend on — those fixes upgrade match *confidence and precision*, not match/no-match status — and to catch any future regression in `resolveEntity` itself.

- [ ] **Step 3: Fix `topic-refresh.ts`'s `buildEntityIndex` call**

In `src/intelligence/topic-refresh.ts`, line 228, change:

```typescript
        const index = await buildEntityIndex(deps.vault);
```

to:

```typescript
        const index = await buildEntityIndex(deps.vault, deps.config.layout);
```

(`deps.config` is already `KarpathyConfig` per the `RefreshDeps` interface at `src/intelligence/topic-refresh.ts:43-48` — no import changes needed. Note `topic-refresh.ts` resolves neighbor concepts via a direct `index.bySlug.get(slug)` lookup, not `resolveEntity()`, so this is the only fix needed in this file.)

- [ ] **Step 4: Write the failing layout-scoped test for `refreshTopic`'s cascade**

Add this new test to `test/intelligence/topic-refresh.test.ts`, right after the existing `it('Phase 1: clears pending_evidence and cascades depth-1 to linked neighbors', ...)` test (around line 223):

```typescript
  it('Phase 1: cascades to a neighbor resolved under a non-default vault layout', async () => {
    const customConfig = KarpathyConfigSchema.parse({
      vaultPath: '/tmp',
      layout: { wiki: 'Curated/wiki' },
    });
    const topicPath = 'Curated/wiki/topics/recency-aware-rag.md';
    await vault.ensureFolder('Curated/wiki/concepts');
    await vault.create(
      'Curated/wiki/concepts/cross-encoder.md',
      `---
id: c3
type: concept
title: Cross Encoder
status: active
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Cross Encoder
`,
    );
    await vault.create(
      topicPath,
      `---
id: t6
type: topic
title: Recency-aware RAG
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
pending_evidence:
  - ref: wiki/sources/2026-04-15.md
    at: 2026-04-15T00:00:00Z
pending_evidence_count: 1
---
# Recency-aware RAG
%% begin:current-understanding %%
Initial framing.
%% end:current-understanding %%
`,
    );
    await store.upsert([
      { doc_id: 'wiki/sources/2026-04-15.md', chunk_index: 0, chunk_hash: 'h1', text: 'cross encoder reranking helps' },
    ]);

    const llm = fakeLLM({
      current_understanding: 'Two-stage retrieval pairs a bi-encoder with a [[Cross Encoder]] reranker [1].',
      contradictions: [],
      new_sources: ['wiki/sources/2026-04-15.md'],
    });

    const result = await refreshTopic({ vault, llm, store, config: customConfig }, topicPath, {
      nowMs: Date.parse('2026-05-01T00:00:00Z'),
    });

    expect(result.neighborsCascaded).toBe(1);
    const { data: neighborFm } = await parseNote(await vault.read('Curated/wiki/concepts/cross-encoder.md'));
    expect(neighborFm.pending_evidence_count).toBe(1);
  });
```

Note: `KarpathyConfigSchema.parse({ vaultPath: '/tmp', layout: { wiki: 'Curated/wiki' } })` works because the schema fills in every other `layout` field (`aiConversations`, `sources`, etc.) with its own defaults via zod `.default(...)` — only `wiki` needs overriding for this test since `kindToFolder`/`buildEntityIndex` only read `layout.wiki`.

- [ ] **Step 5: Run the test to verify it fails without the Step 3 fix**

Temporarily revert Step 3's change (or run against the pre-fix state if not yet committed), then run:

Run: `npx vitest run test/intelligence/topic-refresh.test.ts -t "cascades to a neighbor resolved under a non-default vault layout"`
Expected: FAIL — `result.neighborsCascaded` is `0` because `buildEntityIndex(deps.vault)` defaults to `DEFAULT_LAYOUT` (folder `wiki/concepts`) and never finds `Curated/wiki/concepts/cross-encoder.md`.

- [ ] **Step 6: Re-apply Step 3's fix and verify the test passes**

Run: `npx vitest run test/intelligence/topic-refresh.test.ts`
Expected: PASS, full file (all pre-existing tests plus the new one).

- [ ] **Step 7: Commit**

```bash
git add test/ingest/entity-resolver.test.ts src/intelligence/topic-refresh.ts test/intelligence/topic-refresh.test.ts
git commit -m "fix(topic-refresh): thread real vault layout into neighbor-cascade entity index"
```

---

### Task 2: Fix `link-concepts.ts` (buildEntityIndex + resolveEntity)

**Files:**
- Modify: `src/jobs/handlers/link-concepts.ts:35,80`
- Create: `test/jobs/handlers/link-concepts.test.ts`

**Interfaces:**
- Consumes: `buildEntityIndex`, `resolveEntity` (unchanged signatures, per Task 1). `JobContext` type from `src/jobs/types.js` (has `config: KarpathyConfig`, confirmed at `src/jobs/types.ts:121`).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Fix both call sites**

In `src/jobs/handlers/link-concepts.ts`, line 35, change:

```typescript
    const index = await buildEntityIndex(context.vault);
```

to:

```typescript
    const index = await buildEntityIndex(context.vault, context.config.layout);
```

Line 80, change:

```typescript
      const resolution = resolveEntity({ name: entity.name, kind }, index);
```

to:

```typescript
      const resolution = resolveEntity({ name: entity.name, kind }, index, context.config.layout);
```

- [ ] **Step 2: Write the failing test**

Create `test/jobs/handlers/link-concepts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { linkConceptsHandler } from '../../../src/jobs/handlers/link-concepts.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(summaryPath: string, entities: Record<string, unknown>): Job {
  return {
    id: 'test-link-concepts',
    type: 'link-concepts',
    status: 'running',
    priority: 50,
    targetPath: summaryPath,
    payload: { entities },
    trigger: 'cascade',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('link-concepts handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      layout: { wiki: 'Curated/wiki' },
      enrichment: { significanceGate: 'off' },
    });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => {
        enqueued.push(input);
        return {
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
        } as Job;
      },
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-link-concepts-'));
    vault = createFsAdapter(dir);
    enqueued = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves an existing entity under a non-default layout instead of creating a duplicate', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      serializeNote(
        {
          id: 'e1',
          type: 'entity',
          title: 'Jordan Ellis',
          canonical_name: 'Jordan Ellis',
          entity_kind: 'person',
          aliases: [],
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
        '\n# Jordan Ellis\n\nContent.\n',
      ),
    );
    await vault.ensureFolder('Curated/wiki/sources');
    const summaryPath = 'Curated/wiki/sources/summary-001.md';
    await vault.create(
      summaryPath,
      serializeNote({ id: 's1', type: 'source', title: 'Summary', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }, '\nBody.\n'),
    );

    const ctx = makeCtx();
    await linkConceptsHandler.execute(
      makeJob(summaryPath, { people: [{ name: 'Jordan Ellis' }] }),
      ctx,
    );

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.links).toEqual(['Curated/wiki/entities/jordan-ellis.md']);

    // No duplicate entity file was created under any folder.
    const entityFiles = await vault.listMarkdownFiles('Curated/wiki/entities');
    expect(entityFiles).toEqual(['Curated/wiki/entities/jordan-ellis.md']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails without the Step 1 fix**

Temporarily revert Step 1's changes, then run:

Run: `npx vitest run test/jobs/handlers/link-concepts.test.ts`
Expected: FAIL — without the fix, `buildEntityIndex(context.vault)` defaults to `DEFAULT_LAYOUT` and never sees `Curated/wiki/entities/jordan-ellis.md`, so the entity resolves as `'new'` and `autoCreateEntities` (default `true`) creates a duplicate page under `wiki/entities/jordan-ellis.md` (the `DEFAULT_LAYOUT` folder, which the vault fixture never created — `createEntityPage` will create itfresh). `data.links` will point at that newly created duplicate path, not the pre-existing one, and `vault.listMarkdownFiles('Curated/wiki/entities')` will still show only the original file (the duplicate lands in `wiki/entities/`, a different folder), so the `links` assertion fails.

- [ ] **Step 4: Re-apply Step 1's fix and verify the test passes**

Run: `npx vitest run test/jobs/handlers/link-concepts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/handlers/link-concepts.ts test/jobs/handlers/link-concepts.test.ts
git commit -m "fix(link-concepts): thread real vault layout into entity index + resolution"
```

---

### Task 3: Fix `resolve-entity.ts` + `create-entity.ts` agent tools

**Files:**
- Modify: `src/agent/tools/resolve-entity.ts:28-29`
- Modify: `src/agent/tools/create-entity.ts:38-39`
- Create: `test/agent/tools/resolve-entity.test.ts`
- Create: `test/agent/tools/create-entity.test.ts`

**Interfaces:**
- Consumes: `AgentContext` from `src/agent/tool-registry.js` — `interface AgentContext extends JobContext { sourceFilePath: string; sourceContent: string; contentCategory: ContentCategory; projectSlug?: string; }` (confirmed at `src/agent/tool-registry.ts:20-25`). `JobContext.config: KarpathyConfig` is inherited, so `context.config.layout` is available in both tools without any type changes.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Fix `resolve-entity.ts`**

In `src/agent/tools/resolve-entity.ts`, line 28, change:

```typescript
    const index = await buildEntityIndex(context.vault);
    const result = resolveEntity({ name, kind }, index);
```

to:

```typescript
    const index = await buildEntityIndex(context.vault, context.config.layout);
    const result = resolveEntity({ name, kind }, index, context.config.layout);
```

- [ ] **Step 2: Fix `create-entity.ts`**

In `src/agent/tools/create-entity.ts`, line 38, change:

```typescript
    const index = await buildEntityIndex(context.vault);
    const resolution = resolveEntity({ name, kind }, index);
```

to:

```typescript
    const index = await buildEntityIndex(context.vault, context.config.layout);
    const resolution = resolveEntity({ name, kind }, index, context.config.layout);
```

- [ ] **Step 3: Write the failing test for `resolve-entity.ts`**

Create `test/agent/tools/resolve-entity.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { resolveEntityTool } from '../../../src/agent/tools/resolve-entity.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { AgentContext } from '../../../src/agent/tool-registry.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

describe('resolve_entity tool', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-resolve-entity-tool-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(): AgentContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, layout: { wiki: 'Curated/wiki' } });
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> { return schema.parse({}); },
    };
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => ({
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
      }),
      llm,
      config,
      sourceFilePath: 'Curated/wiki/sources/summary-001.md',
      sourceContent: '',
      contentCategory: 'document',
    };
  }

  it('finds an existing entity under a non-default vault layout', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      serializeNote(
        {
          id: 'e1',
          type: 'entity',
          title: 'Jordan Ellis',
          canonical_name: 'Jordan Ellis',
          entity_kind: 'person',
          aliases: [],
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
        '\n# Jordan Ellis\n\nContent.\n',
      ),
    );

    const result = await resolveEntityTool.execute({ name: 'Jordan Ellis', kind: 'person' }, makeContext());

    expect(result).toContain('Found:');
    expect(result).toContain('Curated/wiki/entities/jordan-ellis.md');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails without the Step 1 fix**

Temporarily revert Step 1's change, then run:

Run: `npx vitest run test/agent/tools/resolve-entity.test.ts`
Expected: FAIL — result contains `Not found.` because `buildEntityIndex(context.vault)` defaults to `DEFAULT_LAYOUT` and misses the entity under `Curated/wiki/entities/`.

- [ ] **Step 5: Re-apply Step 1's fix and verify it passes**

Run: `npx vitest run test/agent/tools/resolve-entity.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test for `create-entity.ts`**

Create `test/agent/tools/create-entity.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { createEntityTool } from '../../../src/agent/tools/create-entity.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { AgentContext } from '../../../src/agent/tool-registry.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

describe('create_entity tool', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-create-entity-tool-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(): AgentContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, layout: { wiki: 'Curated/wiki' } });
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> { return schema.parse({}); },
    };
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => ({
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
      }),
      llm,
      config,
      sourceFilePath: 'Curated/wiki/sources/summary-001.md',
      sourceContent: '',
      contentCategory: 'document',
    };
  }

  it('detects an existing entity under a non-default layout instead of creating a duplicate', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      serializeNote(
        {
          id: 'e1',
          type: 'entity',
          title: 'Jordan Ellis',
          canonical_name: 'Jordan Ellis',
          entity_kind: 'person',
          aliases: [],
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
        '\n# Jordan Ellis\n\nContent.\n',
      ),
    );

    const result = await createEntityTool.execute({ name: 'Jordan Ellis', kind: 'person' }, makeContext());

    expect(result).toContain('Entity already exists:');
    expect(result).toContain('Curated/wiki/entities/jordan-ellis.md');

    const entityFiles = await vault.listMarkdownFiles('Curated/wiki/entities');
    expect(entityFiles).toEqual(['Curated/wiki/entities/jordan-ellis.md']);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails without the Step 2 fix**

Temporarily revert Step 2's change, then run:

Run: `npx vitest run test/agent/tools/create-entity.test.ts`
Expected: FAIL — the tool doesn't detect the existing entity (index misses it under `DEFAULT_LAYOUT`), so it proceeds to create a duplicate under `wiki/entities/jordan-ellis.md`. The result string won't contain `'Entity already exists:'`, and `Curated/wiki/entities` will still list only the original file, but the tool's return value assertion will fail (`result` starts with `Created entity:` instead).

- [ ] **Step 8: Re-apply Step 2's fix and verify both tests pass**

Run: `npx vitest run test/agent/tools/resolve-entity.test.ts test/agent/tools/create-entity.test.ts`
Expected: PASS, both files.

- [ ] **Step 9: Commit**

```bash
git add src/agent/tools/resolve-entity.ts src/agent/tools/create-entity.ts test/agent/tools/resolve-entity.test.ts test/agent/tools/create-entity.test.ts
git commit -m "fix(agent-tools): thread real vault layout into resolve_entity + create_entity"
```

---

### Task 4: Complete `karpathy.ts`'s `mergeCommand` fix (resolveEntity calls)

**Files:**
- Modify: `src/bin/karpathy.ts:1031,1035`

**Interfaces:**
- Consumes: `resolveEntity(entity, index, layout?)` (unchanged signature). `config.layout` is already in scope in `mergeCommand` — it's used two lines above these call sites (`const index = await buildEntityIndex(vault, config.layout);`, confirmed at line 1022), which is itself the fix from a prior round (commit `9556bc5`) that only threaded layout into `buildEntityIndex` and missed these two `resolveEntity` calls.
- **Corrected severity (found during Task 1's execution):** `resolveEntity`'s steps 1-3 gate matches on `matchedPath.startsWith(folder)`, but step 4 (`// 4. Cross-folder matches`) is a deliberately lenient fallback with no folder gating at all — it matches by slug/canonical-name/alias regardless of folder, at confidence `0.85` instead of the exact-match `1.0`. Since `mergeCommand` only reads `.status` (never `.confidence` — confirmed via `grep -n "sr.status\|tr.status\|\.confidence" src/bin/karpathy.ts`), this means `mergeCommand` **already resolves entities correctly today**, just via the looser cross-folder path at lower confidence, not the "silently fails to find the entity" bug this task's earlier description assumed. The fix below is still worth doing — it makes the reported confidence accurate, and it correctly restricts the match to the *intended* layout+kind folder rather than any slug/name/alias collision across kinds (e.g. a `decision` and a `project` that happen to slugify identically would currently cross-match at 0.85 regardless of vault layout) — but it is a precision/correctness improvement, not a fix for a broken feature.

- [ ] **Step 1: Fix both call sites**

In `src/bin/karpathy.ts`, inside `mergeCommand`, change:

```typescript
    if (!sourcePath) {
      const sr = resolveEntity({ name: sourceName, kind }, index);
      if (sr.status === 'matched') sourcePath = sr.matchedPath!;
    }
    if (!targetPath) {
      const tr = resolveEntity({ name: targetName, kind }, index);
      if (tr.status === 'matched') targetPath = tr.matchedPath!;
    }
```

to:

```typescript
    if (!sourcePath) {
      const sr = resolveEntity({ name: sourceName, kind }, index, config.layout);
      if (sr.status === 'matched') sourcePath = sr.matchedPath!;
    }
    if (!targetPath) {
      const tr = resolveEntity({ name: targetName, kind }, index, config.layout);
      if (tr.status === 'matched') targetPath = tr.matchedPath!;
    }
```

- [ ] **Step 2: Verify the fix compiles and the existing suite still passes**

There is no existing test harness for `karpathy.ts`'s CLI commands (they are private, unexported functions with no current test coverage — confirmed by `find test -iname "*karpathy*"` returning nothing), so this fix is verified via typecheck + the full existing suite rather than a new CLI-level test. The underlying `resolveEntity` layout-gating behavior is already covered by Task 1's foundational test in `test/ingest/entity-resolver.test.ts`.

Run: `npm run eval:typecheck 2>/dev/null; npx tsc --noEmit`
Expected: no new type errors.

Run: `npm test`
Expected: all pre-existing tests still pass (this change only threads an already-optional parameter through — no behavior change for callers that were already relying on `DEFAULT_LAYOUT`, since `config.layout` for a vault genuinely using the default layout still resolves to the same value `DEFAULT_LAYOUT` would).

- [ ] **Step 3: Commit**

```bash
git add src/bin/karpathy.ts
git commit -m "fix(karpathy-cli): thread real vault layout into mergeCommand's resolveEntity calls

Commit 9556bc5 fixed buildEntityIndex's layout in mergeCommand but missed
the two resolveEntity calls a few lines below it. resolveEntity's cross-folder
fallback (step 4) already matches regardless of folder, so mergeCommand
wasn't silently failing — but passing the real layout makes the reported
confidence accurate (1.0 exact match vs 0.85 cross-folder fallback) and
correctly restricts matches to the intended layout+kind folder rather than
any slug/name/alias collision across kinds."
```

---

### Task 5: Extend `lintWiki` + `buildGraph` to accept a layout + fix the caller

**Scope correction found during grounding:** `lintWiki` builds two data structures in parallel — `buildGraph(vault)` and `buildEntityIndex(vault)`. The original plan for this task only covered the second. But `buildGraph` (in `src/compilation/graph-builder.ts`) scans a **hardcoded, non-layout-aware** `WIKI_FOLDERS` constant (`const WIKI_FOLDERS = WIKI_CONTENT_FOLDERS;`, line 33) — the exact same legacy-constant bug class that commit `9556bc5` already fixed in `entity-merger.ts` (which used to hardcode this same constant before being switched to the layout-aware `wikiContentFolders(layout)` helper). This means `lintWiki` on a non-default-layout vault doesn't just mis-resolve entities — it silently scans **zero pages** for orphan/broken-link/stale/thin-page detection too, since `graph.nodes` ends up empty. `buildGraph` has exactly one caller in `src/` (`lint.ts:78`), so fixing it here is a contained, same-file fix, not scope creep into unrelated code.

**Files:**
- Modify: `src/compilation/graph-builder.ts` (add `layout` param to `buildGraph`)
- Modify: `src/maintenance/lint.ts:68-80` (thread `layout` into both `buildGraph` and `buildEntityIndex`)
- Modify: `src/jobs/handlers/lint-wiki.ts:12`
- Create: `test/maintenance/lint.test.ts` (check first — see Step 1)

**Interfaces:**
- Consumes: `buildEntityIndex(vault, layout?)` (unchanged). `wikiContentFolders(layout: VaultLayout): string[]` from `src/vault/paths.ts:48` (already exists, already used by `entity-merger.ts` since commit `9556bc5` — this task is its second consumer).
- Produces:
  - `buildGraph(vault: VaultAdapter, layout: VaultLayout = DEFAULT_LAYOUT): Promise<WikiGraph>` — new optional `layout` param, defaulting to current (buggy-for-non-default-layouts, but backward-compatible) behavior.
  - `lintWiki(vault: VaultAdapter, options?: { autoFix?: boolean; layout?: VaultLayout }): Promise<LintResult>` — the new `options.layout` field, consumed only by this task's own caller fix (`lint-wiki.ts`). No other task depends on either signature.

- [ ] **Step 1: Check for an existing test file**

```bash
find test -iname "*lint*"
```

If `test/maintenance/lint.test.ts` does not exist (expected — confirmed absent during planning), proceed to Step 2 to create it. If it does exist, read it first and add the new tests alongside the existing ones instead of creating a new file.

- [ ] **Step 2: Extend `buildGraph`'s signature**

In `src/compilation/graph-builder.ts`, change:

```typescript
import type { VaultAdapter } from '../vault/adapter.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { parseNote } from '../vault/frontmatter.js';
import { slugify, WIKI_CONTENT_FOLDERS } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';
```

to:

```typescript
import type { VaultAdapter } from '../vault/adapter.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { parseNote } from '../vault/frontmatter.js';
import { slugify, DEFAULT_LAYOUT, wikiContentFolders, type VaultLayout } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';
```

(`slugify` is used elsewhere in this file — lines 78, 86, 95, 189 — so it stays in the import list; only `WIKI_CONTENT_FOLDERS` is dropped, replaced by `wikiContentFolders`/`DEFAULT_LAYOUT`/`VaultLayout`.)

Remove the module-level constant:

```typescript
const WIKI_FOLDERS = WIKI_CONTENT_FOLDERS;
```

Change the function signature and its folder-scanning loop, from:

```typescript
export async function buildGraph(vault: VaultAdapter): Promise<WikiGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // Collect all markdown files from wiki folders
  const allFiles: string[] = [];
  for (const folder of WIKI_FOLDERS) {
```

to:

```typescript
export async function buildGraph(vault: VaultAdapter, layout: VaultLayout = DEFAULT_LAYOUT): Promise<WikiGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // Collect all markdown files from wiki folders
  const allFiles: string[] = [];
  for (const folder of wikiContentFolders(layout)) {
```

- [ ] **Step 3: Extend `lintWiki`'s signature**

In `src/maintenance/lint.ts`, add the `VaultLayout`/`DEFAULT_LAYOUT` import. Change:

```typescript
import { buildEntityIndex, levenshtein } from '../ingest/entity-resolver.js';
```

to:

```typescript
import { buildEntityIndex, levenshtein } from '../ingest/entity-resolver.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
```

Then change the function signature and its internal calls, from:

```typescript
export async function lintWiki(
  vault: VaultAdapter,
  options?: { autoFix?: boolean },
): Promise<LintResult> {
  const autoFix = options?.autoFix ?? false;
  const issues: LintIssue[] = [];
  let autoFixed = 0;

  // Build shared data structures once
  const [graph, entityIndex] = await Promise.all([
    buildGraph(vault),
    buildEntityIndex(vault),
  ]);
```

to:

```typescript
export async function lintWiki(
  vault: VaultAdapter,
  options?: { autoFix?: boolean; layout?: VaultLayout },
): Promise<LintResult> {
  const autoFix = options?.autoFix ?? false;
  const layout = options?.layout ?? DEFAULT_LAYOUT;
  const issues: LintIssue[] = [];
  let autoFixed = 0;

  // Build shared data structures once
  const [graph, entityIndex] = await Promise.all([
    buildGraph(vault, layout),
    buildEntityIndex(vault, layout),
  ]);
```

- [ ] **Step 4: Fix the one caller**

In `src/jobs/handlers/lint-wiki.ts`, line 12, change:

```typescript
    const result = await lintWiki(context.vault, { autoFix: true });
```

to:

```typescript
    const result = await lintWiki(context.vault, { autoFix: true, layout: context.config.layout });
```

- [ ] **Step 5: Write the failing tests**

Create `test/maintenance/lint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
import { lintWiki } from '../../src/maintenance/lint.js';

describe('lintWiki', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-lint-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds an orphan page under a custom layout (proves buildGraph sees the right folders)', async () => {
    const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    await vault.ensureFolder('Curated/wiki/concepts');
    await vault.create(
      'Curated/wiki/concepts/orphan-topic.md',
      '---\nid: c1\ntype: concept\ntitle: Orphan Topic\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Orphan Topic\nNo other page links here.\n',
    );

    const result = await lintWiki(vault, { layout: customLayout });

    expect(result.scanned).toBe(1);
    const orphanIssues = result.issues.filter((i) => i.type === 'orphan');
    expect(orphanIssues).toHaveLength(1);
    expect(orphanIssues[0].path).toBe('Curated/wiki/concepts/orphan-topic.md');
  });

  it('finds a duplicate-candidate entity pair under a custom layout (proves buildEntityIndex sees the right folders)', async () => {
    const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      '---\nid: e1\ntype: entity\ntitle: Jordan Ellis\ncanonical_name: Jordan Ellis\nentity_kind: person\naliases: []\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Jordan Ellis\n',
    );
    await vault.create(
      'Curated/wiki/entities/jordan-ellys.md',
      '---\nid: e2\ntype: entity\ntitle: Jordan Ellys\ncanonical_name: Jordan Ellys\nentity_kind: person\naliases: []\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Jordan Ellys\n',
    );

    const result = await lintWiki(vault, { layout: customLayout });

    const dupIssues = result.issues.filter((i) => i.type === 'duplicate-candidate');
    expect(dupIssues).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail without the Step 2/3 fixes**

Temporarily revert Step 2 and Step 3's changes (both `layout` params removed, calls reverted to `buildGraph(vault)` / `buildEntityIndex(vault)`), then run:

Run: `npx vitest run test/maintenance/lint.test.ts`
Expected: FAIL, both tests — `buildGraph(vault)` defaults to scanning `WIKI_CONTENT_FOLDERS` (`wiki/...`), so `result.scanned` is `0` and there's no orphan issue for the first test; `buildEntityIndex(vault)` defaults to `DEFAULT_LAYOUT` (`wiki/entities`), so `entityIndex.allEntries` is empty and there's no duplicate-candidate issue for the second test.

- [ ] **Step 7: Re-apply the Step 2/3 fixes and verify both tests pass**

Run: `npx vitest run test/maintenance/lint.test.ts`
Expected: PASS, both tests.

- [ ] **Step 8: Run the full suite to confirm no regression for default-layout callers**

Run: `npm test`
Expected: all pre-existing tests pass — both `layout` params default to `DEFAULT_LAYOUT` when omitted, so any existing caller not yet updated keeps its current behavior.

- [ ] **Step 9: Commit**

```bash
git add src/compilation/graph-builder.ts src/maintenance/lint.ts src/jobs/handlers/lint-wiki.ts test/maintenance/lint.test.ts
git commit -m "fix(lint): thread real vault layout into buildGraph + lintWiki's entity index

buildGraph hardcoded WIKI_CONTENT_FOLDERS (the same legacy, non-layout-aware
constant commit 9556bc5 already replaced in entity-merger.ts) instead of
using the layout-aware wikiContentFolders(layout) helper, so lintWiki
silently scanned zero pages for orphan/broken-link/stale/thin-page
detection on any vault with a non-default layout, independent of the
buildEntityIndex layout bug this task also fixes."
```

---

### Task 6: Extend `crossLinkPages`'s context to accept a layout + fix its caller

**Files:**
- Modify: `src/compilation/cross-linker.ts:24-32`
- Modify: `src/jobs/handlers/cross-link-pages.ts:17`
- Create: `test/compilation/cross-linker.test.ts` (check first — see Step 1)

**Interfaces:**
- Consumes: `buildEntityIndex(vault, layout?)` (unchanged).
- Produces: `crossLinkPages(pagePaths: string[], context: { vault: VaultAdapter; llm?: LLMClient; layout?: VaultLayout }): Promise<CrossLinkResult>` — the new `context.layout` field, consumed only by this task's own caller fix.

- [ ] **Step 1: Check for an existing test file**

```bash
find test -iname "*cross-link*"
```

If `test/compilation/cross-linker.test.ts` does not exist (expected — confirmed absent during planning), create it per Step 4. If it exists, extend it instead.

- [ ] **Step 2: Extend `crossLinkPages`'s context type**

In `src/compilation/cross-linker.ts`, add the layout import. Change:

```typescript
import { buildEntityIndex } from '../ingest/entity-resolver.js';
```

to:

```typescript
import { buildEntityIndex } from '../ingest/entity-resolver.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
```

Then change the function signature and its internal call, from:

```typescript
export async function crossLinkPages(
  pagePaths: string[],
  context: { vault: VaultAdapter; llm?: LLMClient },
): Promise<CrossLinkResult> {
  const { vault } = context;

  log.info('Starting cross-linking', { pageCount: pagePaths.length });

  const entityIndex = await buildEntityIndex(vault);
```

to:

```typescript
export async function crossLinkPages(
  pagePaths: string[],
  context: { vault: VaultAdapter; llm?: LLMClient; layout?: VaultLayout },
): Promise<CrossLinkResult> {
  const { vault, layout = DEFAULT_LAYOUT } = context;

  log.info('Starting cross-linking', { pageCount: pagePaths.length });

  const entityIndex = await buildEntityIndex(vault, layout);
```

- [ ] **Step 3: Fix the one caller**

In `src/jobs/handlers/cross-link-pages.ts`, line 17, change:

```typescript
    const result = await crossLinkPages(pagePaths, { vault: context.vault });
```

to:

```typescript
    const result = await crossLinkPages(pagePaths, { vault: context.vault, layout: context.config.layout });
```

- [ ] **Step 4: Write the failing test**

Create `test/compilation/cross-linker.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
import { crossLinkPages } from '../../src/compilation/cross-linker.js';

describe('crossLinkPages', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-cross-linker-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('links a bare mention to an entity under a custom layout', async () => {
    const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      '---\nid: e1\ntype: entity\ntitle: Jordan Ellis\ncanonical_name: Jordan Ellis\nentity_kind: person\naliases: []\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Jordan Ellis\n',
    );
    await vault.ensureFolder('Curated/wiki/decisions');
    await vault.create(
      'Curated/wiki/decisions/some-decision.md',
      '---\ntitle: Some Decision\ncanonical_name: Some Decision\n---\nDiscussed with Jordan Ellis about scope.',
    );

    const result = await crossLinkPages(['Curated/wiki/decisions/some-decision.md'], {
      vault,
      layout: customLayout,
    });

    expect(result.linksInserted).toBeGreaterThan(0);
    const content = await vault.read('Curated/wiki/decisions/some-decision.md');
    expect(content).toContain('[[jordan-ellis');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails without the Step 2/3 fix**

Temporarily revert Step 2's change (`layout` param removed, `buildEntityIndex(vault)` reverted), then run:

Run: `npx vitest run test/compilation/cross-linker.test.ts`
Expected: FAIL — `result.linksInserted` is `0` because the entity index scans `DEFAULT_LAYOUT`'s `wiki/entities` folder, which doesn't exist in this fixture, so no lookup-table entry matches "Jordan Ellis" in the decision's body text.

- [ ] **Step 6: Re-apply Step 2's fix and verify it passes**

Run: `npx vitest run test/compilation/cross-linker.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pre-existing tests pass — `layout` defaults to `DEFAULT_LAYOUT` when the context field is omitted.

- [ ] **Step 8: Commit**

```bash
git add src/compilation/cross-linker.ts src/jobs/handlers/cross-link-pages.ts test/compilation/cross-linker.test.ts
git commit -m "fix(cross-linker): thread real vault layout into crossLinkPages' entity index"
```

---

### Task 7: Fix eval scripts requiring manual `.env` loading

**Files:**
- Create: `eval/shared/load-env.ts`
- Modify: `eval/pool/judge-full.ts` (add import + call at top of file)
- Modify: `eval/report/main.ts` (add import + call at top of file)
- Test: `test/eval/load-env.test.ts`

**Interfaces:**
- Produces: `loadEvalEnv(repoRoot: string): void` — reads `<repoRoot>/.env` synchronously and sets any `process.env` keys not already set. Mirrors the exact logic already proven in `src/bin/karpathy.ts:8-21`, extracted into a reusable, eval-scoped module (not shared with the production CLI, per Global Constraints — this avoids touching working CLI code for a refactor with no behavior change there).
- Consumed by: `eval/pool/judge-full.ts` and `eval/report/main.ts`, both of which call `createLLMForTier` (from `eval/pool/llm.ts`) → `createBedrockClient`/bearer-token path in `src/enrichment/llm-client.ts:176`, which reads `process.env['BEDROCK_BEARER_TOKEN']` directly — the root cause this fix addresses.

- [ ] **Step 1: Write the failing test**

Create `test/eval/load-env.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEvalEnv } from '../../eval/shared/load-env.js';

describe('loadEvalEnv', () => {
  let dir: string;
  const KEY = 'KARPATHY_EVAL_TEST_VAR';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-load-env-'));
    delete process.env[KEY];
  });

  afterEach(async () => {
    delete process.env[KEY];
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a var from .env into process.env when not already set', async () => {
    await writeFile(join(dir, '.env'), `${KEY}=hello-world\n# a comment\n\nOTHER=1\n`);
    loadEvalEnv(dir);
    expect(process.env[KEY]).toBe('hello-world');
  });

  it('does not override a var already present in process.env', async () => {
    process.env[KEY] = 'already-set';
    await writeFile(join(dir, '.env'), `${KEY}=from-file\n`);
    loadEvalEnv(dir);
    expect(process.env[KEY]).toBe('already-set');
  });

  it('does not throw when .env is missing', () => {
    expect(() => loadEvalEnv(dir)).not.toThrow();
  });

  it('strips matching surrounding quotes from values', async () => {
    await writeFile(join(dir, '.env'), `${KEY}="quoted-value"\n`);
    loadEvalEnv(dir);
    expect(process.env[KEY]).toBe('quoted-value');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/load-env.test.ts`
Expected: FAIL with a module-not-found error (`eval/shared/load-env.ts` doesn't exist yet).

- [ ] **Step 3: Implement `loadEvalEnv`**

Create `eval/shared/load-env.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load `<repoRoot>/.env` into process.env synchronously, without
 * overriding any variable already set. Mirrors the logic in
 * src/bin/karpathy.ts (the production CLI's entry point) so that eval
 * scripts get the same Bedrock credentials without requiring `.env` to be
 * sourced manually before every run.
 */
export function loadEvalEnv(repoRoot: string): void {
  try {
    const env = readFileSync(join(repoRoot, '.env'), 'utf-8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env — fine */
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/load-env.test.ts`
Expected: PASS, 4/4 tests.

- [ ] **Step 5: Wire into `eval/pool/judge-full.ts`**

At the very top of `eval/pool/judge-full.ts`, change:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
```

to:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEvalEnv } from '../shared/load-env.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

loadEvalEnv(join(import.meta.dirname, '..', '..'));
```

(Top-level call, mirroring `karpathy.ts`'s own top-level `try {...}` block — both files' subsequent `loadConfig`/`createLLMForTier` calls happen later, inside `main()`, so the env vars are guaranteed to be set before any client is created.)

- [ ] **Step 6: Wire into `eval/report/main.ts`**

At the very top of `eval/report/main.ts`, change:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
```

to:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEvalEnv } from '../shared/load-env.js';
import { loadConfig } from '../../src/config/loader.js';

loadEvalEnv(join(import.meta.dirname, '..', '..'));
```

- [ ] **Step 7: Verify both files still typecheck and the full suite passes**

Run: `npm run eval:typecheck`
Expected: no new errors.

Run: `npm test`
Expected: all tests pass (no existing test imports or executes these two files' module-level side effects in a way that would be affected — `loadEvalEnv` is a no-op when `.env` doesn't exist, and CI/test environments typically don't have a `.env` file present, so this doesn't leak real credentials into the test run in a way that would break anything already working).

- [ ] **Step 8: Commit**

```bash
git add eval/shared/load-env.ts eval/pool/judge-full.ts eval/report/main.ts test/eval/load-env.test.ts
git commit -m "fix(eval): auto-load .env in judge-full and answer-quality scripts

Both scripts call createLLMForTier -> createBedrockClient, which reads
process.env['BEDROCK_BEARER_TOKEN'] directly (src/enrichment/llm-client.ts).
Every real run this project required manually sourcing .env first; this
extracts the same loading logic src/bin/karpathy.ts already uses into a
reusable eval-scoped module."
```

---

### Task 8: Composite-validation freshness check (pure logic + `Bakeoff` field)

**Files:**
- Modify: `eval/score/build-bakeoff.ts`
- Modify: `test/eval/build-bakeoff.test.ts`

**Interfaces:**
- Produces:
  - `export type AnswerQualityValidationStatus = 'fresh' | 'stale' | 'missing';`
  - `export function checkAnswerQualityFreshness(resultsDir: string, bakeoffDate: string): { status: AnswerQualityValidationStatus; answerQualityDate: string | null }` — pure-ish (single `readdirSync` call, no other I/O), so it's unit-testable with a real temp directory rather than mocking `fs`.
  - New field on `BakeoffInput`: `answerQualityCheck?: { status: AnswerQualityValidationStatus; answerQualityDate: string | null }` — optional so existing test call sites that don't care about this behavior keep compiling unchanged; `buildBakeoff` defaults it to `{ status: 'missing', answerQualityDate: null }` when absent.
  - New field on `Bakeoff.run`: `answerQualityValidation: { status: AnswerQualityValidationStatus; answerQualityDate: string | null }` — always present on the output (not optional), populated from `BakeoffInput.answerQualityCheck`.
- Consumed by: Task 9's `main()` wiring and `renderBakeoffMarkdown` banner.

- [ ] **Step 1: Write the failing unit tests for `checkAnswerQualityFreshness`**

Add to `test/eval/build-bakeoff.test.ts` (add these imports to the existing import block at the top — change:

```typescript
import { buildBakeoff, renderBakeoffMarkdown } from '../../eval/score/build-bakeoff.js';
```

to:

```typescript
import { buildBakeoff, renderBakeoffMarkdown, checkAnswerQualityFreshness } from '../../eval/score/build-bakeoff.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
```

then add this new `describe` block anywhere at the top level of the file, alongside the existing `describe('buildBakeoff', ...)` block:

```typescript
describe('checkAnswerQualityFreshness', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-aq-freshness-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports missing when no answer-quality file exists', () => {
    const result = checkAnswerQualityFreshness(dir, '2026-07-17');
    expect(result).toEqual({ status: 'missing', answerQualityDate: null });
  });

  it('reports fresh when the latest answer-quality file is dated on or after the bake-off run', async () => {
    await writeFile(join(dir, '2026-07-17-answer-quality.json'), '{}');
    const result = checkAnswerQualityFreshness(dir, '2026-07-17');
    expect(result).toEqual({ status: 'fresh', answerQualityDate: '2026-07-17' });
  });

  it('reports stale when the latest answer-quality file predates the bake-off run', async () => {
    await writeFile(join(dir, '2026-07-10-answer-quality.json'), '{}');
    const result = checkAnswerQualityFreshness(dir, '2026-07-17');
    expect(result).toEqual({ status: 'stale', answerQualityDate: '2026-07-10' });
  });

  it('uses the latest of multiple answer-quality files', async () => {
    await writeFile(join(dir, '2026-07-01-answer-quality.json'), '{}');
    await writeFile(join(dir, '2026-07-20-answer-quality.json'), '{}');
    const result = checkAnswerQualityFreshness(dir, '2026-07-17');
    expect(result).toEqual({ status: 'fresh', answerQualityDate: '2026-07-20' });
  });
});
```

Also add `beforeEach`/`afterEach` to the top-level vitest import if not already present — check the existing import line:

```typescript
import { describe, it, expect } from 'vitest';
```

change to:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "checkAnswerQualityFreshness"`
Expected: FAIL with an import error (`checkAnswerQualityFreshness` is not exported yet).

- [ ] **Step 3: Implement `checkAnswerQualityFreshness`**

In `eval/score/build-bakeoff.ts`, the file already has `readdirSync` imported (used by the existing `findLatestDatedFile` helper) and defines `findLatestDatedFile` near the bottom, before `main()`. Add the new function and type right after `findLatestDatedFile`'s definition:

```typescript
export type AnswerQualityValidationStatus = 'fresh' | 'stale' | 'missing';

/**
 * Compare the latest downstream answer-quality check file's date against
 * this bake-off run's date. 'stale' means the answer-quality check predates
 * this bake-off run, so it was computed against an older dataset/judgments
 * snapshot and may no longer validate the current composite verdict.
 */
export function checkAnswerQualityFreshness(
  resultsDir: string,
  bakeoffDate: string,
): { status: AnswerQualityValidationStatus; answerQualityDate: string | null } {
  const pattern = /^(\d{4}-\d{2}-\d{2})-answer-quality\.json$/;
  let candidates: string[];
  try {
    candidates = readdirSync(resultsDir).filter((f) => pattern.test(f));
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    return { status: 'missing', answerQualityDate: null };
  }
  candidates.sort();
  const latest = candidates[candidates.length - 1];
  const answerQualityDate = latest.match(pattern)![1];
  const status: AnswerQualityValidationStatus = answerQualityDate >= bakeoffDate ? 'fresh' : 'stale';
  return { status, answerQualityDate };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "checkAnswerQualityFreshness"`
Expected: PASS, 4/4.

- [ ] **Step 5: Wire the field into `BakeoffInput`/`Bakeoff`/`buildBakeoff`**

In `eval/score/build-bakeoff.ts`, change the `BakeoffInput` interface from:

```typescript
export interface BakeoffInput {
  runsResults: RunResult[];
  scorecard: Scorecard;
  judgments: Judgment[];
  backfillReport: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
}
```

to:

```typescript
export interface BakeoffInput {
  runsResults: RunResult[];
  scorecard: Scorecard;
  judgments: Judgment[];
  backfillReport: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
  answerQualityCheck?: { status: AnswerQualityValidationStatus; answerQualityDate: string | null };
}
```

Change the `Bakeoff` interface's `run` field from:

```typescript
export interface Bakeoff {
  run: { date: string; eval_set_version: string; k: number; any_degraded_runs: boolean };
```

to:

```typescript
export interface Bakeoff {
  run: {
    date: string;
    eval_set_version: string;
    k: number;
    any_degraded_runs: boolean;
    answerQualityValidation: { status: AnswerQualityValidationStatus; answerQualityDate: string | null };
  };
```

`buildBakeoff`'s returned object's `run` field is constructed near the end of the function (right after the `rationale` computation), reading exactly:

```typescript
  return {
    run: {
      date: new Date().toISOString().slice(0, 10),
      eval_set_version: scorecard.run.date,
      k: 10,
      any_degraded_runs: scorecard.run.any_degraded_runs,
    },
```

Change it to:

```typescript
  return {
    run: {
      date: new Date().toISOString().slice(0, 10),
      eval_set_version: scorecard.run.date,
      k: 10,
      any_degraded_runs: scorecard.run.any_degraded_runs,
      answerQualityValidation: input.answerQualityCheck ?? { status: 'missing', answerQualityDate: null },
    },
```

(`input` is `buildBakeoff`'s parameter name — confirmed at `export function buildBakeoff(input: BakeoffInput): Bakeoff {`. Note `run.date` is today's actual date (`new Date().toISOString().slice(0, 10)`), while `eval_set_version` is the underlying scorecard's date — these are two different things. This distinction matters for Task 9's `main()` wiring below.)

- [ ] **Step 6: Update existing `buildBakeoff` tests to still compile**

The existing tests in `test/eval/build-bakeoff.test.ts` call `buildBakeoff({...})` without `answerQualityCheck` — since it's optional on `BakeoffInput`, they continue to compile and now produce `run.answerQualityValidation: { status: 'missing', answerQualityDate: null }` by default. Add one assertion to the existing primary test (the first `it(...)` inside `describe('buildBakeoff', ...)`) confirming this default, e.g. add a line near its other `expect(bakeoff...)` assertions:

```typescript
    expect(bakeoff.run.answerQualityValidation).toEqual({ status: 'missing', answerQualityDate: null });
```

- [ ] **Step 7: Run the full build-bakeoff test file**

Run: `npx vitest run test/eval/build-bakeoff.test.ts`
Expected: PASS, all tests including the new ones.

- [ ] **Step 8: Commit**

```bash
git add eval/score/build-bakeoff.ts test/eval/build-bakeoff.test.ts
git commit -m "feat(eval): add checkAnswerQualityFreshness + Bakeoff.run.answerQualityValidation"
```

---

### Task 9: Wire the freshness check into `main()` + render the markdown banner + fail loudly

**Files:**
- Modify: `eval/score/build-bakeoff.ts` (`main()` and `renderBakeoffMarkdown`)
- Modify: `test/eval/build-bakeoff.test.ts`

**Interfaces:**
- Consumes: `checkAnswerQualityFreshness` and the `Bakeoff.run.answerQualityValidation` field from Task 8.
- Produces: nothing new consumed elsewhere — this is the final, user-visible wiring.

- [ ] **Step 1: Write the failing test for the markdown banner**

`test/eval/build-bakeoff.test.ts` already has a `describe('renderBakeoffMarkdown', ...)` block (lines 389-412) with one existing test, `'includes the winner, margin, and a composite table row per arm'`, which builds its own fully inline `buildBakeoff({...})` fixture (it does NOT reuse the outer `describe('buildBakeoff', ...)` block's `runsResults`/`scorecard`/`judgments` consts — those are declared inside that other `describe` callback and out of scope here). Add these three new tests inside that same `describe('renderBakeoffMarkdown', ...)` block, after the existing test, following its exact inline-fixture style:

```typescript
  it('renders a missing-validation warning', () => {
    const bakeoff = buildBakeoff({
      runsResults: [
        { itemId: 'x', variant: 'grep-first', query: 'q', returned: [], searchMode: 'keyword-only', latencyMs: 100, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'full-cov-hybrid', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 50, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'as-deployed', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 5, responseChars: 40, responseTokensEst: 10 },
      ],
      scorecard: {
        run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 1, any_degraded_runs: false },
        by_category_variant: [],
        routing: {},
        coverage: {},
      },
      judgments: [],
      backfillReport: { notes_embedded: 1, wall_clock_min: 1, db_size_delta_gb: 1 },
      answerQualityCheck: { status: 'missing', answerQualityDate: null },
    });
    const md = renderBakeoffMarkdown(bakeoff);
    expect(md).toContain('UNVALIDATED');
  });

  it('renders a stale-validation warning with the answer-quality date', () => {
    const bakeoff = buildBakeoff({
      runsResults: [
        { itemId: 'x', variant: 'grep-first', query: 'q', returned: [], searchMode: 'keyword-only', latencyMs: 100, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'full-cov-hybrid', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 50, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'as-deployed', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 5, responseChars: 40, responseTokensEst: 10 },
      ],
      scorecard: {
        run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 1, any_degraded_runs: false },
        by_category_variant: [],
        routing: {},
        coverage: {},
      },
      judgments: [],
      backfillReport: { notes_embedded: 1, wall_clock_min: 1, db_size_delta_gb: 1 },
      answerQualityCheck: { status: 'stale', answerQualityDate: '2026-07-10' },
    });
    const md = renderBakeoffMarkdown(bakeoff);
    expect(md).toContain('2026-07-10');
    expect(md).toMatch(/stale|predates/i);
  });

  it('renders a fresh confirmation, not a warning', () => {
    const bakeoff = buildBakeoff({
      runsResults: [
        { itemId: 'x', variant: 'grep-first', query: 'q', returned: [], searchMode: 'keyword-only', latencyMs: 100, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'full-cov-hybrid', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 50, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'as-deployed', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 5, responseChars: 40, responseTokensEst: 10 },
      ],
      scorecard: {
        run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 1, any_degraded_runs: false },
        by_category_variant: [],
        routing: {},
        coverage: {},
      },
      judgments: [],
      backfillReport: { notes_embedded: 1, wall_clock_min: 1, db_size_delta_gb: 1 },
      answerQualityCheck: { status: 'fresh', answerQualityDate: '2026-07-17' },
    });
    const md = renderBakeoffMarkdown(bakeoff);
    expect(md).not.toContain('UNVALIDATED');
    expect(md).toContain('2026-07-17');
  });
```

(Insert these three `it(...)` blocks directly before the closing `});` of the existing `describe('renderBakeoffMarkdown', ...)` block — do not create a new `describe` block.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "answer-quality banner"`
Expected: FAIL — `renderBakeoffMarkdown`'s output doesn't contain `'UNVALIDATED'` or the date strings yet.

- [ ] **Step 3: Add the banner to `renderBakeoffMarkdown`**

In `eval/score/build-bakeoff.ts`, inside `renderBakeoffMarkdown`, right after the existing verdict-degraded-runs check:

```typescript
  if (bakeoff.run.any_degraded_runs) {
    lines.push(`⚠️ **This run's underlying harness pass was flagged degraded** (the live index changed mid-run) — see the scorecard for details.`, '');
  }
```

add:

```typescript
  const aq = bakeoff.run.answerQualityValidation;
  if (aq.status === 'missing') {
    lines.push(
      `⚠️ **UNVALIDATED: no downstream answer-quality check found for this bake-off.** ` +
      `This composite verdict has not been checked against real generated-answer quality — run \`npm run eval:answer-quality\` before trusting it.`,
      '',
    );
  } else if (aq.status === 'stale') {
    lines.push(
      `⚠️ **STALE validation: the latest downstream answer-quality check is dated ${aq.answerQualityDate}, which predates this bake-off run (${bakeoff.run.date}).** ` +
      `It may not reflect the current dataset/judgments — re-run \`npm run eval:answer-quality\` before trusting this verdict.`,
      '',
    );
  } else {
    lines.push(`✅ Downstream answer-quality check dated ${aq.answerQualityDate} validates this composite verdict.`, '');
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/eval/build-bakeoff.test.ts`
Expected: PASS, full file.

- [ ] **Step 5: Wire `checkAnswerQualityFreshness` into `main()` with loud-warn-and-fail behavior**

In `eval/score/build-bakeoff.ts`'s `main()`, change:

```typescript
  const bakeoff = buildBakeoff({ runsResults: runsFile.results, scorecard, judgments, backfillReport });

  const date = bakeoff.run.date;
  writeFileSync(join(resultsDir, `${date}-bakeoff.json`), JSON.stringify(bakeoff, null, 2));
  writeFileSync(join(resultsDir, `${date}-bakeoff.md`), renderBakeoffMarkdown(bakeoff));
  console.log(`Wrote eval/results/${date}-bakeoff.json and .md`);
  console.log(`Verdict: ${bakeoff.verdict.winner} (margin ${bakeoff.verdict.margin}, mixed: ${bakeoff.verdict.mixed})`);
}
```

to:

```typescript
  // Compare against today's date, matching bakeoff.run.date (not scorecard.run.date,
  // which is the underlying eval-set/harness-pass version, a separate concept —
  // see Task 8 Step 5's note).
  const today = new Date().toISOString().slice(0, 10);
  const answerQualityCheck = checkAnswerQualityFreshness(resultsDir, today);
  const bakeoff = buildBakeoff({ runsResults: runsFile.results, scorecard, judgments, backfillReport, answerQualityCheck });

  const date = bakeoff.run.date;
  writeFileSync(join(resultsDir, `${date}-bakeoff.json`), JSON.stringify(bakeoff, null, 2));
  writeFileSync(join(resultsDir, `${date}-bakeoff.md`), renderBakeoffMarkdown(bakeoff));
  console.log(`Wrote eval/results/${date}-bakeoff.json and .md`);
  console.log(`Verdict: ${bakeoff.verdict.winner} (margin ${bakeoff.verdict.margin}, mixed: ${bakeoff.verdict.mixed})`);

  if (answerQualityCheck.status !== 'fresh') {
    console.error(
      `\n⚠️  WARNING: answer-quality validation status is '${answerQualityCheck.status}' — ` +
      `this composite verdict has NOT been confirmed against real answer quality. ` +
      `Run 'npm run eval:answer-quality' and re-run this script before trusting the verdict.\n`,
    );
    process.exitCode = 1;
  }
}
```

- [ ] **Step 6: Verify `main()` still runs correctly against real result files (manual smoke check)**

This step exercises the real CLI entry point end-to-end against the actual committed result files in `eval/results/`, which is not practical to assert on in an automated test (it depends on today's date relative to the most recent real `eval:answer-quality` run). Run it manually and read the output:

Run: `npm run eval:bakeoff`
Expected: the script completes, writes `eval/results/<today>-bakeoff.json` and `.md` as before, and prints either the `✅ ... validates this composite verdict` line (if `eval/results/2026-07-17-answer-quality.json` is still the latest and today's date is `>=` `2026-07-17`, which it will be for any run on or after that date) or the stale/missing warning + a non-zero exit code (`echo $?` afterward) if a much later run date makes that file look stale. Either outcome is correct behavior for this task — the point is confirming the gate actually fires against real files, not a specific status.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass (882+ prior tests plus the new ones added across Tasks 1-9).

- [ ] **Step 8: Commit**

```bash
git add eval/score/build-bakeoff.ts test/eval/build-bakeoff.test.ts
git commit -m "feat(eval): fail eval:bakeoff loudly when answer-quality validation is missing or stale

Previously eval:bakeoff would present a clean composite verdict with no
indication of whether a corresponding downstream answer-quality check had
ever been run or was still current for this run's dataset/judgments. Now
it checks eval/results/ for the latest *-answer-quality.json, renders a
warning banner in the .md output, and exits non-zero (without crashing —
the .json/.md artifacts are still written) when the check is missing or
predates this bake-off run."
```

---

## Post-plan verification

After all 9 tasks are complete:

- [ ] Run `npm test` one final time and confirm 0 failures.
- [ ] Run `npm run eval:typecheck` and confirm no new errors.
- [ ] Grep for any remaining un-scoped `buildEntityIndex(`, `resolveEntity(`, or `buildGraph(` calls that pass fewer than the full argument list, to confirm no site was missed: `grep -rn "buildEntityIndex(vault)\|buildEntityIndex(context.vault)\|buildEntityIndex(deps.vault)" src/`, `grep -rn "resolveEntity({ name" src/`, and `grep -rn "buildGraph(vault)" src/` — cross-check every match against this plan's Global Constraints list; any match not named there is a genuinely new finding, not something to silently fix — surface it instead of expanding scope unilaterally.

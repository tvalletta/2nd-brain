# B2b Wiki Content Richness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two layout-hardcoding bugs that silently block the existing project-resynthesis pipeline, generalize `refreshTopic` so decision/project notes get real evidence-grounded refresh instead of a mismatched region bolt-on, add deterministic thin-content detection that backfills ~24 already-placeholder notes, populate the `related-concepts` field that's currently computed and discarded, and make the concept glossary content-aware (dedup + threshold-triggered synthesis).

**Architecture:** A new `REFRESH_TARGETS` registry (`src/intelligence/refresh-targets.ts`) centralizes, per note `type`, which protected region to rewrite, what counts as a placeholder, and how to prompt/parse the LLM response. `refreshTopic` dispatches through this registry instead of a hardcoded `current-understanding` region; `decay-scan`/`rot-scan` consume the same registry for thin-content detection/reporting. The concept glossary gains content-aware dedup and a budget-gated `glossary-synthesize` job that fires once a concept's mention count crosses a configurable threshold.

**Design spec:** `docs/superpowers/specs/2026-07-31-b2b-wiki-content-richness-design.md`

## Global Constraints

- ESM only — all imports use `.js` extensions, even for `.ts` source files.
- Strict TypeScript — `pnpm lint` (`tsc --noEmit`) must pass with no errors.
- `pnpm build && pnpm test && pnpm lint` must all pass before any commit.
- Vitest is the test runner; tests live under `test/`, mirroring `src/` structure.
- No new runtime dependencies.
- Tests use real temp directories + `createFsAdapter` + real `KarpathyConfigSchema.parse(...)` — never mock vault I/O.
- A real `TransientLLMError` must never be caught and converted into a placeholder/fallback result anywhere in this plan's new code — it always propagates.
- Any test that exercises a code path calling `createLLMFromConfig` (directly, or transitively via a handler/orchestrator) MUST mock it — never let a test fall through to a real network call. Construct a `KarpathyConfig` with Zod defaults (`provider: 'bedrock'`, no bearer token) freely in tests, but always pair it with `vi.mock('.../llm-factory.js', ...)` when the code path under test would otherwise construct a real client.
- `test/bin/intel-tick-exit.test.ts` is a known pre-existing flake in this environment (spawns the real CLI against whatever vault is configured on the host machine, unrelated to this plan) — if it's the only failure in a full `pnpm test` run, treat the run as clean.

## Discrepancies found vs. the design doc (resolved inline in the affected tasks)

- **`agent-synthesize-project.ts` has a third layout-hardcoding call site the design's §3 code sample doesn't mention:** `listProjectSpecs(vault, projectSlug)` is called with only two arguments, so it silently defaults to the legacy `wiki/` layout via `listProjectSpecs`'s own `layout: VaultLayout = DEFAULT_LAYOUT` parameter default — even after fixing `indexPath`, `currentSpecs` would stay empty under `Curated/wiki`. Fixed in Task 1 by passing `layout` as the third argument.
- **`agent-synthesize-project.ts` has zero existing test coverage** (confirmed by a repo-wide grep — only `check-confidence-decay.test.ts` references the job type as an *enqueue target*, never invoking the handler). The design's §15 implies both Component-0 handlers "already have tests [that] evidently only exercise the default layout" — true for `check-confidence-decay.ts`, false for `agent-synthesize-project.ts`. Task 1 creates a brand-new test file rather than "extending" one.
- **`rot-scan.ts`'s tests live inside `test/intelligence/decay-scan.test.ts`** (a `describe('rot-scan (C2)', ...)` block), not a separate `rot-scan.test.ts` file. Task 7 extends that block in the shared file.
- **The design's §7 snippet says `thinCandidates: RotEntry[]`-shaped**, but `RotEntry` carries `ageDays`/`confidence`/`hasInboundMarker`/`retrievability`, none of which apply to a thin-content check. Task 7 introduces a distinct `ThinContentEntry { path; title; region }` interface instead of overloading `RotEntry`.
- **The design's §4 `RefreshSynthesis` interface uses `newSources` (camelCase)** while every Zod response schema in the same section and all consuming code in §5 use `new_sources` (snake_case). Task 3 defines a single `RefreshSynthesisResult` interface using `new_sources` throughout — the camelCase name never existed in real code and is not used anywhere in this plan.
- **The design's §5 code sample renames the wrapped-error message from `topic synthesis failed for...` to `refresh failed for...`**, which would break `topic-refresh.test.ts`'s existing byte-exact assertion on that message and directly contradicts the design's own §15 requirement that concept/topic behavior stay "byte-for-byte unchanged." Task 4 keeps the original `topic synthesis failed for...` text.
- **The design's §6 code sample sets `trigger: isThin ? 'thin-content' : 'cascade'`**, but `JobTrigger` (`src/jobs/types.ts`) is a Zod enum of exactly `['file-watcher', 'hook', 'timer', 'cli', 'cascade']` — passing `'thin-content'` would throw a `ZodError` inside `queue.ts`'s `JobSchema.parse(...)` the first time a thin note is found. Task 6 adds `'thin-content'` to the `JobTrigger` enum (verified no exhaustive switch on `trigger` exists anywhere in `src/`, so this is a safe additive change).
- **The design's §12 decision table and §6 code sample disagree on trigger precedence** when a note is both below the retrievability threshold *and* thin (table implies `cascade` wins; code's ternary and the accompanying prose — "thin-content backfill takes slight priority" — imply `thin-content` wins). Task 6 follows the code + prose (the more precise, doubly-corroborated source): `isThin` always wins the trigger/priority label, regardless of retrievability.
- **`REFRESH_TARGETS[type].responseSchema`'s declared type (`z.ZodType<RefreshSynthesisResult>`)** is wider than what `ConceptTopicSchema`/`ProjectSchema` actually validate (neither has a `secondary` field) — this is fine by TypeScript structural typing (an object type lacking an optional property is assignable to one that has it as optional), so no cast is needed; noted here only because it's easy to second-guess when reading Task 3's code.

---

### Task 1: Component 0 — layout-path bug fixes

**Files:**
- Modify: `src/jobs/handlers/check-confidence-decay.ts`
- Modify: `src/jobs/handlers/agent-synthesize-project.ts`
- Test: `test/jobs/handlers/check-confidence-decay.test.ts` (extend existing file)
- Test: `test/jobs/handlers/agent-synthesize-project.test.ts` (**new file** — see discrepancy note above)

**Interfaces:**
- Consumes: `layoutFromConfig` from `src/vault/paths.js` (pre-existing), `listProjectSpecs(vault, projectSlug, layout?)` from `src/compilation/project-hub.js` (pre-existing, `layout` param already supported but never passed by this call site).
- Produces: no new exports — both handlers keep their existing `JobHandler` shape. This task only fixes which vault paths they read/write.

- [ ] **Step 1: Write the failing tests**

In `test/jobs/handlers/check-confidence-decay.test.ts`, add a new test inside the existing `describe('check-confidence-decay handler', ...)` block, after the `'deduplicates per project...'` test:

```typescript
  it('finds stale specs under a non-default layout.wiki (regression for the layout-hardcoding bug)', async () => {
    const hubDir = 'Curated/wiki/projects/curated-proj';
    await vault.ensureFolder(hubDir);
    const specFm: Record<string, unknown> = {
      id: 'curated-proj-technical', type: 'project_spec', title: 'curated-proj technical',
      project_key: 'curated-proj', spec_type: 'technical', status: 'active', confidence: 'medium',
      review_state: 'approved', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_reinforced: '2026-01-01T00:00:00Z', reinforcement_count: 3,
      conversations_since_update: 15, stale_threshold: 10,
      source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'extraction',
      protected_regions: ['content'],
    };
    await vault.atomicWrite(`${hubDir}/technical.md`, serializeNote(specFm, '\n# curated-proj technical\n'));
    const indexFm: Record<string, unknown> = {
      id: 'curated-proj', type: 'project', title: 'curated-proj', project_key: 'curated-proj',
      status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'extraction',
      protected_regions: [],
    };
    await vault.atomicWrite(`${hubDir}/_index.md`, serializeNote(indexFm, '\n# curated-proj\n'));

    const context: JobContext = {
      vaultPath: tempDir,
      projectRoot: tempDir,
      vault,
      enqueue: async (input: JobCreateInput) => {
        enqueuedJobs.push(input);
        return { ...input, id: 'enqueued', status: 'pending', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0, priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade' } as Job;
      },
      llm: {} as any,
      config: KarpathyConfigSchema.parse({
        vaultPath: tempDir,
        layout: { wiki: 'Curated/wiki' },
        agent: { enabled: true, incrementalThreshold: 5 },
      }),
    };

    await checkConfidenceDecayHandler.execute(makeJob(), context);

    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].payload!.projectSlug).toBe('curated-proj');
  });
```

Create `test/jobs/handlers/agent-synthesize-project.test.ts` in full:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { createDigestCache } from '../../../src/agent/digest-cache.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

vi.mock('../../../src/agent/bedrock-agent-client.js', () => ({
  createAgentClient: vi.fn(() => ({
    runAgentLoop: vi.fn(async () => ({ turns: 1, toolCalls: 0 })),
  })),
}));

import { createAgentClient } from '../../../src/agent/bedrock-agent-client.js';
import { agentSynthesizeProjectHandler } from '../../../src/jobs/handlers/agent-synthesize-project.js';

function makeJob(projectSlug: string): Job {
  return {
    id: 'test-synth', type: 'agent-synthesize-project', status: 'running', priority: 35,
    payload: { projectSlug }, trigger: 'cascade',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('agent-synthesize-project handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-synth-'));
    vault = createFsAdapter(dir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(config: ReturnType<typeof KarpathyConfigSchema.parse>): JobContext {
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: {} as any,
      config,
    };
  }

  async function writeHub(hubDir: string, slug: string): Promise<void> {
    await vault.ensureFolder(hubDir);
    const indexFm: Record<string, unknown> = {
      id: slug, type: 'project', title: slug, project_key: slug, status: 'active',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'extraction',
      protected_regions: ['overview', 'specs', 'people', 'sessions', 'sources', 'backlinks'],
    };
    await vault.atomicWrite(`${hubDir}/_index.md`, serializeNote(indexFm, `\n# ${slug}\n`));
    const specFm: Record<string, unknown> = {
      id: `${slug}-technical`, type: 'project_spec', title: `${slug} technical`, project_key: slug,
      spec_type: 'technical', status: 'active', confidence: 'medium', review_state: 'approved',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'extraction',
      protected_regions: ['content'],
    };
    await vault.atomicWrite(`${hubDir}/technical.md`, serializeNote(specFm, `\n# ${slug} technical\n`));
  }

  it('reads the hub and specs under a non-default layout.wiki, and runs the agent loop', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      layout: { wiki: 'Curated/wiki' },
      agent: { enabled: true },
    });
    await writeHub('Curated/wiki/projects/my-proj', 'my-proj');

    const digestCache = createDigestCache(join(dir, config.stateDir));
    await digestCache.set({
      sourcePath: 'raw/ai-conversations/my-proj/s1.md',
      sourceHash: 'h1',
      digest: 'Discussed the new ingest pipeline.',
      entities: [], topics: [], decisions: [],
      createdAt: '2026-01-01T00:00:00Z',
    });

    const ctx = makeContext(config);
    await agentSynthesizeProjectHandler.execute(makeJob('my-proj'), ctx);

    expect(createAgentClient).toHaveBeenCalledTimes(1);
  });

  it('regression: still finds the hub and specs under the DEFAULT layout (unchanged behavior)', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, agent: { enabled: true } });
    await writeHub('wiki/projects/legacy-proj', 'legacy-proj');

    const digestCache = createDigestCache(join(dir, config.stateDir));
    await digestCache.set({
      sourcePath: 'raw/ai-conversations/legacy-proj/s1.md',
      sourceHash: 'h1',
      digest: 'Discussed onboarding.',
      entities: [], topics: [], decisions: [],
      createdAt: '2026-01-01T00:00:00Z',
    });

    const ctx = makeContext(config);
    await agentSynthesizeProjectHandler.execute(makeJob('legacy-proj'), ctx);

    expect(createAgentClient).toHaveBeenCalledTimes(1);
  });

  it('skips (does not call the agent loop) when no hub exists at the configured layout path', async () => {
    // Hub written at the DEFAULT layout path while config declares Curated/wiki — there is
    // genuinely no hub at the configured path, so this must still legitimately no-op.
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      layout: { wiki: 'Curated/wiki' },
      agent: { enabled: true },
    });
    await writeHub('wiki/projects/my-proj', 'my-proj'); // wrong location for this config

    const ctx = makeContext(config);
    await agentSynthesizeProjectHandler.execute(makeJob('my-proj'), ctx);

    expect(createAgentClient).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/jobs/handlers/check-confidence-decay.test.ts test/jobs/handlers/agent-synthesize-project.test.ts`
Expected: FAIL — the new `check-confidence-decay` test finds 0 enqueued jobs (hardcoded `wiki/` path doesn't match `Curated/wiki`); the first two `agent-synthesize-project` tests never call `createAgentClient` because `vault.read('wiki/projects/.../_index.md')` throws under the `Curated/wiki` case (first test) or the digest cache is empty relative to a wrong path in neither case — confirm by running and reading the actual failure, but the underlying bug means `createAgentClient` is never invoked for the first test.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/handlers/check-confidence-decay.ts`, change:

```typescript
    for (const slug of projectDirs) {
      const hubDir = `wiki/projects/${slug}`;
```

to:

```typescript
    for (const slug of projectDirs) {
      const hubDir = `${context.config.layout.wiki}/projects/${slug}`;
```

In `src/jobs/handlers/agent-synthesize-project.ts`, add the import (after the existing `import { listProjectSpecs } from '../../compilation/project-hub.js';` line):

```typescript
import { layoutFromConfig } from '../../vault/paths.js';
```

Then change:

```typescript
    const { vault, config } = context;
    const stateDir = join(context.projectRoot, config.stateDir);
    const agentConfig = config.agent;

    log.info('Starting full re-synthesis', { projectSlug });

    // 1. Read current hub state
    const indexPath = `wiki/projects/${projectSlug}/_index.md`;
```

to:

```typescript
    const { vault, config } = context;
    const stateDir = join(context.projectRoot, config.stateDir);
    const agentConfig = config.agent;
    const layout = layoutFromConfig(config);

    log.info('Starting full re-synthesis', { projectSlug });

    // 1. Read current hub state
    const indexPath = `${layout.wiki}/projects/${projectSlug}/_index.md`;
```

And change (the third call site the design doc's §3 sample doesn't mention — without this fix, `currentSpecs` stays empty under any non-default `layout.wiki` even after the `indexPath` fix above):

```typescript
    // 2. Read current sub-specs
    const specs = await listProjectSpecs(vault, projectSlug);
```

to:

```typescript
    // 2. Read current sub-specs
    const specs = await listProjectSpecs(vault, projectSlug, layout);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/jobs/handlers/check-confidence-decay.test.ts test/jobs/handlers/agent-synthesize-project.test.ts`
Expected: PASS (all tests, including the pre-existing `check-confidence-decay` tests, which exercise only the default `wiki/` layout and must remain unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/handlers/check-confidence-decay.ts src/jobs/handlers/agent-synthesize-project.ts test/jobs/handlers/check-confidence-decay.test.ts test/jobs/handlers/agent-synthesize-project.test.ts
git commit -m "fix(jobs): use configured layout.wiki instead of hardcoded 'wiki/' in check-confidence-decay and agent-synthesize-project"
```

---

### Task 2: Config schema — `intelligence.richness` section

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config/schema.test.ts` (extend existing file)

**Interfaces:**
- Produces: `RichnessConfigSchema` (exported Zod schema), `KarpathyConfig['intelligence']['richness']: { enabled: boolean; glossarySynthesisThreshold: number }` — consumed by Task 9.

- [ ] **Step 1: Write the failing test**

Add to `test/config/schema.test.ts`, a new `describe` block after the existing `'KarpathyConfigSchema — review'` block:

```typescript
describe('KarpathyConfigSchema — intelligence.richness', () => {
  it('defaults intelligence.richness when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.richness).toEqual({
      enabled: true,
      glossarySynthesisThreshold: 3,
    });
  });

  it('allows overriding enabled and glossarySynthesisThreshold', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { richness: { enabled: false, glossarySynthesisThreshold: 5 } },
    });
    expect(config.intelligence.richness.enabled).toBe(false);
    expect(config.intelligence.richness.glossarySynthesisThreshold).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: FAIL — `config.intelligence.richness` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schema.ts`, inside `IntelligenceConfigSchema`, add a new `richness` field right after the `refresh` sub-schema and before `budget` (i.e., after the block ending `.default({}),` that closes `cascadeDepth: z.union([z.literal(0), z.literal(1)]).default(1),\n    })\n    .default({}),`):

```typescript
  /**
   * B2b: wiki content richness. Gates thin-content backfill (decay-scan) and
   * glossary threshold synthesis (compile-entities → glossary-synthesize).
   */
  richness: z
    .object({
      enabled: z.boolean().default(true),
      /** Mention count at which a glossary concept gets an LLM-synthesized rollup line
       *  instead of just a bare list of raw glosses. Re-fires every `threshold` mentions
       *  past the last synthesis (e.g. at 3, then 6, then 9...). */
      glossarySynthesisThreshold: z.number().int().positive().default(3),
    })
    .default({}),
```

No other changes are needed: `PartialIntelligenceConfigSchema = IntelligenceConfigSchema.partial()` (already present) picks up the new field automatically, and `ProjectOverrideSchema`/`GlobalDefaultsSchema` already reference `PartialIntelligenceConfigSchema` generically. No `loader.ts` changes — `mergeOverride()` already merges every nested key generically.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "feat(config): add intelligence.richness.enabled and glossarySynthesisThreshold"
```

---

### Task 3: `REFRESH_TARGETS` registry

**Files:**
- Create: `src/intelligence/refresh-targets.ts`
- Test: `test/intelligence/refresh-targets.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from other tasks (pure prompt/schema/predicate definitions).
- Produces: `REFRESH_TARGETS: Record<'concept'|'topic'|'decision'|'project', RefreshTarget>`, `isPlaceholderContent(target, rawContent): boolean`, `RefreshTarget`, `RefreshEvidence`, `RefreshSynthesisResult` types — all consumed by Tasks 4, 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Create `test/intelligence/refresh-targets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { REFRESH_TARGETS, isPlaceholderContent } from '../../src/intelligence/refresh-targets.js';

describe('refresh-targets', () => {
  describe('isPlaceholderContent', () => {
    it('concept/topic: null, empty, and "(no current understanding yet)" are placeholders', () => {
      const target = REFRESH_TARGETS.concept;
      expect(isPlaceholderContent(target, null)).toBe(true);
      expect(isPlaceholderContent(target, '')).toBe(true);
      expect(isPlaceholderContent(target, '  ')).toBe(true);
      expect(isPlaceholderContent(target, '(no current understanding yet)')).toBe(true);
      expect(isPlaceholderContent(target, '(NO CURRENT UNDERSTANDING YET)')).toBe(true);
    });

    it('concept/topic: the character-floor boundary (39 chars thin, 40 chars not)', () => {
      const target = REFRESH_TARGETS.topic;
      expect(isPlaceholderContent(target, 'x'.repeat(39))).toBe(true);
      expect(isPlaceholderContent(target, 'x'.repeat(40))).toBe(false);
    });

    it('concept/topic: a substantial string is not a placeholder', () => {
      expect(isPlaceholderContent(REFRESH_TARGETS.concept, 'A'.repeat(41))).toBe(false);
    });

    it('decision: empty and "(pending)" are placeholders, a real outcome is not', () => {
      const target = REFRESH_TARGETS.decision;
      expect(isPlaceholderContent(target, '')).toBe(true);
      expect(isPlaceholderContent(target, '(pending)')).toBe(true);
      expect(isPlaceholderContent(target, '(Pending)')).toBe(true);
      expect(isPlaceholderContent(target, 'Approved and shipped.')).toBe(false);
    });

    it('decision: the character-floor boundary (9 chars thin, 10 chars not)', () => {
      const target = REFRESH_TARGETS.decision;
      expect(isPlaceholderContent(target, 'x'.repeat(9))).toBe(true);
      expect(isPlaceholderContent(target, 'x'.repeat(10))).toBe(false);
    });

    it('project: empty and "Pending enrichment." are placeholders, a real overview is not', () => {
      const target = REFRESH_TARGETS.project;
      expect(isPlaceholderContent(target, '')).toBe(true);
      expect(isPlaceholderContent(target, 'Pending enrichment.')).toBe(true);
      expect(isPlaceholderContent(target, 'PENDING ENRICHMENT.')).toBe(true);
      expect(isPlaceholderContent(target, 'A local-first knowledge system that captures sessions.')).toBe(false);
    });

    it('strips wikilink brackets before measuring length against the floor', () => {
      expect(isPlaceholderContent(REFRESH_TARGETS.project, '[[]]')).toBe(true);
    });
  });

  describe('buildPrompt', () => {
    it('concept/topic prompt includes the title, existing understanding, and evidence', () => {
      const prompt = REFRESH_TARGETS.concept.buildPrompt({
        title: 'Recency-aware RAG',
        existingPrimary: 'Old framing.',
        evidenceBlock: '[1] evidence text',
      });
      expect(prompt).toContain('Recency-aware RAG');
      expect(prompt).toContain('Old framing.');
      expect(prompt).toContain('[1] evidence text');
      expect(prompt).toContain('"primary"');
    });

    it('decision prompt includes the recorded context, current outcome, and anti-fabrication instruction', () => {
      const prompt = REFRESH_TARGETS.decision.buildPrompt({
        title: 'Adopt LiteLLM proxy',
        existingPrimary: '',
        existingSecondary: 'Needed multi-provider fallback.',
        evidenceBlock: '[1] evidence text',
      });
      expect(prompt).toContain('Adopt LiteLLM proxy');
      expect(prompt).toContain('Needed multi-provider fallback.');
      expect(prompt).toContain('(pending)');
      expect(prompt).toContain('never fabricate a resolution');
    });

    it('project prompt includes the current overview and honest-placeholder instruction', () => {
      const prompt = REFRESH_TARGETS.project.buildPrompt({
        title: 'Second Brain',
        existingPrimary: 'Pending enrichment.',
        evidenceBlock: '[1] evidence text',
      });
      expect(prompt).toContain('Second Brain');
      expect(prompt).toContain('Pending enrichment.');
      expect(prompt).toContain("never invent scope or status");
    });
  });

  describe('responseSchema', () => {
    it('concept/topic schema requires primary, defaults contradictions/new_sources', () => {
      const parsed = REFRESH_TARGETS.concept.responseSchema.parse({ primary: 'text' });
      expect(parsed).toEqual({ primary: 'text', contradictions: [], new_sources: [] });
    });

    it('concept/topic schema rejects a response missing primary', () => {
      expect(() => REFRESH_TARGETS.topic.responseSchema.parse({ contradictions: [], new_sources: [] })).toThrow();
    });

    it('decision schema accepts an optional secondary field', () => {
      const parsed = REFRESH_TARGETS.decision.responseSchema.parse({
        primary: '(pending)', secondary: 'Sharpened context.', contradictions: [], new_sources: [],
      });
      expect(parsed.secondary).toBe('Sharpened context.');
    });

    it('project schema has no secondary field but still parses without one', () => {
      const parsed = REFRESH_TARGETS.project.responseSchema.parse({ primary: 'Overview text.' });
      expect(parsed.secondary).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/intelligence/refresh-targets.test.ts`
Expected: FAIL — `src/intelligence/refresh-targets.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/intelligence/refresh-targets.ts`:

```typescript
import { z } from 'zod';

export interface RefreshEvidence {
  title: string;
  existingPrimary: string;    // current content of the primary region (may be a placeholder)
  existingSecondary?: string; // e.g. decision's `context`, used as read-only grounding
  evidenceBlock: string;      // pre-formatted, numbered retrieval hits
}

/**
 * Shape every REFRESH_TARGETS[*].responseSchema parses to. Field names are
 * snake_case (`new_sources`) to match what the LLM is asked to emit and what
 * `refreshTopic` actually reads (`synthesis.new_sources`).
 */
export interface RefreshSynthesisResult {
  primary: string;
  secondary?: string;
  contradictions: Array<{ ref: string; reason: string }>;
  new_sources: string[];
}

export interface RefreshTarget {
  /** The one protected region this refresh pass rewrites. */
  primaryRegion: string;
  /** Optional second region this type's prompt is also allowed to touch (decision only: `context`). */
  secondaryRegion?: string;
  /** Human label used in prompts/logs. */
  label: string;
  /** Exact strings (case-insensitive, trimmed) that count as "not yet written" for this type. */
  placeholderStrings: string[];
  /** Below this many non-whitespace characters (after stripping wikilink brackets), also counts as thin. */
  minCharFloor: number;
  buildPrompt(evidence: RefreshEvidence): string;
  responseSchema: z.ZodType<RefreshSynthesisResult>;
}

export function isPlaceholderContent(target: RefreshTarget, rawContent: string | null): boolean {
  const trimmed = (rawContent ?? '').trim();
  if (trimmed.length === 0) return true;
  if (target.placeholderStrings.some((p) => p.toLowerCase() === trimmed.toLowerCase())) return true;
  const stripped = trimmed.replace(/\[\[|\]\]/g, '');
  return stripped.length < target.minCharFloor;
}

function buildConceptTopicPrompt(e: RefreshEvidence): string {
  return `You are refreshing a topic note in a personal knowledge base.

Topic: ${e.title}
Current understanding (from existing note):
"""
${e.existingPrimary || '(no current understanding yet)'}
"""

New evidence (most recent retrievals):
${e.evidenceBlock}

Produce a JSON object with these fields:
{
  "primary": "≤8 paragraphs. Chain-of-density rewrite integrating the new evidence. Cite sources inline as [n]. Do NOT overwrite or hide claims that disagree with new evidence — surface them as contradictions instead.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;
}

function buildDecisionPrompt(e: RefreshEvidence): string {
  return `You are refreshing a decision note in a personal knowledge base.

Decision: ${e.title}
Recorded context (why this decision was made):
"""
${e.existingSecondary || '(no context recorded)'}
"""
Current outcome on file: "${e.existingPrimary || '(pending)'}"

New evidence (most recent retrievals):
${e.evidenceBlock}

Produce a JSON object with these fields:
{
  "primary": "What actually happened as a result of this decision, grounded ONLY in the evidence above. If the evidence still does not reveal an outcome, write exactly \\"(pending)\\" — never fabricate a resolution just to fill the field.",
  "secondary": "Only include this field if the new evidence meaningfully sharpens or corrects the original context — omit it otherwise.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;
}

function buildProjectPrompt(e: RefreshEvidence): string {
  return `You are refreshing a project overview in a personal knowledge base.

Project: ${e.title}
Current overview on file:
"""
${e.existingPrimary || 'Pending enrichment.'}
"""

New evidence (most recent retrievals across all sources mentioning this project):
${e.evidenceBlock}

Produce a JSON object with these fields:
{
  "primary": "≤3 paragraphs: what this project is, its current status, and the most important recent developments. Cite sources inline as [n]. If the evidence is too sparse to say anything concrete yet, write exactly \\"Pending enrichment.\\" — never invent scope or status you can't ground in the evidence.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;
}

const ConceptTopicSchema = z.object({
  primary: z.string(),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  new_sources: z.array(z.string()).default([]),
});

const DecisionSchema = z.object({
  primary: z.string(),
  secondary: z.string().optional(),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  new_sources: z.array(z.string()).default([]),
});

const ProjectSchema = z.object({
  primary: z.string(),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  new_sources: z.array(z.string()).default([]),
});

export const REFRESH_TARGETS: Record<'concept' | 'topic' | 'decision' | 'project', RefreshTarget> = {
  concept: {
    primaryRegion: 'current-understanding',
    label: 'Current Understanding',
    placeholderStrings: ['(no current understanding yet)', ''],
    minCharFloor: 40,
    buildPrompt: buildConceptTopicPrompt,
    responseSchema: ConceptTopicSchema,
  },
  topic: {
    primaryRegion: 'current-understanding',
    label: 'Current Understanding',
    placeholderStrings: ['(no current understanding yet)', ''],
    minCharFloor: 40,
    buildPrompt: buildConceptTopicPrompt,
    responseSchema: ConceptTopicSchema,
  },
  decision: {
    primaryRegion: 'outcome',
    secondaryRegion: 'context',
    label: 'Outcome',
    placeholderStrings: ['', '(pending)'],
    minCharFloor: 10,
    buildPrompt: buildDecisionPrompt,
    responseSchema: DecisionSchema,
  },
  project: {
    primaryRegion: 'overview',
    label: 'Overview',
    placeholderStrings: ['', 'pending enrichment.'],
    minCharFloor: 20,
    buildPrompt: buildProjectPrompt,
    responseSchema: ProjectSchema,
  },
};
```

`project_spec` is intentionally absent — its `content` region stays owned by `agent-synthesize-project` (Task 1), per the design's §5 "Why `project_spec` is excluded."

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/intelligence/refresh-targets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/refresh-targets.ts test/intelligence/refresh-targets.test.ts
git commit -m "feat(intelligence): add REFRESH_TARGETS registry for region-aware note refresh"
```

---

### Task 4: Generalize `refreshTopic` — region dispatch

**Files:**
- Modify: `src/intelligence/topic-refresh.ts`
- Test: `test/intelligence/topic-refresh.test.ts` (extend existing file — every existing test's `fakeLLM` response literal must be updated, see Step 1)

**Interfaces:**
- Consumes: `REFRESH_TARGETS`, `RefreshTarget`, `RefreshSynthesisResult` from Task 3 (`src/intelligence/refresh-targets.js`).
- Produces: `refreshTopic(deps, notePath, options)` — signature and job-type wiring (`src/jobs/handlers/topic-refresh.ts`) are **unchanged**; only the internal region-selection and prompt-dispatch logic changes. Consumed unmodified by Task 5 (which further restructures the function body) and Task 6/7 (which consume `REFRESH_TARGETS` directly, not `refreshTopic`).

- [ ] **Step 1: Update the existing tests for the new response-schema field name**

The current `SynthesisSchema` (being removed) used `current_understanding` as the field name; `REFRESH_TARGETS.concept`/`.topic`'s schema (Task 3) uses `primary` instead, to share one schema shape across all four note types. Update `test/intelligence/topic-refresh.test.ts`:

Replace the `FakeResponse` interface:

```typescript
interface FakeResponse {
  primary: string;
  secondary?: string;
  contradictions: { ref: string; reason: string }[];
  new_sources: string[];
}
```

In every existing `fakeLLM({ current_understanding: ..., ... })` call (six call sites: `'integrates new evidence...'`, `'halves stability...'`, `'Phase 1: clears pending_evidence...'`, `'Phase 1: cascades to a neighbor resolved under a non-default vault layout'`, `'Phase 1: cascadeDepth=0 disables the neighbor cascade'`, `'still bumps last_verified when no chunks retrieved'`), rename the `current_understanding` key to `primary`. For example:

```typescript
    const llm = fakeLLM({
      current_understanding:
        'Recency-aware RAG combines bi-encoder + cross-encoder + a recency prior. Two-stage retrieval is now table stakes [1][2].',
      contradictions: [],
      new_sources: ['wiki/sessions/2026-04-15.md', 'wiki/sessions/2026-04-20.md'],
    });
```

becomes:

```typescript
    const llm = fakeLLM({
      primary:
        'Recency-aware RAG combines bi-encoder + cross-encoder + a recency prior. Two-stage retrieval is now table stakes [1][2].',
      contradictions: [],
      new_sources: ['wiki/sessions/2026-04-15.md', 'wiki/sessions/2026-04-20.md'],
    });
```

Apply the same `current_understanding` → `primary` rename to the other five call sites (their `contradictions`/`new_sources` values and every other assertion in those tests are unchanged). The two `describe('synthesis failure', ...)` tests use a raw `LLMClient` object, not `fakeLLM`, and need no change — including the `'wraps a plain Error with the existing message (unchanged behavior)'` test, which must keep asserting `` `topic synthesis failed for ${topicPath}: model exploded` `` verbatim (see the discrepancy note at the top of this plan).

Add four new tests inside a new `describe('generalized region dispatch (B2b)', ...)` block, after the existing `'still bumps last_verified when no chunks retrieved'` test and before the `describe('synthesis failure', ...)` block:

```typescript
  describe('generalized region dispatch (B2b)', () => {
    it('decision: reads outcome as primary and context as secondary, and rewrites outcome', async () => {
      const decisionPath = 'wiki/decisions/adopt-litellm.md';
      await vault.ensureFolder('wiki/decisions');
      await vault.create(
        decisionPath,
        `---
id: d1
type: decision
title: Adopt LiteLLM proxy
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
stability: 30
half_life_domain: decisions
---
# Adopt LiteLLM proxy

## Context
%% begin:context %%
Needed multi-provider fallback.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sessions/a.md', chunk_index: 0, chunk_hash: 'h1', text: 'LiteLLM proxy shipped and is routing traffic in production' },
      ]);

      const llm = fakeLLM({
        primary: 'The LiteLLM proxy shipped and now routes all traffic in production [1].',
        contradictions: [],
        new_sources: ['wiki/sessions/a.md'],
      });

      const result = await refreshTopic({ vault, llm, store, config }, decisionPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      expect(result.retrievedCount).toBe(1);
      const { body } = parseNote(await vault.read(decisionPath));
      expect(body).toContain('The LiteLLM proxy shipped');
      expect(body).toContain('Needed multi-provider fallback.'); // context untouched (no secondary in response)
    });

    it('project: reads overview as primary and rewrites it', async () => {
      const hubPath = 'wiki/projects/second-brain/_index.md';
      await vault.ensureFolder('wiki/projects/second-brain');
      await vault.create(
        hubPath,
        `---
id: p1
type: project
title: Second Brain
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
stability: 30
---
# Second Brain

## Overview
%% begin:overview %%
Pending enrichment.
%% end:overview %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sessions/b.md', chunk_index: 0, chunk_hash: 'h2', text: 'Second Brain is a local-first knowledge system built on an Obsidian vault' },
      ]);

      const llm = fakeLLM({
        primary: 'Second Brain is a local-first knowledge system built on an Obsidian vault [1].',
        contradictions: [],
        new_sources: ['wiki/sessions/b.md'],
      });

      await refreshTopic({ vault, llm, store, config }, hubPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      const { body } = parseNote(await vault.read(hubPath));
      expect(body).toContain('local-first knowledge system built on an Obsidian vault');
      expect(body).not.toContain('Pending enrichment.');
    });

    it('an unmapped type (e.g. project_spec) bumps last_verified and clears pending_evidence without touching the body or calling the LLM', async () => {
      const specPath = 'wiki/projects/second-brain/technical.md';
      await vault.ensureFolder('wiki/projects/second-brain');
      await vault.create(
        specPath,
        `---
id: s1
type: project_spec
title: Second Brain technical
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
pending_evidence:
  - ref: wiki/sources/x.md
    at: 2026-04-01T00:00:00Z
pending_evidence_count: 1
---
# Second Brain technical
%% begin:content %%
Some agent-authored content.
%% end:content %%
`,
      );

      let called = false;
      const llm: LLMClient = {
        async complete() { called = true; return ''; },
        async extractStructured() { called = true; throw new Error('should not be called'); },
      };

      const result = await refreshTopic({ vault, llm, store, config }, specPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      expect(called).toBe(false);
      expect(result.retrievedCount).toBe(0);
      expect(result.pendingCleared).toBe(1);

      const { data, body } = parseNote(await vault.read(specPath));
      expect(body).toContain('Some agent-authored content.');
      expect(data.pending_evidence_count).toBe(0);
      expect(data.last_verified).toBeDefined();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/topic-refresh.test.ts`
Expected: FAIL — the six renamed-field tests fail because `refreshTopic` still parses against the hardcoded `SynthesisSchema` (`current_understanding`), and `synthesis.current_understanding` is now `undefined`/a Zod validation error since the test fixtures no longer send that key; the three new tests fail because `refreshTopic` doesn't yet dispatch on note `type`.

- [ ] **Step 3: Write minimal implementation**

Replace `src/intelligence/topic-refresh.ts` in full:

```typescript
// B2: Topic-page refresh — generalized (B2b) to cover concept, topic,
// decision, and project notes via the REFRESH_TARGETS registry, instead of
// assuming every refreshable note has a `current-understanding` region.
//
// Keeps a single note's primary richness region thorough and current:
// 1. Pull supporting chunks via B4 retrieval (top-K).
// 2. Rewrite the note type's primary protected region with CoD over the
//    retrieved evidence — no contradiction overwrite (Karpathy v2 rule).
// 3. Append unseen sources to a `sources` list.
// 4. Bump `last_verified`. If no contradictions surfaced, bump `stability` modestly.
// 5. Log + return a structured result for the queue.

import type { LLMClient } from '../enrichment/llm-client.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { EmbeddingStore } from '../embeddings/store.js';
import type { KarpathyConfig } from '../config/schema.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import {
  OPEN_TAG,
  CLOSE_TAG,
  updateProtectedRegion,
} from '../vault/protected-regions.js';
import { retrieve } from './retrieval.js';
import { defaultStability } from '../vault/half-life.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { extractOutlinks } from '../maintenance/backlinks.js';
import { buildEntityIndex } from '../ingest/entity-resolver.js';
import { markDirty } from '../maintenance/mark-dirty.js';
import { slugify } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';
import { TransientLLMError } from '../shared/errors.js';
import { REFRESH_TARGETS, type RefreshTarget, type RefreshSynthesisResult } from './refresh-targets.js';

const log = createLogger('topic-refresh');

/**
 * Legacy constant, kept exported for backward compatibility. The dispatch
 * below now resolves the region to rewrite per note `type` via
 * REFRESH_TARGETS[noteType] instead of assuming this one region name fits
 * every refreshable type (it still happens to be correct for concept/topic).
 */
export const CURRENT_UNDERSTANDING_REGION = 'current-understanding';
export const SOURCES_REGION = 'sources';

export interface RefreshOptions {
  topK?: number;
  /** When at least one contradiction is reported by the LLM, do NOT bump stability. */
  bumpStabilityFactor?: number; // multiplicative. default 1.1, capped at 4× domain default.
  nowMs?: number;
}

export interface RefreshDeps {
  vault: VaultAdapter;
  llm: LLMClient;
  store: EmbeddingStore;
  config: KarpathyConfig;
}

export interface RefreshResult {
  notePath: string;
  retrievedCount: number;
  contradictionCount: number;
  newSourcesAdded: number;
  stabilityBefore: number | undefined;
  stabilityAfter: number;
  lastVerified: string;
  /** Phase 1: count of pending_evidence entries cleared. */
  pendingCleared: number;
  /**
   * Phase 1: count of neighbor concept pages that were mark-dirtied as part
   * of the depth-1 cascade. 0 when `cascadeDepth: 0`.
   */
  neighborsCascaded: number;
}

export async function refreshTopic(
  deps: RefreshDeps,
  notePath: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const topK = options.topK ?? 12;
  const bumpFactor = options.bumpStabilityFactor ?? 1.1;
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const raw = await deps.vault.read(notePath);
  const { data, body } = parseNote(raw);
  const fm = data as Record<string, unknown>;
  const title = typeof fm.title === 'string' ? fm.title : notePath;
  const tldr = typeof fm.tldr === 'string' ? fm.tldr : '';
  const noteType = typeof fm.type === 'string' ? fm.type : 'topic';

  // Phase 1: capture how many pending entries we're about to clear. Computed
  // up front so every early-return branch below can report it accurately.
  const pendingCleared = Array.isArray(fm.pending_evidence)
    ? (fm.pending_evidence as unknown[]).length
    : 0;

  const target: RefreshTarget | undefined = (REFRESH_TARGETS as Record<string, RefreshTarget>)[noteType];

  if (!target) {
    // Unknown/unsupported type (e.g. project_spec — owned by
    // agent-synthesize-project instead). Bump last_verified and clear
    // pending_evidence so the queue doesn't spin forever, but do not touch
    // the body. Mirrors the "no evidence found" no-op branch below.
    fm.last_verified = nowIso;
    fm.pending_evidence = [];
    fm.pending_evidence_count = 0;
    await deps.vault.atomicWrite(notePath, serializeNote(fm, body));
    return {
      notePath,
      retrievedCount: 0,
      contradictionCount: 0,
      newSourcesAdded: 0,
      stabilityBefore: typeof fm.stability === 'number' ? fm.stability : undefined,
      stabilityAfter: typeof fm.stability === 'number' ? fm.stability : 0,
      lastVerified: nowIso,
      pendingCleared,
      neighborsCascaded: 0,
    };
  }

  const existingPrimary = extractRegion(body, target.primaryRegion) ?? '';
  const existingSecondary = target.secondaryRegion
    ? (extractRegion(body, target.secondaryRegion) ?? '')
    : undefined;

  // Stage 1: retrieve supporting evidence — exclude the note itself.
  const queryText = [title, tldr, existingPrimary, existingSecondary].filter(Boolean).join('\n');
  const hits = await retrieve({ store: deps.store, config: deps.config }, queryText, {
    topK,
    filter: (h) => h.doc_id !== notePath,
  });

  if (hits.length === 0) {
    // Nothing new to integrate — still bump last_verified and clear any
    // pending_evidence (we tried; the queue would otherwise re-trigger
    // refreshes forever) so we don't keep re-trying on every decay scan.
    fm.last_verified = nowIso;
    fm.pending_evidence = [];
    fm.pending_evidence_count = 0;
    await deps.vault.atomicWrite(notePath, serializeNote(fm, body));
    return {
      notePath,
      retrievedCount: 0,
      contradictionCount: 0,
      newSourcesAdded: 0,
      stabilityBefore: typeof fm.stability === 'number' ? fm.stability : undefined,
      stabilityAfter: typeof fm.stability === 'number' ? fm.stability : 0,
      lastVerified: nowIso,
      pendingCleared,
      neighborsCascaded: 0,
    };
  }

  // Stage 2: synthesis prompt, dispatched per note type.
  const evidenceBlock = hits
    .map((h, i) => `[${i + 1}] (${h.doc_id}, updated ${h.updated_at})\n${h.text.slice(0, 1200)}`)
    .join('\n\n');
  const prompt = target.buildPrompt({ title, existingPrimary, existingSecondary, evidenceBlock });

  let synthesis: RefreshSynthesisResult;
  try {
    synthesis = await deps.llm.extractStructured(prompt, target.responseSchema);
  } catch (err) {
    // Bail without modifying the note. Preserve TransientLLMError identity so
    // the job runner's indefinite-retry lane actually sees it. Message text
    // ("topic synthesis failed for...") is kept exactly as before this
    // generalization — an existing regression test below asserts it verbatim.
    if (err instanceof TransientLLMError) throw err;
    throw new Error(`topic synthesis failed for ${notePath}: ${(err as Error).message}`);
  }

  // Apply update.
  let nextBody = body;
  nextBody = upsertRegion(nextBody, target.primaryRegion, synthesis.primary.trim());
  if (target.secondaryRegion && synthesis.secondary) {
    nextBody = upsertRegion(nextBody, target.secondaryRegion, synthesis.secondary.trim());
  }

  const existingSources = parseSourcesRegion(extractRegion(nextBody, SOURCES_REGION) ?? '');
  const newSources = synthesis.new_sources.filter((s) => !existingSources.has(s));
  const sourcesBlock = formatSources(new Set([...existingSources, ...newSources]));
  nextBody = upsertRegion(nextBody, SOURCES_REGION, sourcesBlock);

  // Frontmatter updates.
  fm.last_verified = nowIso;
  const previousStability = typeof fm.stability === 'number' ? fm.stability : undefined;
  let nextStability = previousStability ?? defaultStability((fm.half_life_domain as string | undefined) ?? noteType);
  if (synthesis.contradictions.length > 0) {
    // Reset stability to half on contradiction (flag for human review).
    nextStability = Math.max(7, nextStability / 2);
  } else {
    const ceiling = (defaultStability((fm.half_life_domain as string | undefined) ?? noteType)) * 4;
    nextStability = Math.min(ceiling, nextStability * bumpFactor);
  }
  fm.stability = Math.round(nextStability);

  if (synthesis.contradictions.length > 0) {
    const existing = Array.isArray(fm.contradicts) ? (fm.contradicts as Array<Record<string, unknown>>) : [];
    fm.contradicts = [
      ...existing,
      ...synthesis.contradictions.map((c) => ({ ref: c.ref, reason: c.reason })),
    ];
  }

  // Track regions in protected_regions list.
  const regions = new Set<string>(
    Array.isArray(fm.protected_regions) ? (fm.protected_regions as string[]) : [],
  );
  regions.add(target.primaryRegion);
  if (target.secondaryRegion && synthesis.secondary) regions.add(target.secondaryRegion);
  regions.add(SOURCES_REGION);
  fm.protected_regions = [...regions];

  // Phase 1: clear the pending_evidence queue — we've just integrated it.
  fm.pending_evidence = [];
  fm.pending_evidence_count = 0;

  await deps.vault.atomicWrite(notePath, serializeNote(fm, nextBody));
  const { layoutFromConfig } = await import('../vault/paths.js');
  await appendLogEntry(
    deps.vault,
    {
      kind: 'topic:refresh',
      message: `${notePath} ← ${hits.length} sources, ${synthesis.contradictions.length} contradictions`,
      at: nowIso,
    },
    layoutFromConfig(deps.config),
  );

  // Phase 1: cascade depth-1. Mark-dirty the direct neighbors referenced in
  // the rewritten primary region. We do NOT auto-enqueue refresh — the
  // threshold gate inside `evaluate-refresh-candidates` will pull them in
  // only if their evidence (or staleness) accumulates. This keeps blast
  // radius bounded.
  let neighborsCascaded = 0;
  const cascadeDepth = deps.config.intelligence.refresh.cascadeDepth;
  if (cascadeDepth >= 1) {
    try {
      const linkedNames = extractOutlinks(synthesis.primary);
      if (linkedNames.length > 0) {
        const index = await buildEntityIndex(deps.vault, deps.config.layout);
        const seen = new Set<string>();
        for (const name of linkedNames) {
          // Resolve via slug match — same logic as resolveEntity. We accept
          // any matched path regardless of folder (concepts, projects, etc).
          const slug = slugify(name);
          const path =
            index.bySlug.get(slug) ??
            index.byCanonicalName.get(name.trim().toLowerCase()) ??
            index.byAlias.get(name.trim().toLowerCase());
          if (!path || path === notePath || seen.has(path)) continue;
          seen.add(path);
          try {
            const r = await markDirty(deps.vault, {
              notePath: path,
              ref: notePath,
              reason: 'cascade-from-refresh',
            });
            if (r.added) neighborsCascaded++;
          } catch (err) {
            log.warn('cascade markDirty failed', {
              path,
              error: (err as Error).message,
            });
          }
        }
      }
    } catch (err) {
      log.warn('cascade phase failed', { error: (err as Error).message });
    }
  }

  return {
    notePath,
    retrievedCount: hits.length,
    contradictionCount: synthesis.contradictions.length,
    newSourcesAdded: newSources.length,
    stabilityBefore: previousStability,
    stabilityAfter: fm.stability as number,
    lastVerified: nowIso,
    pendingCleared,
    neighborsCascaded,
  };
}


function extractRegion(body: string, regionId: string): string | null {
  const open = OPEN_TAG(regionId);
  const close = CLOSE_TAG(regionId);
  const oi = body.indexOf(open);
  const ci = oi >= 0 ? body.indexOf(close, oi + open.length) : -1;
  if (oi === -1 || ci === -1) return null;
  return body.slice(oi + open.length, ci).replace(/^\n/, '').replace(/\n$/, '');
}

function upsertRegion(body: string, regionId: string, content: string): string {
  return updateProtectedRegion(body, regionId, content);
}

function parseSourcesRegion(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[\[([^\]|]+)/);
    if (m) out.add(m[1].trim());
  }
  return out;
}

function formatSources(set: Set<string>): string {
  return [...set].sort().map((s) => `- [[${s}]]`).join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/topic-refresh.test.ts`
Expected: PASS (all tests, including the renamed and new ones)

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/topic-refresh.ts test/intelligence/topic-refresh.test.ts
git commit -m "feat(intelligence): generalize refreshTopic to dispatch region/prompt per note type via REFRESH_TARGETS"
```

---

### Task 5: `refreshTopic` — populate `related-concepts` (G4)

**Files:**
- Modify: `src/intelligence/topic-refresh.ts`
- Test: `test/intelligence/topic-refresh.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `hasProtectedRegion` from `src/vault/protected-regions.js` (pre-existing, not previously imported by this file).
- Produces: no new exports; `refreshTopic`'s public signature and `RefreshResult` shape are unchanged. The internal `resolveNeighbors` helper is module-private.

- [ ] **Step 1: Write the failing tests**

Add two new tests to `test/intelligence/topic-refresh.test.ts`, inside the `describe('generalized region dispatch (B2b)', ...)` block added in Task 4, after the `'an unmapped type...'` test:

```typescript
    it('G4: renders resolved neighbors into related-concepts for a topic note', async () => {
      const topicPath = 'wiki/topics/recency-aware-rag.md';
      await vault.ensureFolder('wiki/concepts');
      await vault.create(
        'wiki/concepts/cross-encoder.md',
        `---
id: c1
type: concept
title: Cross Encoder
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Cross Encoder
`,
      );
      await vault.create(
        topicPath,
        `---
id: t7
type: topic
title: Recency-aware RAG
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
---
# Recency-aware RAG
%% begin:current-understanding %%
Initial framing.
%% end:current-understanding %%

## Connected Concepts
%% begin:related-concepts %%
%% end:related-concepts %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sources/a.md', chunk_index: 0, chunk_hash: 'h1', text: 'cross encoder reranking helps' },
      ]);

      const llm = fakeLLM({
        primary: 'Two-stage retrieval pairs a bi-encoder with a [[Cross Encoder]] reranker [1].',
        contradictions: [],
        new_sources: ['wiki/sources/a.md'],
      });

      await refreshTopic({ vault, llm, store, config }, topicPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      const { body, data } = parseNote(await vault.read(topicPath));
      expect(body).toContain('%% begin:related-concepts %%\n- [[wiki/concepts/cross-encoder]]\n%% end:related-concepts %%');
      expect(data.protected_regions as string[]).toContain('related-concepts');
    });

    it('G4: writes the "no connected concepts" sentinel when zero neighbors resolve', async () => {
      const topicPath = 'wiki/topics/isolated.md';
      await vault.create(
        topicPath,
        `---
id: t8
type: topic
title: Isolated Topic
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
stability: 30
---
# Isolated Topic
%% begin:current-understanding %%
old
%% end:current-understanding %%

%% begin:related-concepts %%
%% end:related-concepts %%
`,
      );
      await store.upsert([
        { doc_id: 'wiki/sources/b.md', chunk_index: 0, chunk_hash: 'h2', text: 'unrelated evidence with no wikilinks' },
      ]);

      const llm = fakeLLM({
        primary: 'A self-contained rewrite with no links to any other note [1].',
        contradictions: [],
        new_sources: [],
      });

      await refreshTopic({ vault, llm, store, config }, topicPath, {
        nowMs: Date.parse('2026-05-01T00:00:00Z'),
      });

      const { body } = parseNote(await vault.read(topicPath));
      expect(body).toContain('_No connected concepts identified in the current synthesis._');
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/topic-refresh.test.ts`
Expected: FAIL — the two new tests fail because `related-concepts` is never touched yet; all pre-existing tests (including Task 4's) still pass at this point.

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/topic-refresh.ts`, change the protected-regions import:

```typescript
import {
  OPEN_TAG,
  CLOSE_TAG,
  updateProtectedRegion,
} from '../vault/protected-regions.js';
```

to:

```typescript
import {
  OPEN_TAG,
  CLOSE_TAG,
  updateProtectedRegion,
  hasProtectedRegion,
} from '../vault/protected-regions.js';
```

Insert a new helper function immediately before `export async function refreshTopic(`:

```typescript
/**
 * Resolve the direct neighbor notes referenced by wikilinks in `text`,
 * excluding self-references and duplicates. Shared by the depth-1 cascade
 * (mark-dirty on every resolved neighbor) and, for concept/topic notes only,
 * the `related-concepts` region render below — both need the identical
 * resolved list, so this factors out what used to be single-purpose inline
 * logic in the cascade block.
 */
async function resolveNeighbors(
  vault: VaultAdapter,
  config: KarpathyConfig,
  text: string,
  excludePath: string,
): Promise<Array<{ path: string; name: string }>> {
  const linkedNames = extractOutlinks(text);
  if (linkedNames.length === 0) return [];
  const index = await buildEntityIndex(vault, config.layout);
  const seen = new Set<string>();
  const neighbors: Array<{ path: string; name: string }> = [];
  for (const name of linkedNames) {
    const slug = slugify(name);
    const path =
      index.bySlug.get(slug) ??
      index.byCanonicalName.get(name.trim().toLowerCase()) ??
      index.byAlias.get(name.trim().toLowerCase());
    if (!path || path === excludePath || seen.has(path)) continue;
    seen.add(path);
    neighbors.push({ path, name });
  }
  return neighbors;
}
```

Replace the block from `  // Apply update.` through the end of the `if (cascadeDepth >= 1) { ... }` cascade block (i.e. everything between the catch block that assigns `synthesis` and the final `return {` statement) with:

```typescript
  // Resolve neighbor notes referenced in the freshly-synthesized primary
  // region up front — both the depth-1 cascade (mark-dirty) and, for
  // concept/topic notes, the `related-concepts` render below need the same
  // resolved list.
  const cascadeDepth = deps.config.intelligence.refresh.cascadeDepth;
  const isConceptOrTopic = noteType === 'concept' || noteType === 'topic';
  let resolvedNeighbors: Array<{ path: string; name: string }> = [];
  if (cascadeDepth >= 1 || isConceptOrTopic) {
    try {
      resolvedNeighbors = await resolveNeighbors(deps.vault, deps.config, synthesis.primary, notePath);
    } catch (err) {
      log.warn('neighbor resolution failed', { notePath, error: (err as Error).message });
    }
  }

  // Apply update.
  let nextBody = body;
  nextBody = upsertRegion(nextBody, target.primaryRegion, synthesis.primary.trim());
  if (target.secondaryRegion && synthesis.secondary) {
    nextBody = upsertRegion(nextBody, target.secondaryRegion, synthesis.secondary.trim());
  }

  const existingSources = parseSourcesRegion(extractRegion(nextBody, SOURCES_REGION) ?? '');
  const newSources = synthesis.new_sources.filter((s) => !existingSources.has(s));
  const sourcesBlock = formatSources(new Set([...existingSources, ...newSources]));
  nextBody = upsertRegion(nextBody, SOURCES_REGION, sourcesBlock);

  // G4: for concept/topic only, render the resolved neighbor list into
  // `related-concepts` — the same data the cascade below already computes,
  // instead of computing it and discarding it after the markDirty calls.
  let renderedRelatedConcepts = false;
  if (isConceptOrTopic && hasProtectedRegion(nextBody, 'related-concepts')) {
    const neighborLines = resolvedNeighbors.map((n) => `- [[${n.path.replace(/\.md$/, '')}]]`);
    nextBody = upsertRegion(
      nextBody,
      'related-concepts',
      neighborLines.length > 0
        ? neighborLines.join('\n')
        : '_No connected concepts identified in the current synthesis._',
    );
    renderedRelatedConcepts = true;
  }

  // Frontmatter updates.
  fm.last_verified = nowIso;
  const previousStability = typeof fm.stability === 'number' ? fm.stability : undefined;
  let nextStability = previousStability ?? defaultStability((fm.half_life_domain as string | undefined) ?? noteType);
  if (synthesis.contradictions.length > 0) {
    // Reset stability to half on contradiction (flag for human review).
    nextStability = Math.max(7, nextStability / 2);
  } else {
    const ceiling = (defaultStability((fm.half_life_domain as string | undefined) ?? noteType)) * 4;
    nextStability = Math.min(ceiling, nextStability * bumpFactor);
  }
  fm.stability = Math.round(nextStability);

  if (synthesis.contradictions.length > 0) {
    const existing = Array.isArray(fm.contradicts) ? (fm.contradicts as Array<Record<string, unknown>>) : [];
    fm.contradicts = [
      ...existing,
      ...synthesis.contradictions.map((c) => ({ ref: c.ref, reason: c.reason })),
    ];
  }

  // Track regions in protected_regions list.
  const regions = new Set<string>(
    Array.isArray(fm.protected_regions) ? (fm.protected_regions as string[]) : [],
  );
  regions.add(target.primaryRegion);
  if (target.secondaryRegion && synthesis.secondary) regions.add(target.secondaryRegion);
  regions.add(SOURCES_REGION);
  if (renderedRelatedConcepts) regions.add('related-concepts');
  fm.protected_regions = [...regions];

  // Phase 1: clear the pending_evidence queue — we've just integrated it.
  fm.pending_evidence = [];
  fm.pending_evidence_count = 0;

  await deps.vault.atomicWrite(notePath, serializeNote(fm, nextBody));
  const { layoutFromConfig } = await import('../vault/paths.js');
  await appendLogEntry(
    deps.vault,
    {
      kind: 'topic:refresh',
      message: `${notePath} ← ${hits.length} sources, ${synthesis.contradictions.length} contradictions`,
      at: nowIso,
    },
    layoutFromConfig(deps.config),
  );

  // Phase 1: cascade depth-1. Mark-dirty the direct neighbors resolved above.
  // We do NOT auto-enqueue refresh — the threshold gate inside
  // `evaluate-refresh-candidates` will pull them in only if their evidence
  // (or staleness) accumulates. This keeps blast radius bounded.
  let neighborsCascaded = 0;
  if (cascadeDepth >= 1) {
    for (const { path } of resolvedNeighbors) {
      try {
        const r = await markDirty(deps.vault, {
          notePath: path,
          ref: notePath,
          reason: 'cascade-from-refresh',
        });
        if (r.added) neighborsCascaded++;
      } catch (err) {
        log.warn('cascade markDirty failed', { path, error: (err as Error).message });
      }
    }
  }
```

(The final `return { ... }` statement below this block is unchanged from Task 4.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/topic-refresh.test.ts`
Expected: PASS (all tests, including every pre-existing Phase-1 cascade test — none of their fixtures declare a `related-concepts` region, so `hasProtectedRegion` is `false` for them and their behavior/assertions are unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/topic-refresh.ts test/intelligence/topic-refresh.test.ts
git commit -m "feat(intelligence): populate related-concepts from the refresh pass's resolved neighbor list"
```

---

### Task 6: `decay-scan.ts` thin-content detection

**Files:**
- Modify: `src/jobs/types.ts` (add `'thin-content'` to `JobTrigger` — see discrepancy note at top of plan)
- Modify: `src/intelligence/decay-scan.ts`
- Test: `test/intelligence/decay-scan.test.ts` (extend existing file, `describe('decay-scan (C1)', ...)` block)

**Interfaces:**
- Consumes: `REFRESH_TARGETS`, `isPlaceholderContent`, `RefreshTarget` from Task 3; `getProtectedRegion` from `src/vault/protected-regions.js` (pre-existing).
- Produces: `DecayScanResult` gains `thinContentEnqueued: number` — no other exported shape changes. Consumed by no other task in this plan (observability-only field).

- [ ] **Step 1: Write the failing tests**

In `src/jobs/types.ts`, change:

```typescript
export const JobTrigger = z.enum(['file-watcher', 'hook', 'timer', 'cli', 'cascade']);
```

to:

```typescript
export const JobTrigger = z.enum(['file-watcher', 'hook', 'timer', 'cli', 'cascade', 'thin-content']);
```

(No test needed for this one-line enum addition — it's exercised transitively by the decay-scan tests below, which would otherwise fail with a `ZodError` from `queue.ts`'s job-creation validation. There is no dedicated `job-trigger` unit test file in this repo to extend.)

Add new tests to `test/intelligence/decay-scan.test.ts`, inside the existing `describe('decay-scan (C1)', ...)` block, after the `'does not enqueue refresh for fresh notes'` test:

```typescript
  it('a thin (placeholder outcome) decision note above the retrievability threshold still enqueues, via thin-content', async () => {
    await vault.ensureFolder('wiki/decisions');
    const today = new Date().toISOString();
    await vault.create(
      'wiki/decisions/thin.md',
      `---
id: d1
type: decision
title: Thin decision
created_at: ${today}
updated_at: ${today}
last_verified: ${today}
stability: 365
half_life_domain: decisions
---
## Context
%% begin:context %%
Some context.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.thinContentEnqueued).toBe(1);
    expect(result.refreshEnqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].trigger).toBe('thin-content');
    expect(enqueued[0].priority).toBe(80);
  });

  it('a thin note that is ALSO below the retrievability threshold enqueues exactly once', async () => {
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/decisions/thin-and-stale.md',
      `---
id: d2
type: decision
title: Thin and stale
created_at: 2025-01-01T00:00:00Z
updated_at: 2025-01-01T00:00:00Z
last_verified: 2025-01-01T00:00:00Z
stability: 30
half_life_domain: decisions
---
## Outcome
%% begin:outcome %%
%% end:outcome %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(enqueued).toHaveLength(1);
    expect(result.thinContentEnqueued).toBe(1);
    expect(result.refreshEnqueued).toBe(1);
  });

  it('a stale project_spec note is scored but does NOT enqueue topic-refresh (no REFRESH_TARGETS entry)', async () => {
    await vault.ensureFolder('wiki/projects/proj-a');
    await vault.create(
      'wiki/projects/proj-a/technical.md',
      `---
id: s1
type: project_spec
title: proj-a technical
created_at: 2025-01-01T00:00:00Z
updated_at: 2025-01-01T00:00:00Z
last_verified: 2025-01-01T00:00:00Z
stability: 30
---
%% begin:content %%
Agent-authored content.
%% end:content %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(enqueued).toHaveLength(0);
    expect(result.refreshEnqueued).toBe(0);
    const { data } = parseNote(await vault.read('wiki/projects/proj-a/technical.md'));
    expect(typeof data.retrievability).toBe('number'); // still scored
  });

  it('a topic with rich current-understanding but an empty related-concepts region is still flagged thin', async () => {
    await vault.ensureFolder('wiki/topics');
    const today = new Date().toISOString();
    await vault.create(
      'wiki/topics/rich.md',
      `---
id: t1
type: topic
title: Rich topic
created_at: ${today}
updated_at: ${today}
last_verified: ${today}
stability: 365
half_life_domain: topic
---
%% begin:current-understanding %%
${'A'.repeat(200)}
%% end:current-understanding %%

%% begin:related-concepts %%
%% end:related-concepts %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.thinContentEnqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: FAIL — `result.thinContentEnqueued` is `undefined`; the fresh-but-thin note isn't enqueued at all (today's code only checks `r < refreshThreshold`); the stale `project_spec` note IS enqueued today (pre-fix), so that test fails in the opposite direction.

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/decay-scan.ts`, add to the imports:

```typescript
import { REFRESH_TARGETS, isPlaceholderContent, type RefreshTarget } from './refresh-targets.js';
import { getProtectedRegion } from '../vault/protected-regions.js';
```

Add `thinContentEnqueued: number` to `DecayScanResult`:

```typescript
export interface DecayScanResult {
  scanned: number;
  refreshEnqueued: number;
  thinContentEnqueued: number;
  archiveCandidates: string[];
  researchCandidates: number;
}
```

In `runDecayScan`, initialize the new field:

```typescript
  const result: DecayScanResult = {
    scanned: 0,
    refreshEnqueued: 0,
    thinContentEnqueued: 0,
    archiveCandidates: [],
    researchCandidates: 0,
  };
```

Replace:

```typescript
      if (r < refreshThreshold) {
        await deps.enqueue({
          type: 'topic-refresh',
          targetPath: path,
          trigger: 'cascade',
          priority: 75,
          dedupeKey: `topic-refresh:${path}`,
        });
        result.refreshEnqueued += 1;
      }
```

with:

```typescript
      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
      const relatedConceptsEmpty =
        (type === 'concept' || type === 'topic') &&
        !(getProtectedRegion(body, 'related-concepts') ?? '').trim();
      const isThin =
        (target ? isPlaceholderContent(target, getProtectedRegion(body, target.primaryRegion)) : false) ||
        relatedConceptsEmpty;

      if ((r < refreshThreshold || isThin) && target) {
        await deps.enqueue({
          type: 'topic-refresh',
          targetPath: path,
          trigger: isThin ? 'thin-content' : 'cascade',
          priority: isThin ? 80 : 75, // thin-content backfill takes slight priority
          dedupeKey: `topic-refresh:${path}`,
        });
        result.refreshEnqueued += 1;
        if (isThin) result.thinContentEnqueued += 1;
      }
```

This also closes the `project_spec` corruption risk noted in the design's §5/§6: `target` is `undefined` for `project_spec` (it has no `REFRESH_TARGETS` entry), so the `&& target` guard now prevents `topic-refresh` from ever being enqueued for that type via decay-scan — it's still scored (retrievability stamped) but no longer routed into a refresh pass that would corrupt it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: PASS (all tests, including the pre-existing `'enqueues refresh for stale concept...'` test — that fixture's concept note has no `current-understanding` region marker at all, so it was already incidentally "thin"; it doesn't assert on `trigger` or `thinContentEnqueued`, so it remains valid unmodified)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/types.ts src/intelligence/decay-scan.ts test/intelligence/decay-scan.test.ts
git commit -m "feat(intelligence): add decay-scan thin-content detection and a 'thin-content' job trigger"
```

---

### Task 7: `rot-scan.ts` thin-content reporting

**Files:**
- Modify: `src/intelligence/rot-scan.ts`
- Test: `test/intelligence/decay-scan.test.ts` (extend existing file, `describe('rot-scan (C2)', ...)` block — see discrepancy note at top of plan: there is no separate `rot-scan.test.ts`)

**Interfaces:**
- Consumes: `REFRESH_TARGETS`, `isPlaceholderContent`, `RefreshTarget` from Task 3; `getProtectedRegion` from `src/vault/protected-regions.js`.
- Produces: `RotScanResult` gains `thinCandidates: ThinContentEntry[]`; new exported interface `ThinContentEntry { path: string; title: string; region: string }`. Purely additive/reporting — no side effects, no other task consumes this.

- [ ] **Step 1: Write the failing tests**

Add new tests to `test/intelligence/decay-scan.test.ts`, inside the existing `describe('rot-scan (C2)', ...)` block, after the `'flags stale + orphan + low-confidence as candidates'` test:

```typescript
  it('flags a note with a placeholder primary region as thin content, in a separate table from rot candidates', async () => {
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/decisions/thin-decision.md',
      `---
id: d1
type: decision
title: Thin decision
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
## Outcome
%% begin:outcome %%
%% end:outcome %%

%% begin:backlinks %%
- [[wiki/something]]
%% end:backlinks %%`,
    );

    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));

    expect(result.thinCandidates.map((c) => c.path)).toContain('wiki/decisions/thin-decision.md');
    expect(result.thinCandidates.find((c) => c.path === 'wiki/decisions/thin-decision.md')?.region).toBe('outcome');
    // Fresh + high-confidence + has an inbound marker → NOT a rot candidate.
    expect(result.candidates.map((c) => c.path)).not.toContain('wiki/decisions/thin-decision.md');

    const report = await vault.read(result.reportPath);
    expect(report).toContain('Thin content');
    expect(report).toContain('thin-decision');
  });

  it('does not flag a note with a substantial outcome as thin', async () => {
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/decisions/resolved-decision.md',
      `---
id: d2
type: decision
title: Resolved decision
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
## Outcome
%% begin:outcome %%
Shipped in v2 and adopted by all downstream consumers.
%% end:outcome %%`,
    );

    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));
    expect(result.thinCandidates.map((c) => c.path)).not.toContain('wiki/decisions/resolved-decision.md');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: FAIL — `result.thinCandidates` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/rot-scan.ts`, change the imports:

```typescript
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
```

to:

```typescript
import { OPEN_TAG, CLOSE_TAG, getProtectedRegion } from '../vault/protected-regions.js';
import { REFRESH_TARGETS, isPlaceholderContent, type RefreshTarget } from './refresh-targets.js';
```

Add a second region id constant right after `const REGION_ID = 'vault-health';`:

```typescript
const THIN_REGION_ID = 'vault-health-thin-content';
```

Add the new interface right after `RotEntry`:

```typescript
export interface ThinContentEntry {
  path: string;
  title: string;
  region: string;
}
```

Add `thinCandidates` to `RotScanResult`:

```typescript
export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  reportPath: string;
}
```

In `runRotScan`, initialize the array alongside `candidates`:

```typescript
  const candidates: RotEntry[] = [];
  const thinCandidates: ThinContentEntry[] = [];
  let scanned = 0;
```

Inside the per-file loop, after the existing rot-candidate `if (score >= 2) { ... }` block, add:

```typescript
      const type = asString(fm.type);
      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
      if (target && isPlaceholderContent(target, getProtectedRegion(body, target.primaryRegion))) {
        thinCandidates.push({ path, title: asString(fm.title) || path, region: target.primaryRegion });
      }
```

Change the `renderReport` call and `return`:

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  await vault.ensureFolder(layout.system);
  await vault.atomicWrite(healthPath, renderReport(scanned, candidates, thinCandidates, nowMs));
  return { scanned, candidates, thinCandidates, reportPath: healthPath };
```

Replace `renderReport` in full:

```typescript
function renderReport(
  scanned: number,
  candidates: RotEntry[],
  thinCandidates: ThinContentEntry[],
  nowMs: number,
): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: index');
  lines.push('title: Vault health');
  lines.push(`updated_at: ${new Date(nowMs).toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push('# Vault health');
  lines.push('');
  lines.push(`Scanned ${scanned} notes. ${candidates.length} candidates flagged as potential rot.`);
  lines.push('');
  lines.push(OPEN_TAG(REGION_ID));
  if (candidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path | Age (days) | Confidence | Inbound | Retrievability |');
    lines.push('|------|-----------:|------------|---------|----------------|');
    for (const c of candidates) {
      const r = c.retrievability !== undefined ? c.retrievability.toFixed(2) : '—';
      lines.push(
        `| [[${c.path.replace(/\.md$/, '')}|${c.title}]] | ${c.ageDays} | ${c.confidence} | ${c.hasInboundMarker ? 'yes' : 'no'} | ${r} |`,
      );
    }
  }
  lines.push(CLOSE_TAG(REGION_ID));
  lines.push('');
  lines.push('## Thin content');
  lines.push('');
  lines.push(`${thinCandidates.length} notes have a placeholder or near-empty primary region.`);
  lines.push('');
  lines.push(OPEN_TAG(THIN_REGION_ID));
  if (thinCandidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path | Region |');
    lines.push('|------|--------|');
    for (const t of thinCandidates) {
      lines.push(`| [[${t.path.replace(/\.md$/, '')}|${t.title}]] | ${t.region} |`);
    }
  }
  lines.push(CLOSE_TAG(THIN_REGION_ID));
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: PASS (all tests, including the pre-existing rot-scan test, which doesn't reference `thinCandidates`)

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/rot-scan.ts test/intelligence/decay-scan.test.ts
git commit -m "feat(intelligence): add a thin-content table to the rot-scan vault-health report"
```

---

### Task 8: `concept-glossary.ts` dedup + threshold synthesis

**Files:**
- Modify: `src/maintenance/concept-glossary.ts`
- Test: `test/maintenance/concept-glossary.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `UpsertConceptMentionResult { mentionCount: number; crossedSynthesisThreshold: boolean }` (new return type for `upsertConceptMention`, previously `Promise<void>`); `synthesizeConceptEntry(vault, layout, conceptName, llm): Promise<void>` (new export) — both consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

Add to `test/maintenance/concept-glossary.test.ts`. First, update the imports at the top of the file:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';
import { upsertConceptMention, synthesizeConceptEntry } from '../../src/maintenance/concept-glossary.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
```

Add a helper function and new tests at the end of the `describe('concept-glossary', ...)` block (before the final closing `});`):

```typescript
  function fakeSynthesisLLM(text: string): LLMClient {
    return {
      async complete() { return ''; },
      async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
        return schema.parse({ synthesis: text });
      },
    };
  }

  it('skips a mention with identical gloss text from a different sourceRef (content-aware dedup)', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'RCAs', gloss: 'A structured investigation into the root cause of an incident.', sourceRef: 'wiki/topics/a.md',
    });
    const result = await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'RCAs', gloss: 'A structured investigation into the root cause of an incident.', sourceRef: 'wiki/topics/b.md',
    });

    expect(result.mentionCount).toBe(1);
    const content = await vault.read('wiki/concepts/glossary.md');
    const mentionLines = content.split('\n').filter((l) => l.startsWith('- "'));
    expect(mentionLines).toHaveLength(1);
  });

  it('crossedSynthesisThreshold fires at the threshold, resets, and fires again a full threshold later', async () => {
    const opts = { synthesisThreshold: 3 };
    const r1 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g1', sourceRef: 'a.md' }, opts);
    expect(r1.crossedSynthesisThreshold).toBe(false);
    const r2 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g2', sourceRef: 'b.md' }, opts);
    expect(r2.crossedSynthesisThreshold).toBe(false);
    const r3 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g3', sourceRef: 'c.md' }, opts);
    expect(r3.crossedSynthesisThreshold).toBe(true);

    await synthesizeConceptEntry(vault, DEFAULT_LAYOUT, 'X', fakeSynthesisLLM('Rollup after 3 mentions.'));

    const r4 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g4', sourceRef: 'd.md' }, opts);
    expect(r4.crossedSynthesisThreshold).toBe(false); // 4 mentions, +1 since synthesis at 3
    const r5 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g5', sourceRef: 'e.md' }, opts);
    expect(r5.crossedSynthesisThreshold).toBe(false); // 5 mentions, +2 since synthesis at 3
    const r6 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g6', sourceRef: 'f.md' }, opts);
    expect(r6.crossedSynthesisThreshold).toBe(true); // 6 mentions, +3 since synthesis at 3
  });

  it('synthesizeConceptEntry adds a synthesis line above the mention list without altering mentions', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g2', sourceRef: 'b.md' });

    await synthesizeConceptEntry(vault, DEFAULT_LAYOUT, 'Efficiency', fakeSynthesisLLM('A benchmark used across audits.'));

    const content = await vault.read('wiki/concepts/glossary.md');
    expect(content).toContain('*A benchmark used across audits. (as of 2 mentions)*');
    expect(content).toContain('"g1"');
    expect(content).toContain('"g2"');
  });

  it('parseGlossary round-trips a synthesis line through a real reparse cycle', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    await synthesizeConceptEntry(vault, DEFAULT_LAYOUT, 'Efficiency', fakeSynthesisLLM('A recurring benchmark.'));

    // Force a real reparse by upserting a different concept afterward.
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Unrelated', gloss: 'g2', sourceRef: 'b.md' });

    const content = await vault.read('wiki/concepts/glossary.md');
    expect(content).toContain('*A recurring benchmark. (as of 1 mentions)*');

    // synthesizedAtCount (1) must have round-tripped through the reparse:
    // growing to 2 mentions with threshold 2 is only +1 since synthesis, not +2.
    const result = await upsertConceptMention(
      vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g3', sourceRef: 'c.md' }, { synthesisThreshold: 2 },
    );
    expect(result.crossedSynthesisThreshold).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/maintenance/concept-glossary.test.ts`
Expected: FAIL — `upsertConceptMention` returns `undefined` (not `{ mentionCount, crossedSynthesisThreshold }`), and `synthesizeConceptEntry` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Replace `src/maintenance/concept-glossary.ts` in full:

```typescript
// Concept glossary at `{layout.wiki}/concepts/glossary.md`.
//
// Concepts no longer become individual wiki pages. Every concept mention
// across all ingested sources lands as a bulleted line under that concept's
// heading in this one file. Deliberately not `_index.md` — that file is
// auto-rebuilt by rebuildVaultIndex() and this glossary needs to survive
// that rebuild untouched.
//
// B2b: dedup is now content-aware (not just sourceRef-aware), and concepts
// that accumulate enough mentions get an LLM-synthesized rollup line
// (`synthesis`) rendered above their raw mention list.

import { z } from 'zod';
import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
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
  /** LLM-synthesized rollup line, present once mention count has crossed the threshold. */
  synthesis?: string;
  /** Mention count at last synthesis, to detect "grown enough to re-synthesize". */
  synthesizedAtCount?: number;
}

export interface UpsertConceptMentionResult {
  mentionCount: number;
  /**
   * True exactly once, the ingest call that pushes mentionCount to (or past)
   * the configured threshold for the first time, or that grows it by another
   * full threshold-worth since the last synthesis.
   */
  crossedSynthesisThreshold: boolean;
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
    const synthesisMatch = line.match(/^\*(?!Last mentioned:)(.+)\*$/);
    if (synthesisMatch) {
      const rawSynthesisLine = synthesisMatch[1];
      const countMatch = rawSynthesisLine.match(/^(.*) \(as of (\d+) mentions?\)$/);
      if (countMatch) {
        current.synthesis = countMatch[1].trim();
        current.synthesizedAtCount = Number(countMatch[2]);
      } else {
        current.synthesis = rawSynthesisLine.trim();
      }
      continue;
    }
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
      const synthesisLine = entry.synthesis
        ? `*${entry.synthesis} (as of ${entry.synthesizedAtCount ?? entry.mentions.length} mentions)*\n`
        : '';
      const mentionLines = entry.mentions
        .map((m) => `- "${m.gloss}" — [[${m.sourceRef}]] (${m.date})`)
        .join('\n');
      return `## ${entry.name}\n*Last mentioned: ${lastMention?.date ?? 'unknown'}*\n${synthesisLine}${mentionLines}`;
    })
    .join('\n\n');
}

async function readEntries(vault: VaultAdapter, path: string): Promise<Map<string, ConceptEntry>> {
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
  return parseGlossary(inner);
}

async function writeEntries(vault: VaultAdapter, path: string, entries: Map<string, ConceptEntry>): Promise<void> {
  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);
  const body = `${HEADER}${open}\n${renderGlossary(entries)}\n${close}\n`;
  await vault.atomicWrite(path, body);
}

export async function upsertConceptMention(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
  concept: { name: string; gloss: string; sourceRef: string },
  options: { synthesisThreshold?: number } = {},
): Promise<UpsertConceptMentionResult> {
  const path = conceptGlossaryPath(layout);
  await vault.ensureFolder(`${layout.wiki}/concepts`);

  const entries = await readEntries(vault, path);
  const key = normalizeName(concept.name);
  const sourceRefSlug = extractSlug(concept.sourceRef);
  const today = new Date().toISOString().slice(0, 10);
  // The mention format is strictly single-line (parsed by a regex anchored
  // per line), but glosses can come from LLM-generated multi-paragraph prose
  // (e.g. entity-compiler.ts's "definition" region). A newline would break
  // the rendered line across multiple unparseable lines, silently dropping
  // the mention on the next read-parse-rewrite cycle. Normalize up front.
  const normalizedGloss = concept.gloss.replace(/\s*\n+\s*/g, ' ').trim();

  const existing = entries.get(key);
  const sameSourceRef = existing?.mentions.some((m) => m.sourceRef === sourceRefSlug) ?? false;
  const sameGlossText =
    existing?.mentions.some((m) => m.gloss.trim().toLowerCase() === normalizedGloss.toLowerCase()) ?? false;
  if (sameSourceRef || sameGlossText) {
    return { mentionCount: existing?.mentions.length ?? 0, crossedSynthesisThreshold: false };
  }

  let updatedEntry: ConceptEntry;
  if (existing) {
    existing.mentions.push({ gloss: normalizedGloss, sourceRef: sourceRefSlug, date: today });
    updatedEntry = existing;
  } else {
    updatedEntry = { name: concept.name, mentions: [{ gloss: normalizedGloss, sourceRef: sourceRefSlug, date: today }] };
    entries.set(key, updatedEntry);
  }

  const threshold = options.synthesisThreshold ?? 3;
  const mentionCount = updatedEntry.mentions.length;
  const crossedSynthesisThreshold =
    mentionCount >= threshold &&
    (updatedEntry.synthesizedAtCount === undefined || mentionCount >= updatedEntry.synthesizedAtCount + threshold);

  await writeEntries(vault, path, entries);
  return { mentionCount, crossedSynthesisThreshold };
}

const GlossarySynthesisSchema = z.object({ synthesis: z.string() });

function buildGlossarySynthesisPrompt(name: string, mentions: ConceptMention[]): string {
  const list = mentions.map((m, i) => `[${i + 1}] ${m.gloss}`).join('\n');
  return `Multiple sources in a personal knowledge base have mentioned the concept "${name}". Write ONE 1-2 sentence description that captures what this concept means and why it keeps coming up, grounded only in the mentions below — do not invent detail beyond what they state.

Mentions:
${list}

Output ONLY a single fenced \`\`\`json block:
{"synthesis": "..."}`;
}

/**
 * Re-read the glossary, synthesize a short rollup line for `conceptName`
 * from its current mention list, and write it back — a normal
 * read-modify-write cycle reusing the same parseGlossary/renderGlossary
 * round-trip `upsertConceptMention` already uses. No-ops (does not call the
 * LLM) if the concept has no mentions on file, which should not normally
 * happen since this is only ever called after `upsertConceptMention`
 * reports `crossedSynthesisThreshold: true`.
 */
export async function synthesizeConceptEntry(
  vault: VaultAdapter,
  layout: VaultLayout,
  conceptName: string,
  llm: LLMClient,
): Promise<void> {
  const path = conceptGlossaryPath(layout);
  const entries = await readEntries(vault, path);
  const key = normalizeName(conceptName);
  const entry = entries.get(key);
  if (!entry || entry.mentions.length === 0) return;

  const prompt = buildGlossarySynthesisPrompt(entry.name, entry.mentions);
  const parsed = await llm.extractStructured(prompt, GlossarySynthesisSchema);

  entry.synthesis = parsed.synthesis.trim();
  entry.synthesizedAtCount = entry.mentions.length;

  await writeEntries(vault, path, entries);
}
```

Note: this replacement factors the previously-inline glossary-file read/write logic (which lived directly in `upsertConceptMention`) into shared `readEntries`/`writeEntries` helpers, since `synthesizeConceptEntry` now needs the identical read-modify-write cycle. This is a refactor beyond the design doc's literal snippet (which duplicated the open/close-tag slicing logic inline in a sketched `synthesizeConceptEntry`), done to avoid two copies of the same parsing logic drifting apart.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/maintenance/concept-glossary.test.ts`
Expected: PASS (all tests, including the five pre-existing ones — none of them inspect the return value of `upsertConceptMention`, so the `void` → `UpsertConceptMentionResult` signature change doesn't break them)

- [ ] **Step 5: Commit**

```bash
git add src/maintenance/concept-glossary.ts test/maintenance/concept-glossary.test.ts
git commit -m "feat(maintenance): make concept-glossary dedup content-aware and add threshold-triggered synthesis"
```

---

### Task 9: `glossary-synthesize` job + `compile-entities.ts` wiring

**Files:**
- Modify: `src/jobs/types.ts` (add `'glossary-synthesize'` to `JobType`)
- Create: `src/jobs/handlers/glossary-synthesize.ts`
- Modify: `src/jobs/handlers/index.ts`
- Modify: `src/jobs/handlers/compile-entities.ts`
- Test: `test/jobs/handlers/glossary-synthesize.test.ts` (new file)
- Test: `test/jobs/handlers/compile-entities.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `synthesizeConceptEntry`, `UpsertConceptMentionResult` from Task 8; `intelligence.richness.{enabled,glossarySynthesisThreshold}` from Task 2; `createLLMFromConfig` (pre-existing, tier-aware per the already-merged B2a work), `createBudgetTrackerFromConfig`, `resolveStateDir`, `TransientLLMError` (all pre-existing).
- Produces: `glossarySynthesizeHandler: JobHandler` — registered under the new `'glossary-synthesize'` job type. Leaf of this plan's dependency graph; nothing else consumes it.

- [ ] **Step 1: Write the failing tests**

In `src/jobs/types.ts`, add `'glossary-synthesize'` to the `JobType` enum, right after `'migrate-concept-glossary',`:

```typescript
  'migrate-concept-glossary',
  'glossary-synthesize',
```

Create `test/jobs/handlers/glossary-synthesize.test.ts` in full:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { upsertConceptMention, conceptGlossaryPath } from '../../../src/maintenance/concept-glossary.js';
import { DEFAULT_LAYOUT } from '../../../src/vault/paths.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { TransientLLMError } from '../../../src/shared/errors.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

vi.mock('../../../src/enrichment/llm-factory.js', () => ({
  createLLMFromConfig: vi.fn(),
}));

import { createLLMFromConfig } from '../../../src/enrichment/llm-factory.js';
import { glossarySynthesizeHandler } from '../../../src/jobs/handlers/glossary-synthesize.js';

function fakeClient(text: string) {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({ synthesis: text });
    },
  };
}

function makeJob(conceptName?: string): Job {
  return {
    id: 'test-glossary-synth', type: 'glossary-synthesize', status: 'running', priority: 40,
    payload: conceptName ? { conceptName } : {}, trigger: 'cascade',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('glossary-synthesize handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-glossary-synth-'));
    vault = createFsAdapter(dir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, projectRoot: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: {} as any,
      config,
    };
  }

  it('does nothing when conceptName is missing from the payload', async () => {
    await glossarySynthesizeHandler.execute(makeJob(), makeContext());
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('does nothing when intelligence.richness.enabled is false', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    const ctx = makeContext({ intelligence: { richness: { enabled: false } } });
    await glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx);
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('skips without constructing an LLM client when the fast-tier budget is exhausted', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    const ctx = makeContext({ intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 0, heavy: 0 } } } });
    await glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx);
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('synthesizes and writes the rollup line when everything is enabled', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    vi.mocked(createLLMFromConfig).mockReturnValue(fakeClient('A recurring audit benchmark.') as never);

    const ctx = makeContext();
    await glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx);

    expect(createLLMFromConfig).toHaveBeenCalledWith(ctx.config, expect.any(String), 'fast');
    const content = await vault.read(conceptGlossaryPath(DEFAULT_LAYOUT));
    expect(content).toContain('A recurring audit benchmark. (as of 1 mentions)');
  });

  it('lets a TransientLLMError from the synthesis call propagate out of execute()', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    vi.mocked(createLLMFromConfig).mockReturnValue({
      async complete() { return ''; },
      async extractStructured() { throw new TransientLLMError('outage'); },
    } as never);

    const ctx = makeContext();
    await expect(glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('logs and swallows a non-transient synthesis failure instead of throwing', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    vi.mocked(createLLMFromConfig).mockReturnValue({
      async complete() { return ''; },
      async extractStructured() { throw new Error('malformed JSON'); },
    } as never);

    const ctx = makeContext();
    await expect(glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx)).resolves.toBeUndefined();
  });
});
```

Add to `test/jobs/handlers/compile-entities.test.ts` a new `describe` block, after the existing `describe('compile-entities handler — self-reference filtering', ...)` block:

```typescript
describe('compile-entities handler — glossary synthesis threshold', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => {
        enqueued.push(input);
        return {
          ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
          retryCount: 0, maxRetries: 3, debounceMs: 0,
          priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
        } as Job;
      },
      llm: makeLLM(), config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-glossary-threshold-'));
    vault = createFsAdapter(dir);
    enqueued = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeSummary(path: string): Promise<void> {
    await vault.ensureFolder('sources');
    await vault.create(
      path,
      serializeNote(
        { id: 's1', type: 'source_summary', title: 'S', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: 'some-project' },
        '\nBody.\n',
      ),
    );
  }

  it('enqueues glossary-synthesize once a concept mention crosses the configured threshold', async () => {
    const ctx = makeCtx({ intelligence: { richness: { glossarySynthesisThreshold: 2 } } });
    await makeSummary('sources/s1.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/s1.md', { concepts: [{ name: 'Efficiency', definition: 'first', confidence: 0.9 }] }),
      ctx,
    );
    await makeSummary('sources/s2.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/s2.md', { concepts: [{ name: 'Efficiency', definition: 'second', confidence: 0.9 }] }),
      ctx,
    );

    const glossaryJobs = enqueued.filter((j) => j.type === 'glossary-synthesize');
    expect(glossaryJobs).toHaveLength(1);
    expect(glossaryJobs[0].payload).toEqual({ conceptName: 'Efficiency' });
    expect(glossaryJobs[0].dedupeKey).toBe('glossary-synthesize:efficiency');
  });

  it('does not enqueue glossary-synthesize when the threshold is not crossed', async () => {
    const ctx = makeCtx({ intelligence: { richness: { glossarySynthesisThreshold: 5 } } });
    await makeSummary('sources/s1.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/s1.md', { concepts: [{ name: 'Efficiency', definition: 'first', confidence: 0.9 }] }),
      ctx,
    );

    expect(enqueued.filter((j) => j.type === 'glossary-synthesize')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/jobs/handlers/glossary-synthesize.test.ts test/jobs/handlers/compile-entities.test.ts`
Expected: FAIL — `src/jobs/handlers/glossary-synthesize.js` doesn't exist yet (import error); `compile-entities.ts` never enqueues `glossary-synthesize` yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/jobs/handlers/glossary-synthesize.ts`:

```typescript
// B2b: Glossary threshold synthesis.
//
// Fires when a concept's mention count crosses
// `intelligence.richness.glossarySynthesisThreshold` (see compile-entities.ts).
// Budget-gated on the `fast` tier — this is a short, single-paragraph
// rollup, not a full evidence-grounded refresh like topic-refresh.

import type { JobHandler } from '../types.js';
import { createLLMFromConfig } from '../../enrichment/llm-factory.js';
import { createBudgetTrackerFromConfig } from '../../shared/budget.js';
import { resolveStateDir } from '../../config/defaults.js';
import { synthesizeConceptEntry } from '../../maintenance/concept-glossary.js';
import { TransientLLMError } from '../../shared/errors.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('glossary-synthesize');

export const glossarySynthesizeHandler: JobHandler = {
  async execute(job, ctx) {
    const conceptName = job.payload.conceptName as string | undefined;
    if (!conceptName) {
      log.warn('glossary-synthesize: missing conceptName');
      return;
    }
    if (!ctx.config.intelligence.richness.enabled) return;

    const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot);
    if (!budget.tryReserve('fast')) {
      log.info('glossary-synthesize skipped: fast-tier budget exhausted', { conceptName });
      return; // no queue to preserve — next ingest that grows this concept re-fires the gate naturally
    }

    const stateDir = resolveStateDir(ctx.config);
    const llm = createLLMFromConfig(ctx.config, stateDir, 'fast');
    try {
      await synthesizeConceptEntry(ctx.vault, ctx.config.layout, conceptName, llm);
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      log.warn('glossary-synthesize failed', { conceptName, error: (err as Error).message });
    }
  },
};
```

In `src/jobs/handlers/index.ts`, add the import (alongside the existing `import { migrateConceptGlossaryHandler } from './migrate-concept-glossary.js';`):

```typescript
import { glossarySynthesizeHandler } from './glossary-synthesize.js';
```

And register it (alongside `map.set('migrate-concept-glossary', migrateConceptGlossaryHandler);`):

```typescript
  map.set('glossary-synthesize', glossarySynthesizeHandler);
```

In `src/jobs/handlers/compile-entities.ts`, add the import:

```typescript
import { normalizeName } from '../../ingest/entity-resolver.js';
```

Replace the concept loop:

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

with:

```typescript
    const layout = layoutFromConfig(context.config);
    for (const concept of (entities.concepts ?? [])) {
      if (!shouldInclude(concept.name, 'concept', concept.confidence)) { filteredOut++; continue; }
      const { crossedSynthesisThreshold } = await upsertConceptMention(
        context.vault,
        layout,
        {
          name: concept.name,
          gloss: concept.definition ?? '',
          sourceRef: sourceSummaryPath,
        },
        { synthesisThreshold: context.config.intelligence.richness.glossarySynthesisThreshold },
      );
      if (crossedSynthesisThreshold) {
        await context.enqueue({
          type: 'glossary-synthesize',
          payload: { conceptName: concept.name },
          trigger: 'cascade',
          priority: 40,
          dedupeKey: `glossary-synthesize:${normalizeName(concept.name)}`,
        });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/jobs/handlers/glossary-synthesize.test.ts test/jobs/handlers/compile-entities.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS (aside from the known `test/bin/intel-tick-exit.test.ts` flake noted in Global Constraints, if it occurs)

- [ ] **Step 6: Commit**

```bash
git add src/jobs/types.ts src/jobs/handlers/glossary-synthesize.ts src/jobs/handlers/index.ts src/jobs/handlers/compile-entities.ts test/jobs/handlers/glossary-synthesize.test.ts test/jobs/handlers/compile-entities.test.ts
git commit -m "feat(jobs): add glossary-synthesize job, fired when a concept mention crosses the richness threshold"
```

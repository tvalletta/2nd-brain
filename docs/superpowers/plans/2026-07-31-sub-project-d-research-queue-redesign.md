# Sub-project D: Research Queue Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute it task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the research-queue handshake to actually working order in the real, `Curated/`-layout production vault (G0 — all three approval surfaces plus `karpathy intel health`), then close the gaps the outage hid: a fully-built-but-off-by-default auto-drain from decision to execution (G1), budget/tier gating for `research-execute`'s LLM calls (G2), a purge of B1-orphaned candidates plus a defense-in-depth write guard (G3), a one-line `confidenceGap` formula fix (G4), and observability logging for every silent drop/drain (G5).

**Architecture:** No new files, no new queue-file format, no new frontmatter fields — this sub-project repairs and completes the existing `research-queue.ts` plumbing in place. G0 threads `layoutFromConfig(config)` / `config.layout` through the four consumer locations that currently omit it (`src/mcp/tools/approve-research.ts`, three subcommands in `src/bin/intel-command.ts`, `src/intelligence/health-check.ts`), mirroring the exact pattern `reconcile-entities.ts`/`resolve-archive-candidate.ts` already established. G1 adds an optional `enqueue` dependency to `proposeResearch` (mirroring `decay-scan.ts`'s own `enqueue` dependency), gated behind a new `intelligence.research.autoDrainEnabled` config flag that **defaults to `false`**. G2 reuses the existing `BudgetTracker`/`createLLMFromConfig` tier-aware pattern B2a established in `generate-review-analysis.ts`, applied to `src/jobs/handlers/research-execute.ts`. G3/G4 are small, targeted edits inside `research-propose.ts`'s existing scan/carry-forward loop plus a guard clause in `research-execute.ts`'s `writeConceptNote()`. G5 is three new `appendLogEntry` calls using the codebase's existing `kind:`-tagged log-line convention.

**Tech Stack:** TypeScript (strict, ESM-only, `.js` import extensions), Zod schemas, Vitest with real temp directories (`createFsAdapter`) and real `KarpathyConfigSchema.parse(...)` — no mocking of vault I/O anywhere in this plan.

## Design decisions already settled (no task needed)

- **`intelligence.research.autoDrainEnabled` defaults to `false`** (design doc §9, §14, §15 — confirmed by the operator instruction that produced this plan, and it is the one real, already-resolved open question from the design). `research-execute` has never run once against the real production vault, makes real costed LLM calls, and — depending on `search.provider` — spawns an external `npx`-fetched MCP subprocess that has likewise never been exercised. G0/G2/G3/G4/G5 ship enabled unconditionally (correctness/safety/hygiene, no new autonomous behavior); G1's auto-drain mechanism ships fully built and tested but inert until an operator flips the flag after watching a manual `karpathy intel research <slug> <depth>` run succeed once. **Task 4's config-schema code below uses `false`, not `true` — this is load-bearing; do not "fix" it to `true`.**
- **The design's "Open questions for Tom"** (turning on Slack notifications; turning on `autoDrainEnabled`) are non-blocking follow-ups the design itself already resolved for scope purposes (§1 non-goals) — not open design forks. No task addresses them.
- **No new queue-file format, no new frontmatter fields, no new note type, no re-derivation of the six-signal `gap_score` formula's weights** — all out of scope per the design's §1 non-goals, respected throughout every task below.

## Discrepancies found vs. the design doc (resolved inline in the affected tasks)

- **Serious: the design's G1 drain code sets `trigger: 'research-drain'`, which is not a valid `JobTrigger`.** `src/jobs/types.ts`'s `JobTrigger` Zod enum only accepts `'file-watcher' | 'hook' | 'timer' | 'cli' | 'cascade' | 'thin-content'`. `JobQueue.enqueue()` (`src/jobs/queue.ts`) calls `JobSchema.parse(...)` on every enqueue, so passing `'research-drain'` would throw a `ZodError` the very first time auto-drain ever fired — the whole G1 mechanism as designed would crash on first use, silently defeating the entire feature the moment an operator turned it on. Fixed in Task 4 by using `trigger: 'cascade'` instead — the value already established at ~15 other call sites across this codebase (`decay-scan.ts` → `topic-refresh`, `compile-entities.ts`, `link-concepts.ts`, `agent-ingest.ts`, etc.) for exactly this shape of event: one job's handler enqueuing a follow-up job as a consequence of what it found.
- **`src/mcp/tools/approve-research.ts`'s design-doc code sample uses the wrong relative import path for `layoutFromConfig`.** The design's §3 snippet writes `import { layoutFromConfig } from '../vault/paths.js';` — but `approve-research.ts` lives at `src/mcp/tools/approve-research.ts` (two directories below `src/`, confirmed by its own existing `import { readResearchQueue, writeResearchQueue } from '../../maintenance/research-queue.js';`, and by the sibling file `src/mcp/tools/reconcile-entities.ts:19`'s real `import { layoutFromConfig } from '../../vault/paths.js';`). `'../vault/paths.js'` would resolve to a nonexistent `src/mcp/vault/paths.js` and fail to compile. Fixed in Task 1 with the correct `'../../vault/paths.js'`.
- **`ProposeDeps.enqueue`'s type in the design doc is an ad hoc inline object-literal type, not the real, already-established `JobCreateInput` type.** The design's §4 snippet defines `enqueue?: (partial: { type: 'research-execute'; payload: Record<string, unknown>; ... }) => Promise<unknown>` — but `decay-scan.ts` (the design's own cited precedent for "mirroring decay-scan.ts's existing `enqueue` dependency") actually types its dependency as `enqueue: (input: JobCreateInput) => Promise<unknown>`, importing the real type from `../jobs/types.js`. Fixed in Task 4 by importing and using `JobCreateInput` directly, matching the precedent exactly instead of a redefined narrower literal.
- **Two additional legacy-path display-string leaks exist that the design's G0 file list (§2, §3) never mentions**, found by grepping every reference to the legacy `RESEARCH_QUEUE_PATH` constant (`export const RESEARCH_QUEUE_PATH = \`${DEFAULT_LAYOUT.system}/research-queue.md\`;`) across `src/`: (1) `src/bin/intel-command.ts:333` — the `approve` subcommand's own confirmation message (`Applied ${decisions.length} decision(s) to ${RESEARCH_QUEUE_PATH}:`) hardcodes the legacy path even though G0 makes the actual read/write for that same command operate on the real configured layout; (2) `src/jobs/handlers/research-propose.ts:28` — the Slack-digest message's `queuePath` field passed to `formatQueueDigest` uses the same hardcoded constant. Both are display-only (no functional queue corruption), and (2) is currently dormant (`notifications.slack.enabled` is `false` in the real config), but both are the exact same bug class G0 fixes everywhere else, and both are cheap to fix while already touching these exact files. Fixed in Task 2 and Task 4 respectively.
- **`loadConfig()`/`intelCommand()` have no config-injection seam for tests, and the obvious fix (override `process.env.HOME` per test) does not work the way it looks like it should.** `src/config/defaults.ts` computes `export const GLOBAL_CONFIG_PATH = join(homedir(), '.karpathy', 'config.json');` as a **module-level constant, evaluated once at import time** — not re-evaluated per call. Node's `os.homedir()` does dynamically read `process.env.HOME` (verified directly: `HOME=/tmp/x node -e "console.log(os.homedir())"` prints `/tmp/x`), but by the time any test's `beforeEach` runs, `src/config/defaults.ts` (transitively imported by any static `import { intelCommand } from '../../src/bin/intel-command.js'`) has *already* been evaluated with whatever `HOME` was set at file-load time — setting `process.env.HOME` afterward has no effect on the already-frozen constant. Resolved in Task 2 by redirecting `HOME` in a file-scoped `beforeAll`, *before* dynamically `import()`-ing `intel-command.js` for the first time (deferred module evaluation, so `GLOBAL_CONFIG_PATH` gets computed fresh against the redirected `HOME`), relying on Vitest's default per-test-file module isolation (`vitest.config.ts` sets no `isolate` override, so the default `true` applies — confirmed by inspecting the file) so this doesn't leak into any other test file in the suite.
- **The one existing test that calls `proposeResearch` seeds its fixture in a folder G3 stops scanning, and would silently break.** `test/intelligence/research.test.ts`'s `'ranks candidates by gap_score and writes the queue'` test (confirmed via grep to be the *only* test file anywhere in the repo that calls `proposeResearch`) creates its fixture at `wiki/concepts/fsrs.md` with `type: concept`. Once G3 removes `${layout.wiki}/concepts` from `scanFolders()`, that folder is never scanned at all regardless of the file's `type`, so this existing, currently-passing test would start failing (`result.scanned` would be `0`, `result.topCandidates[0]` would be `undefined`). Fixed in Task 5 by moving this fixture to `wiki/topics/fsrs.md` with `type: topic` (a type the scan already accepts) as part of the same task that lands the `scanFolders` change, rather than leaving it as a silent later surprise.
- **Confirmed accurate, no discrepancy (verified by direct read/grep against the real files):** every layout-bug call-site claim — `src/mcp/tools/approve-research.ts:36,45`; `src/bin/intel-command.ts:218` (`queue`), `:325,331` (`approve`), `:383` (`status`); `src/intelligence/health-check.ts:451` (`checkResearchQueue`, called from `runHealthCheck` at line 530) — all match exactly. `src/mcp/tools/reconcile-entities.ts:57` and `src/mcp/tools/resolve-archive-candidate.ts:55` both really do `const layout = layoutFromConfig(ctx.config);`, confirming the established precedent. `createLLMFromConfig(config, stateDir, tier?)` (`src/enrichment/llm-factory.ts:17`) and `createBudgetTrackerFromConfig(config, projectRoot)` (`src/shared/budget.ts:144`) both have exactly the signatures the design assumes. `src/jobs/handlers/topic-refresh.ts`'s budget-gate pattern and `src/review/generate-review-analysis.ts`'s tier-client pattern both match the design's citations exactly. `src/intelligence/scheduler.ts`'s `defaultSchedule()` genuinely never includes `research-execute` under any condition (confirmed by reading the full function). `research-propose.ts`'s `scanFolders()` really is `[${layout.wiki}/concepts, ${layout.wiki}/topics]` today, and the `confidenceGap` bug is really at line 112 exactly as quoted. The `research-execute:${slug}` dedupe-key convention the design cites for G1 really is what `intel-command.ts:209`'s manual `research` subcommand already uses. `conceptGlossaryPath(layout)` really is exported from `src/maintenance/concept-glossary.ts`. Test-file-existence claims are all confirmed: `test/intelligence/research.test.ts` and `test/intelligence/hot-cache-injector.test.ts` exist (both default-layout-only, confirming Finding 6); `test/mcp/tools.test.ts` exists with zero `approve_research`/`research` coverage; `test/bin/intel-command.test.ts`, `test/intelligence/health-check.test.ts`, `test/jobs/handlers/research-propose.test.ts`, and `test/jobs/handlers/research-execute.test.ts` do not exist anywhere in the repo. `src/jobs/handlers/research-propose.ts` and `src/jobs/handlers/research-execute.ts` genuinely are thin job-handler wrapper files distinct from `src/intelligence/research-propose.ts`/`research-execute.ts` (unlike Sub-project C's Task 6 surprise, this distinction is exactly what the design assumed — no mismatch here).
- **Minor clarification, not a bug:** the design's "four consumer call sites never pass a layout argument" (§0.2 Finding 1) reads literally as four call sites but is really four *locations* (`approve-research.ts`, `intel-command.ts`'s three subcommands, `health-check.ts`) comprising seven individual `readResearchQueue`/`writeResearchQueue` calls total — confirmed by direct grep count. No fix needed; noted so the task breakdown below (which does treat these as three separable locations/tasks) isn't read as contradicting the design's count.

## Global Constraints

- ESM only — all imports use `.js` extensions, even for `.ts` source files.
- Strict TypeScript — `pnpm lint` (`tsc --noEmit`) must pass with no errors. `tsconfig.json` sets `noUnusedLocals`/`noUnusedParameters: true` and excludes `test/` from type-checking (`"exclude": ["node_modules", "dist", "test"]`) — only `src/**/*` is lint-checked.
- `pnpm build && pnpm test && pnpm lint` must all pass before any commit.
- Vitest is the test runner (`vitest.config.ts`: `include: ['test/**/*.test.ts']`, no `isolate` override — default per-file module isolation applies). Tests use real temp directories + `createFsAdapter` + real `KarpathyConfigSchema.parse(...)` — never mock vault I/O. `vi.spyOn`/`vi.fn` are fine for stubbing pure dependency-injected functions (e.g. an `enqueue` callback) — this plan never mocks a module namespace or vault filesystem call.
- No new runtime dependencies.
- Every component in this plan is deterministic- or extraction-lane (spec §7.1) except G2's LLM tier selection, which reuses `createLLMFromConfig`/`createBudgetTrackerFromConfig` exactly as already established by Phase 1 (`topic-refresh.ts`) and B2a (`generate-review-analysis.ts`) — no new LLM-calling code path is invented.
- `test/bin/intel-tick-exit.test.ts` and `test/bin/drain-queue-exit.test.ts` are known pre-existing environment-dependent tests in this repo (they spawn the real CLI against the ambient real `~/.karpathy` state) — unrelated to this plan; if either is the only failure in a full `pnpm test` run, treat the run as clean.
- Never hardcode `'wiki/_system'`/`'wiki/concepts'`/`'wiki/topics'` in new production code — always derive from `layoutFromConfig(config)` or an already-layout-resolved `layout` parameter, per this repo's own captured lesson (`~/.claude/projects/.../memory/feedback_layout_aware_paths.md`).

---

### Task 1: G0 — `approve_research` MCP tool layout fix

**Files:**
- Modify: `src/mcp/tools/approve-research.ts`
- Test: `test/mcp/tools.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `readResearchQueue(vault, layout?)` / `writeResearchQueue(vault, queue, layout?)` (`src/maintenance/research-queue.js`, both already layout-aware — only the call sites are wrong); `layoutFromConfig(config)` (`src/vault/paths.js`); existing `MCPContext` (`src/mcp/context.js`).
- Produces: nothing new consumed by later tasks — this is the first of three independent, parallelizable G0 locations (this task, Task 2, Task 3 all fix the identical bug class in different files with no shared code).

- [ ] **Step 1: Write the failing tests**

Add these two `import`s to the top of `test/mcp/tools.test.ts`, alongside the existing MCP-tool imports (right after the `resolve-archive-candidate`/`archive-queue` imports):

```typescript
import { handle as handleApproveResearch } from '../../src/mcp/tools/approve-research.js';
import { readResearchQueue, writeResearchQueue } from '../../src/maintenance/research-queue.js';
```

Add these two new top-level `describe` blocks at the very end of the file (after the existing `describe('resolve_archive_candidate', ...)` block's closing `});`):

```typescript
describe('approve_research — non-default layout.system (G0)', () => {
  let tempDir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-mcp-research-'));
    const vault = createFsAdapter(tempDir);
    const config = KarpathyConfigSchema.parse({
      vaultPath: tempDir,
      projectRoot: tempDir,
      layout: { system: 'Curated/_system' },
    });
    ctx = {
      config,
      vault,
      sessionLog: createSessionLogManager(vault, config.layout),
      hotCache: createHotCacheManager(join(tempDir, 'CLAUDE.md')),
      usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
      enqueueJob: async () => {},
      runDeterministicJobs: async () => 0,
    };

    await writeResearchQueue(vault, {
      candidates: [
        {
          slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'mentioned recently',
          suggested: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    }, config.layout);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('finds and updates a real candidate at the configured Curated/_system layout path (regression: used to always report "Slug not in queue")', async () => {
    const result = await handleApproveResearch({ slug: 'fsrs', depth: 'heavy' }, ctx);
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ slug: 'fsrs', decision: 'heavy', status: 'pending' });

    const queue = await readResearchQueue(ctx.vault, ctx.config.layout);
    expect(queue.candidates[0].decision).toBe('heavy');
  });

  it('still errors for a genuinely unknown slug (regression: not just always-succeeding)', async () => {
    const result = await handleApproveResearch({ slug: 'nonexistent', depth: 'light' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Slug not in queue: nonexistent');
  });
});

describe('approve_research — default layout (regression)', () => {
  let tempDir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-mcp-research-default-'));
    const vault = createFsAdapter(tempDir);
    const config = KarpathyConfigSchema.parse({ vaultPath: tempDir, projectRoot: tempDir });
    ctx = {
      config,
      vault,
      sessionLog: createSessionLogManager(vault, config.layout),
      hotCache: createHotCacheManager(join(tempDir, 'CLAUDE.md')),
      usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
      enqueueJob: async () => {},
      runDeterministicJobs: async () => 0,
    };
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'raptor', title: 'RAPTOR', score: 0.5, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    }, config.layout);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('still works unmodified under the default wiki/_system layout', async () => {
    const result = await handleApproveResearch({ slug: 'raptor', depth: 'medium' }, ctx);
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/mcp/tools.test.ts`
Expected: FAIL — the first describe block's first test fails because `readResearchQueue(ctx.vault)` (no layout arg, inside the real `approve-research.ts` today) reads the *default* `wiki/_system/research-queue.md`, which does not exist under this fixture's `Curated/_system` layout, so `queue.candidates` is empty and the handler always returns `"Slug not in queue: fsrs"` — `result.isError` is `true`, not falsy.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/tools/approve-research.ts`, change:

```typescript
import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readResearchQueue,
  writeResearchQueue,
} from '../../maintenance/research-queue.js';
```

to:

```typescript
import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readResearchQueue,
  writeResearchQueue,
} from '../../maintenance/research-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';
```

Then change:

```typescript
export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const queue = await readResearchQueue(ctx.vault);
  const candidate = queue.candidates.find((c) => c.slug === input.slug);
  if (!candidate) {
    return {
      content: [{ type: 'text' as const, text: `Slug not in queue: ${input.slug}` }],
      isError: true,
    };
  }
  candidate.decision = input.depth;
  await writeResearchQueue(ctx.vault, queue);
  return {
```

to:

```typescript
export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const layout = layoutFromConfig(ctx.config);
  const queue = await readResearchQueue(ctx.vault, layout);
  const candidate = queue.candidates.find((c) => c.slug === input.slug);
  if (!candidate) {
    return {
      content: [{ type: 'text' as const, text: `Slug not in queue: ${input.slug}` }],
      isError: true,
    };
  }
  candidate.decision = input.depth;
  await writeResearchQueue(ctx.vault, queue, layout);
  return {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/mcp/tools.test.ts`
Expected: PASS — including every pre-existing test in this file (purely additive change; the default-layout describe block above is itself a regression check).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/approve-research.ts test/mcp/tools.test.ts
git commit -m "fix(mcp): thread layout through approve_research's research-queue read/write"
```

---

### Task 2: G0 — CLI `intel-command.ts` layout fix (`queue`/`approve`/`status`)

**Files:**
- Modify: `src/bin/intel-command.ts`
- Test: `test/bin/intel-command.test.ts` (new file)

**Interfaces:**
- Consumes: `readResearchQueue`/`writeResearchQueue`/`researchQueuePath` (`src/maintenance/research-queue.js`); `intelCommand(args: string[]): Promise<void>` (`src/bin/intel-command.js`, unchanged signature).
- Produces: nothing new consumed by later tasks. Independent of Task 1/Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/bin/intel-command.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { writeResearchQueue, readResearchQueue } from '../../src/maintenance/research-queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

// `loadConfig()` (src/config/loader.ts) always reads the real global config
// at `${os.homedir()}/.karpathy/config.json`. `GLOBAL_CONFIG_PATH`
// (src/config/defaults.ts) is a MODULE-LEVEL CONSTANT computed once from
// `homedir()` at import time -- not re-evaluated per call. Setting
// `process.env.HOME` in a per-test `beforeEach` would be too late: by then
// `intel-command.js` (and the `config/defaults.js` it transitively imports)
// would already have been evaluated via this file's top-level static
// imports, freezing GLOBAL_CONFIG_PATH to the REAL ~/.karpathy/config.json
// before any test body ever runs.
//
// Fix: redirect HOME in a file-scoped `beforeAll`, BEFORE dynamically
// import()-ing intel-command.js for the first time, so GLOBAL_CONFIG_PATH
// gets computed fresh against the redirected HOME. This relies on Vitest's
// default per-test-FILE module isolation (vitest.config.ts sets no
// `isolate` override, so the default `true` applies) so this redirect can't
// leak into any other test file. HOME (and thus GLOBAL_CONFIG_PATH) stays
// fixed for this whole file; per-test isolation instead comes from
// rewriting the config file's CONTENT (vaultPath) in each test's own
// beforeEach -- readGlobalConfig() re-reads that file fresh on every call.
let intelCommand: typeof import('../../src/bin/intel-command.js')['intelCommand'];
let fakeHome: string;

describe('karpathy intel queue/approve/status — non-default layout (G0)', () => {
  let vaultDir: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'karpathy-home-'));
    process.env.HOME = fakeHome;
    ({ intelCommand } = await import('../../src/bin/intel-command.js'));
  });

  afterAll(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'karpathy-vault-'));
    await mkdir(join(fakeHome, '.karpathy'), { recursive: true });
    await writeFile(
      join(fakeHome, '.karpathy', 'config.json'),
      JSON.stringify({
        defaults: { vaultPath: vaultDir, layout: { system: 'Curated/_system' } },
        projects: {},
      }),
      'utf-8',
    );

    const config = KarpathyConfigSchema.parse({ vaultPath: vaultDir, layout: { system: 'Curated/_system' } });
    const vault = createFsAdapter(vaultDir);
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'test candidate', suggested: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    }, config.layout);

    writes = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('"queue" finds the real candidate at the configured Curated/_system layout path (regression: used to always print "queue is empty")', async () => {
    await intelCommand(['queue']);
    const output = writes.join('');
    expect(output).not.toContain('Research queue is empty');
    expect(output).toContain('FSRS');
  });

  it('"status" reports the real pending count (regression: used to always report 0 pending)', async () => {
    await intelCommand(['status']);
    const output = writes.join('');
    expect(output).toContain('research queue:');
    expect(output).toContain('1 pending');
  });

  it('"approve" applies a decision to the real queue at the configured layout path and prints the real path (regression: used to always print "queue is empty" and the legacy wiki/_system path)', async () => {
    await intelCommand(['approve', '1 heavy']);
    const output = writes.join('');
    expect(output).not.toContain('Queue is empty');
    expect(output).toContain('FSRS → heavy');
    expect(output).toContain('Curated/_system/research-queue.md');
    expect(output).not.toContain('wiki/_system/research-queue.md');

    const vault = createFsAdapter(vaultDir);
    const config = KarpathyConfigSchema.parse({ vaultPath: vaultDir, layout: { system: 'Curated/_system' } });
    const queue = await readResearchQueue(vault, config.layout);
    expect(queue.candidates[0].decision).toBe('heavy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/bin/intel-command.test.ts`
Expected: FAIL on all three tests — today's `readResearchQueue(vault)`/`writeResearchQueue(vault, queue)` calls in `intel-command.ts` (no layout argument) read/write `wiki/_system/research-queue.md`, which does not exist under this fixture's `Curated/_system` layout, so `queue`/`status` report empty/zero and `approve` reports `"Queue is empty — nothing to approve."` and (once that's fixed) would still print the legacy `wiki/_system/research-queue.md` string.

- [ ] **Step 3: Write minimal implementation**

In `src/bin/intel-command.ts`, change:

```typescript
import {
  readResearchQueue,
  writeResearchQueue,
  RESEARCH_QUEUE_PATH,
} from '../maintenance/research-queue.js';
```

to:

```typescript
import {
  readResearchQueue,
  writeResearchQueue,
  researchQueuePath,
} from '../maintenance/research-queue.js';
```

Change the `'queue'` case:

```typescript
    case 'queue': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const queue = await readResearchQueue(vault);
```

to:

```typescript
    case 'queue': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const queue = await readResearchQueue(vault, config.layout);
```

Change the `'approve'` case:

```typescript
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const queue = await readResearchQueue(vault);
      if (queue.candidates.length === 0) {
        process.stdout.write('Queue is empty — nothing to approve. Run `karpathy intel propose` first.\n');
        return;
      }
      applyDecisions(queue.candidates, decisions);
      await writeResearchQueue(vault, queue);
      const sorted = [...queue.candidates].sort((a, b) => b.score - a.score);
      process.stdout.write(`Applied ${decisions.length} decision(s) to ${RESEARCH_QUEUE_PATH}:\n`);
```

to:

```typescript
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const queue = await readResearchQueue(vault, config.layout);
      if (queue.candidates.length === 0) {
        process.stdout.write('Queue is empty — nothing to approve. Run `karpathy intel propose` first.\n');
        return;
      }
      applyDecisions(queue.candidates, decisions);
      await writeResearchQueue(vault, queue, config.layout);
      const sorted = [...queue.candidates].sort((a, b) => b.score - a.score);
      process.stdout.write(`Applied ${decisions.length} decision(s) to ${researchQueuePath(config.layout)}:\n`);
```

Change the `'status'` case:

```typescript
      // Research queue stats.
      const queue = await readResearchQueue(vault);
```

to:

```typescript
      // Research queue stats.
      const queue = await readResearchQueue(vault, config.layout);
```

(`config.layout` is used directly rather than importing `layoutFromConfig`, matching this file's own established local convention — it already uses `config.layout` directly at the `'index'` case for `rebuildVaultIndex`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/bin/intel-command.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full existing bin test suite to confirm no regression**

Run: `pnpm vitest run test/bin/`
Expected: PASS (aside from the pre-existing `intel-tick-exit.test.ts` flake noted in Global Constraints, unrelated to this change).

- [ ] **Step 6: Commit**

```bash
git add src/bin/intel-command.ts test/bin/intel-command.test.ts
git commit -m "fix(bin): thread layout through intel queue/approve/status research-queue calls"
```

---

### Task 3: G0 — `health-check.ts` `checkResearchQueue` layout fix

**Files:**
- Modify: `src/intelligence/health-check.ts`
- Test: `test/intelligence/health-check.test.ts` (new file)

**Interfaces:**
- Consumes: `readResearchQueue(vault, layout?)`, `layoutFromConfig(config)`; `runHealthCheck(opts: RunHealthCheckOptions): Promise<HealthReport>` (already exported, accepts a pre-resolved `config: KarpathyConfig | null` directly — no `loadConfig()`/homedir involvement, so none of Task 2's HOME-redirect complexity applies here).
- Produces: nothing new consumed by later tasks. Independent of Task 1/Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/intelligence/health-check.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { writeResearchQueue } from '../../src/maintenance/research-queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { runHealthCheck } from '../../src/intelligence/health-check.js';

describe('checkResearchQueue (via runHealthCheck) — non-default layout.system (G0)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-health-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports real counts under a non-default layout.system (regression: used to always report 0/0/0)', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      projectRoot: dir,
      layout: { system: 'Curated/_system' },
    });
    const vault = createFsAdapter(dir);
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'raptor', title: 'RAPTOR', score: 0.5, reason: 'r', suggested: 'light', decision: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'done', title: 'Done', score: 0.4, reason: 'r', suggested: 'light', decision: 'light', status: 'completed', addedAt: '2026-05-01T00:00:00.000Z', completedAt: '2026-06-01T00:00:00.000Z', completedDepth: 'light' },
      ],
    }, config.layout);

    const report = await runHealthCheck({ projectRoot: dir, config });

    const check = report.checks.find((c) => c.id === 'research-queue');
    expect(check?.message).toBe('Research queue: 1 pending, 1 approved, 1 completed');
    expect(report.metrics.researchPending).toBe(1);
    expect(report.metrics.researchApproved).toBe(1);
    expect(report.metrics.researchCompleted).toBe(1);
  });

  it('reports 0/0/0 when config is null (vault not reachable) — unaffected regression', async () => {
    const report = await runHealthCheck({ projectRoot: dir, config: null });
    expect(report.metrics.researchPending).toBe(0);
    expect(report.metrics.researchApproved).toBe(0);
    expect(report.metrics.researchCompleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/intelligence/health-check.test.ts`
Expected: FAIL on the first test — today's `readResearchQueue(vault)` (no layout arg) inside `checkResearchQueue` reads the default `wiki/_system/research-queue.md`, which doesn't exist under this fixture's `Curated/_system` layout, so the message is `'Research queue: 0 pending, 0 approved, 0 completed'` and all three metrics are `0`.

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/health-check.ts`, change:

```typescript
import { readResearchQueue } from '../maintenance/research-queue.js';
```

to:

```typescript
import { readResearchQueue } from '../maintenance/research-queue.js';
import { layoutFromConfig } from '../vault/paths.js';
```

Then change:

```typescript
  const vault = createFsAdapter(config.vaultPath);
  const queue = await readResearchQueue(vault);
  const pending = queue.candidates.filter((c) => c.status === 'pending' && !c.decision).length;
```

to:

```typescript
  const vault = createFsAdapter(config.vaultPath);
  const queue = await readResearchQueue(vault, layoutFromConfig(config));
  const pending = queue.candidates.filter((c) => c.status === 'pending' && !c.decision).length;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/intelligence/health-check.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/health-check.ts test/intelligence/health-check.test.ts
git commit -m "fix(intelligence): thread layout through checkResearchQueue"
```

---

### Task 4: G1 — `autoDrainEnabled` config flag + auto-drain wiring

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/intelligence/research-propose.ts`
- Modify: `src/jobs/handlers/research-propose.ts`
- Test: `test/config/schema.test.ts` (extend existing file)
- Test: `test/intelligence/research.test.ts` (extend existing file)
- Test: `test/jobs/handlers/research-propose.test.ts` (new file)

**Interfaces:**
- Consumes: `JobCreateInput` (`src/jobs/types.js`, the real type — see Discrepancies); `JobContext.enqueue` (already `(partial: JobCreateInput) => Promise<Job>`); `intelligence.research.autoDrainEnabled: boolean` (new field this task adds).
- Produces: `ProposeDeps.enqueue?: (input: JobCreateInput) => Promise<unknown>` — no later task consumes this directly, but Task 5's edits to the same function must be applied *after* this task (its edit anchors below assume this task's code is already in place).

- [ ] **Step 1: Write the failing config-schema test**

Add to `test/config/schema.test.ts`, a new `describe` block at the very end of the file (after the existing `'KarpathyConfigSchema — intelligence.lifecycle'` block's closing `});`):

```typescript
describe('KarpathyConfigSchema — intelligence.research.autoDrainEnabled', () => {
  it('defaults autoDrainEnabled to false', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.research.autoDrainEnabled).toBe(false);
  });

  it('allows enabling it explicitly', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { research: { autoDrainEnabled: true } },
    });
    expect(config.intelligence.research.autoDrainEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: FAIL — `config.intelligence.research.autoDrainEnabled` is `undefined` today (the field doesn't exist in the schema).

- [ ] **Step 3: Add the config field**

In `src/config/schema.ts`, inside the existing `research` sub-schema, change:

```typescript
  research: z
    .object({
      enabled: z.boolean().default(true),
      queueCap: z.number().int().positive().default(50),
      autoExpireDays: z.number().int().positive().default(14),
      autoExpireBelowScore: z.number().min(0).max(1).default(0.3),
      depths: z
```

to:

```typescript
  research: z
    .object({
      enabled: z.boolean().default(true),
      queueCap: z.number().int().positive().default(50),
      autoExpireDays: z.number().int().positive().default(14),
      autoExpireBelowScore: z.number().min(0).max(1).default(0.3),
      /**
       * G1 (Sub-project D): when true, a decided-but-unexecuted candidate is
       * automatically enqueued as a research-execute job by the next
       * research-propose run, instead of requiring
       * `karpathy intel research <slug> <depth>` by hand. Defaults to
       * **false**: research-execute makes real LLM calls (budget-gated per
       * G2, but still real cost) and -- depending on `search.provider` --
       * spawns an external websearch MCP subprocess that has never been
       * exercised against real traffic in the production vault. Ship built
       * and one flip away; see docs/superpowers/specs/2026-07-31-sub-
       * project-d-research-queue-redesign-design.md §14/§15.
       */
      autoDrainEnabled: z.boolean().default(false),
      depths: z
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing `proposeResearch` drain tests**

Add to `test/intelligence/research.test.ts`, a new top-level `describe` block (after the existing `describe('research-propose (D1)', ...)` block's closing `});`, i.e. right before `describe('Slack reply parsing (D2)', ...)`):

```typescript
describe('research-propose auto-drain (G1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-drain-'));
    vault = createFsAdapter(dir);
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    await vault.ensureFolder('wiki/topics');
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not enqueue anything when autoDrainEnabled is false (default), even with decided pending candidates', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => ({}) as never);

    await proposeResearch({ vault, config, store, enqueue }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues exactly one research-execute job per decided pending candidate when autoDrainEnabled is true, skipping "skip" and undecided candidates', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'raptor', title: 'RAPTOR', score: 0.5, reason: 'r', suggested: 'light', decision: 'skip', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
        { slug: 'undecided', title: 'Undecided', score: 0.4, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => ({}) as never);

    await proposeResearch({ vault, config, store, enqueue }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      type: 'research-execute',
      payload: { slug: 'fsrs', depth: 'medium' },
      priority: 80,
      trigger: 'cascade',
      dedupeKey: 'research-execute:fsrs',
    });
  });

  it('logs research:drain only when something was actually drained', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    await proposeResearch(
      { vault, config, store, enqueue: async () => ({}) as never },
      { nowMs: Date.parse('2026-07-01T00:00:00Z') },
    );

    const log = await vault.read('log.md');
    expect(log).toContain('research:drain');
    expect(log).toContain('1 decided candidate(s) drained');
  });

  it('does not log research:drain on a no-op cycle (no decided pending candidates)', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'undecided', title: 'Undecided', score: 0.4, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    await proposeResearch(
      { vault, config, store, enqueue: async () => ({}) as never },
      { nowMs: Date.parse('2026-07-01T00:00:00Z') },
    );

    const log = await vault.read('log.md');
    expect(log).not.toContain('research:drain');
  });
});
```

Add `vi` to this file's existing vitest import line: change `import { describe, it, expect, beforeEach, afterEach } from 'vitest';` to `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`.

Also change this file's existing `import { readResearchQueue } from '../../src/maintenance/research-queue.js';` to `import { readResearchQueue, writeResearchQueue } from '../../src/maintenance/research-queue.js';` — the new tests above call `writeResearchQueue` directly to seed fixture queues, and Task 5 (later in this plan) also relies on it already being imported by the time its own tests are added.

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/research.test.ts`
Expected: FAIL — `ProposeDeps` has no `enqueue` field yet, so `proposeResearch({ vault, config, store, enqueue })` fails to type-check (this repo's `test/` is excluded from `tsc --noEmit`, so this manifests as a runtime failure instead: the drain block doesn't exist yet, so `enqueue` is silently never called and the first "enqueues exactly one" test fails on the call-count assertion).

- [ ] **Step 7: Write minimal implementation — `research-propose.ts`**

Change the imports at the top of `src/intelligence/research-propose.ts`:

```typescript
import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { EmbeddingStore } from '../embeddings/store.js';
import { parseNote } from '../vault/frontmatter.js';
import {
  type ResearchCandidate,
  readResearchQueue,
  writeResearchQueue,
} from '../maintenance/research-queue.js';
import { retrievability, defaultStability } from '../vault/half-life.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { layoutFromConfig } from '../vault/paths.js';
```

to:

```typescript
import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { EmbeddingStore } from '../embeddings/store.js';
import type { JobCreateInput } from '../jobs/types.js';
import { parseNote } from '../vault/frontmatter.js';
import {
  type ResearchCandidate,
  readResearchQueue,
  writeResearchQueue,
} from '../maintenance/research-queue.js';
import { retrievability, defaultStability } from '../vault/half-life.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { layoutFromConfig } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('research-propose');
```

Change `ProposeDeps`:

```typescript
export interface ProposeDeps {
  vault: VaultAdapter;
  config: KarpathyConfig;
  store: EmbeddingStore;
}
```

to:

```typescript
export interface ProposeDeps {
  vault: VaultAdapter;
  config: KarpathyConfig;
  store: EmbeddingStore;
  /**
   * Optional -- when provided and `intelligence.research.autoDrainEnabled`
   * is true, decided-but-unexecuted candidates are auto-enqueued as
   * research-execute jobs (G1). Same `JobCreateInput` shape as
   * `JobContext.enqueue` and `decay-scan.ts`'s own `enqueue` dependency.
   * Omitted in callers/tests that don't care about drain.
   */
  enqueue?: (input: JobCreateInput) => Promise<unknown>;
}
```

Finally, change the tail of `proposeResearch` (insert the drain block after the existing `appendLogEntry({ kind: 'research:propose', ... })` call, before `return`):

```typescript
  await writeResearchQueue(deps.vault, { candidates: trimmed }, layout);
  await appendLogEntry(
    deps.vault,
    {
      kind: 'research:propose',
      message: `${scanned} scanned → ${trimmed.length} in queue (${trimmed.filter((c) => c.status === 'pending').length} pending)`,
      at: nowIso,
    },
    layout,
  );

  return {
    scanned,
    proposed: trimmed.length,
    topCandidates: trimmed.slice(0, 10),
  };
}
```

to:

```typescript
  await writeResearchQueue(deps.vault, { candidates: trimmed }, layout);
  await appendLogEntry(
    deps.vault,
    {
      kind: 'research:propose',
      message: `${scanned} scanned → ${trimmed.length} in queue (${trimmed.filter((c) => c.status === 'pending').length} pending)`,
      at: nowIso,
    },
    layout,
  );

  // G1: auto-drain decided-but-unexecuted candidates into research-execute
  // jobs. Off by default (intelligence.research.autoDrainEnabled) -- see
  // config/schema.ts for the rationale. Reuses the exact dedupeKey shape
  // `karpathy intel research <slug> <depth>` already uses (intel-command.ts's
  // 'research' case) so the job queue's existing dedup guarantees a
  // candidate already queued/running never gets stacked a second time.
  let drained = 0;
  if (deps.config.intelligence.research.autoDrainEnabled && deps.enqueue) {
    for (const c of trimmed) {
      if (c.status !== 'pending' || !c.decision || c.decision === 'skip') continue;
      try {
        await deps.enqueue({
          type: 'research-execute',
          payload: { slug: c.slug, depth: c.decision },
          priority: 80,
          trigger: 'cascade',
          dedupeKey: `research-execute:${c.slug}`,
        });
        drained++;
      } catch (err) {
        log.warn('research-drain: enqueue failed', {
          slug: c.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (drained > 0) {
      await appendLogEntry(
        deps.vault,
        {
          kind: 'research:drain',
          message: `${drained} decided candidate(s) drained to research-execute`,
          at: nowIso,
        },
        layout,
      );
    }
  }

  return {
    scanned,
    proposed: trimmed.length,
    topCandidates: trimmed.slice(0, 10),
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run test/intelligence/research.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing job-handler test**

Create `test/jobs/handlers/research-propose.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { researchProposeHandler } from '../../../src/jobs/handlers/research-propose.js';
import { writeResearchQueue } from '../../../src/maintenance/research-queue.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeJob(): Job {
  return {
    id: 'job-1', type: 'research-propose', status: 'pending', priority: 90,
    payload: {}, trigger: 'timer', createdAt: new Date().toISOString(),
    retryCount: 0, maxRetries: 3, debounceMs: 0, transientRetryCount: 0,
  };
}

const noopLLM: LLMClient = {
  async complete() { return '{}'; },
  async extractStructured() { throw new Error('not used in this test'); },
};

describe('research-propose job handler (G1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-rp-handler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/topics');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('threads ctx.enqueue into proposeResearch so autoDrainEnabled candidates actually get drained', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => makeJob());
    const ctx: JobContext = { vaultPath: dir, projectRoot: dir, enqueue, llm: noopLLM, vault, config };

    await researchProposeHandler.execute(makeJob(), ctx);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'research-execute', payload: { slug: 'fsrs', depth: 'medium' } }),
    );
  });

  it('does not drain when autoDrainEnabled is false (default), even though enqueue is available', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => makeJob());
    const ctx: JobContext = { vaultPath: dir, projectRoot: dir, enqueue, llm: noopLLM, vault, config };

    await researchProposeHandler.execute(makeJob(), ctx);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: Run test to verify it fails, then implement, then verify it passes**

Run: `pnpm vitest run test/jobs/handlers/research-propose.test.ts`
Expected: FAIL — `researchProposeHandler` doesn't pass `enqueue` through to `proposeResearch` yet.

In `src/jobs/handlers/research-propose.ts`, change:

```typescript
import type { JobHandler } from '../types.js';
import { proposeResearch } from '../../intelligence/research-propose.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import {
  formatQueueDigest,
  sendSlackNotification,
} from '../../intelligence/slack-notify.js';
import { RESEARCH_QUEUE_PATH } from '../../maintenance/research-queue.js';

export const researchProposeHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.research.enabled) return;
    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      const result = await proposeResearch({ vault: ctx.vault, config: ctx.config, store });
      if (
        ctx.config.notifications.slack.enabled &&
        ctx.config.notifications.slack.webhookUrl
      ) {
        const message = formatQueueDigest({
          totalPending: result.proposed,
          topCandidates: result.topCandidates.filter((c) => !c.decision),
          queuePath: RESEARCH_QUEUE_PATH,
        });
```

to:

```typescript
import type { JobHandler } from '../types.js';
import { proposeResearch } from '../../intelligence/research-propose.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import {
  formatQueueDigest,
  sendSlackNotification,
} from '../../intelligence/slack-notify.js';
import { researchQueuePath } from '../../maintenance/research-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const researchProposeHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.research.enabled) return;
    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      const result = await proposeResearch({
        vault: ctx.vault,
        config: ctx.config,
        store,
        enqueue: ctx.enqueue, // G1: auto-drain, gated inside proposeResearch itself
      });
      if (
        ctx.config.notifications.slack.enabled &&
        ctx.config.notifications.slack.webhookUrl
      ) {
        const message = formatQueueDigest({
          totalPending: result.proposed,
          topCandidates: result.topCandidates.filter((c) => !c.decision),
          // (found while implementing G1, same bug class as G0): this used
          // to be the hardcoded legacy RESEARCH_QUEUE_PATH constant
          // ('wiki/_system/...'), which would show the wrong path in the
          // Slack message under any non-default layout.system. Dormant
          // today (notifications.slack.enabled is false in the real
          // config), but it's the same class of bug G0 fixes everywhere
          // else, so fixed here too while this file is already being touched.
          queuePath: researchQueuePath(layoutFromConfig(ctx.config)),
        });
```

Run: `pnpm vitest run test/jobs/handlers/research-propose.test.ts`
Expected: PASS

- [ ] **Step 11: Run full test suite + build + lint**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS (aside from the pre-existing `intel-tick-exit.test.ts` flake).

- [ ] **Step 12: Commit**

```bash
git add src/config/schema.ts src/intelligence/research-propose.ts src/jobs/handlers/research-propose.ts \
  test/config/schema.test.ts test/intelligence/research.test.ts test/jobs/handlers/research-propose.test.ts
git commit -m "feat(intelligence): add auto-drain for decided research candidates (gated off by default)"
```

---

### Task 5: G3 (part 1) + G4 — orphan purge, `scanFolders` fix, `confidenceGap` fix

**Files:**
- Modify: `src/intelligence/research-propose.ts`
- Test: `test/intelligence/research.test.ts` (extend existing file; also **modifies** one existing test — see Discrepancies)

**Interfaces:**
- Consumes: nothing new. Must be applied *after* Task 4 (the edit anchors below assume Task 4's drain block already follows the `research:propose` `appendLogEntry` call).
- Produces: nothing new consumed by later tasks. Task 6 (the `writeConceptNote` guard) is a different file and has no dependency on this task, but is grouped next since it's the second half of G3.

- [ ] **Step 1: Fix the existing test whose fixture G3 will orphan**

In `test/intelligence/research.test.ts`, inside the `describe('research-propose (D1)', ...)` block's `beforeEach`, change:

```typescript
    await vault.ensureFolder('wiki/concepts');
  });
```

to:

```typescript
    await vault.ensureFolder('wiki/topics');
  });
```

Then, in the same describe block's `'ranks candidates by gap_score and writes the queue'` test, change:

```typescript
    await vault.create(
      'wiki/concepts/fsrs.md',
      `---
id: fsrs
type: concept
title: FSRS
created_at: 2025-09-01T00:00:00Z
updated_at: 2025-09-01T00:00:00Z
last_verified: 2025-09-01T00:00:00Z
stability: 30
half_life_domain: ai-research
confidence: low
---
body.`,
    );
```

to:

```typescript
    await vault.create(
      'wiki/topics/fsrs.md',
      `---
id: fsrs
type: topic
title: FSRS
created_at: 2025-09-01T00:00:00Z
updated_at: 2025-09-01T00:00:00Z
last_verified: 2025-09-01T00:00:00Z
stability: 30
half_life_domain: ai-research
confidence: low
---
body.`,
    );
```

(This is the *only* test file anywhere in the repo that calls `proposeResearch` — confirmed by grep. Without this change, this pre-existing, currently-passing test would silently start failing once `scanFolders()` below stops scanning `wiki/concepts` at all, since the fixture lives there today. This is not a new test for a new behavior — it's fixing an existing test's fixture location so it continues to exercise the same "a topic-typed page gets discovered and scored" behavior it always has, just from the folder that's still scanned.)

- [ ] **Step 2: Run test to verify it still passes after the fixture move (sanity check before making the real change)**

Run: `pnpm vitest run test/intelligence/research.test.ts -t "ranks candidates by gap_score"`
Expected: PASS — `scanFolders()` still includes both `concepts` and `topics` at this point, so moving the fixture to `wiki/topics/fsrs.md` with `type: topic` is a no-op change in behavior (still discovered, same score).

- [ ] **Step 3: Write the failing orphan-purge / confidenceGap tests**

Add to `test/intelligence/research.test.ts`, a new top-level `describe` block right after the `'research-propose auto-drain (G1)'` block added in Task 4:

```typescript
describe('research-propose orphan purge + confidenceGap (G3/G4/G5)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let store: ReturnType<typeof openEmbeddingStore>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-purge-'));
    vault = createFsAdapter(dir);
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
    await vault.ensureFolder('wiki/topics');
    await vault.ensureFolder('wiki/concepts');
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('never proposes a wiki/concepts/*.md page even if type: concept (regression proving the dead scan is truly removed)', async () => {
    await vault.create(
      'wiki/concepts/dead-scan.md',
      `---
id: dead-scan
type: concept
title: Dead scan
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
body.`,
    );
    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(result.scanned).toBe(0);
    expect(result.topCandidates.find((c) => c.slug === 'dead-scan')).toBeUndefined();
  });

  it('purges a carried-forward candidate whose backing page no longer exists in either folder', async () => {
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'orphaned', title: 'Orphaned', score: 0.5, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-05-01T00:00:00.000Z' },
      ],
    });

    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(result.topCandidates.find((c) => c.slug === 'orphaned')).toBeUndefined();
    const queue = await readResearchQueue(vault);
    expect(queue.candidates.find((c) => c.slug === 'orphaned')).toBeUndefined();

    const log = await vault.read('log.md');
    expect(log).toContain('research:orphans-purged');
    expect(log).toContain('orphaned');
  });

  it('keeps a carried-forward candidate whose backing wiki/topics page still exists', async () => {
    await vault.create(
      'wiki/topics/still-real.md',
      `---
id: still-real
type: topic
title: Still real
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
body.`,
    );
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'still-real', title: 'Still real', score: 0.5, reason: 'r', suggested: 'light', status: 'pending', addedAt: '2026-05-01T00:00:00.000Z' },
      ],
    });

    // Below the entry threshold on its own (no embedding-store mentions), so
    // it only survives via the carry-forward path, not fresh re-detection --
    // proving the *carry-forward* orphan check specifically (not just that
    // scanning finds it).
    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(result.topCandidates.find((c) => c.slug === 'still-real')).toBeDefined();
  });

  it('keeps a completed candidate regardless of whether its backing page still exists', async () => {
    await writeResearchQueue(vault, {
      candidates: [
        {
          slug: 'archived-elsewhere', title: 'Archived elsewhere', score: 0.5, reason: 'r', suggested: 'light',
          status: 'completed', addedAt: '2026-05-01T00:00:00.000Z', completedAt: '2026-06-25T00:00:00.000Z', completedDepth: 'light',
        },
      ],
    });

    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(result.topCandidates.find((c) => c.slug === 'archived-elsewhere')).toBeDefined();
  });

  it('logs research:queue-capped only when candidates are actually dropped by queueCap', async () => {
    const cappedConfig = KarpathyConfigSchema.parse({ vaultPath: '/tmp', intelligence: { research: { queueCap: 1 } } });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'keep-me', title: 'Keep me', score: 0.9, reason: 'r', suggested: 'heavy', status: 'pending', addedAt: '2026-06-25T00:00:00.000Z' },
        { slug: 'drop-me', title: 'Drop me', score: 0.8, reason: 'r', suggested: 'heavy', status: 'pending', addedAt: '2026-06-25T00:00:00.000Z' },
      ],
    });

    const result = await proposeResearch({ vault, config: cappedConfig, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    expect(result.proposed).toBe(1);
    const log = await vault.read('log.md');
    expect(log).toContain('research:queue-capped');
    expect(log).toContain('drop-me');
  });

  it('a topic note with no confidence field scores identically to one explicitly marked confidence: medium (G4 regression)', async () => {
    await vault.create(
      'wiki/topics/no-confidence.md',
      `---
id: no-confidence
type: topic
title: No confidence
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
body.`,
    );
    await vault.create(
      'wiki/topics/medium-confidence.md',
      `---
id: medium-confidence
type: topic
title: Medium confidence
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
confidence: medium
---
body.`,
    );

    const result = await proposeResearch({ vault, config, store }, { nowMs: Date.parse('2026-07-01T00:00:00Z') });

    const noConf = result.topCandidates.find((c) => c.slug === 'no-confidence');
    const medConf = result.topCandidates.find((c) => c.slug === 'medium-confidence');
    expect(noConf).toBeDefined();
    expect(medConf).toBeDefined();
    // Both notes are otherwise identical (no mentions, no active-project
    // membership, no half_life_domain, same recency), so before G4 an unset
    // confidence would score 0.7 * 0.15 = 0.105 higher than the medium note.
    expect(noConf!.score).toBe(medConf!.score);
  });
});
```

No new imports needed here — Task 4 already extended this file's `research-queue.js` import line to include `writeResearchQueue` alongside `readResearchQueue`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/research.test.ts`
Expected: FAIL — `scanFolders()` still includes `wiki/concepts` (so the "never proposes a wiki/concepts" test fails), the carry-forward loop has no backing-file check yet (so both orphan-purge tests fail), there's no `queueCap`/orphan logging yet, and `confidenceGap`'s unset branch is still `0.7` (so the G4 regression test fails: `noConf!.score` would be higher than `medConf!.score`).

- [ ] **Step 5: Write minimal implementation**

In `src/intelligence/research-propose.ts`, change `scanFolders`:

```typescript
function scanFolders(layout: ReturnType<typeof layoutFromConfig>): string[] {
  return [`${layout.wiki}/concepts`, `${layout.wiki}/topics`];
}
```

to:

```typescript
function scanFolders(layout: ReturnType<typeof layoutFromConfig>): string[] {
  // G3: `${layout.wiki}/concepts` intentionally excluded. Since B1's
  // concept-glossary consolidation (commit 7de5da9, 2026-07-24), that folder
  // contains only `_index.md`/`glossary.md` (type: index) -- never
  // `type: concept` -- so scanning it for research candidates is
  // permanently a no-op. Concepts get their own LLM-synthesis enrichment via
  // concept-glossary.ts's rollup-line mechanism; individual-page tiered
  // research remains valid only for topics.
  return [`${layout.wiki}/topics`];
}
```

Change the `confidenceGap` line:

```typescript
      const confidenceGap = confidence === 'low' ? 1 : confidence === 'medium' ? 0.5 : confidence === 'high' ? 0 : 0.7;
```

to:

```typescript
      // G4: an unset confidence field (the common case for most topic
      // notes) now contributes the same 0.5 as an explicit
      // `confidence: medium` -- previously it fell through to 0.7,
      // outranking a human's own explicit medium-confidence judgment, which
      // is backwards.
      const confidenceGap = confidence === 'low' ? 1 : confidence === 'medium' ? 0.5 : confidence === 'high' ? 0 : 0.5;
```

Change the carry-forward + cap section (which, after Task 4, is immediately followed by the `// G1: auto-drain` block):

```typescript
  // Auto-expire low-score stale entries from the prior queue.
  for (const prior of existing.candidates) {
    if (candidates.find((c) => c.slug === prior.slug)) continue; // re-proposed → keep
    if (prior.status === 'completed') {
      // Keep completed rows for one-week visibility, then expire.
      if (prior.completedAt && nowMs - new Date(prior.completedAt).getTime() > 7 * 86400_000) {
        continue; // drop
      }
      candidates.push(prior);
      continue;
    }
    const ageDays = (nowMs - new Date(prior.addedAt).getTime()) / 86400_000;
    if (ageDays > expireDays && prior.score < expireBelow) {
      // expire
      continue;
    }
    candidates.push({ ...prior, status: prior.status });
  }

  // Cap.
  candidates.sort((a, b) => b.score - a.score);
  const trimmed = candidates.slice(0, cap);

  await writeResearchQueue(deps.vault, { candidates: trimmed }, layout);
  await appendLogEntry(
    deps.vault,
    {
      kind: 'research:propose',
      message: `${scanned} scanned → ${trimmed.length} in queue (${trimmed.filter((c) => c.status === 'pending').length} pending)`,
      at: nowIso,
    },
    layout,
  );

  // G1: auto-drain decided-but-unexecuted candidates into research-execute
```

to:

```typescript
  // Auto-expire low-score stale entries from the prior queue, AND (G3) drop
  // any entry whose backing page no longer exists -- orphaned by a folder
  // migration (e.g. B1's concept-glossary consolidation) or manual
  // deletion. Completed candidates are exempt: a completed research result
  // may legitimately reference a page that's since been archived by
  // Sub-project C's lifecycle mechanism -- that's a different, valid
  // lifecycle state, not an orphan.
  let orphansPurged = 0;
  const orphanedSlugs: string[] = [];
  for (const prior of existing.candidates) {
    if (candidates.find((c) => c.slug === prior.slug)) continue; // re-proposed → keep

    if (prior.status !== 'completed') {
      const stillBacked =
        (await deps.vault.exists(`${layout.wiki}/concepts/${prior.slug}.md`)) ||
        (await deps.vault.exists(`${layout.wiki}/topics/${prior.slug}.md`));
      if (!stillBacked) {
        orphansPurged++;
        orphanedSlugs.push(prior.slug);
        continue; // drop -- no backing page in either folder
      }
    }

    if (prior.status === 'completed') {
      // Keep completed rows for one-week visibility, then expire.
      if (prior.completedAt && nowMs - new Date(prior.completedAt).getTime() > 7 * 86400_000) {
        continue; // drop
      }
      candidates.push(prior);
      continue;
    }
    const ageDays = (nowMs - new Date(prior.addedAt).getTime()) / 86400_000;
    if (ageDays > expireDays && prior.score < expireBelow) {
      // expire
      continue;
    }
    candidates.push({ ...prior, status: prior.status });
  }

  // Cap.
  candidates.sort((a, b) => b.score - a.score);
  const trimmed = candidates.slice(0, cap);
  const cappedSlugs = candidates.slice(cap).map((c) => c.slug);

  await writeResearchQueue(deps.vault, { candidates: trimmed }, layout);
  await appendLogEntry(
    deps.vault,
    {
      kind: 'research:propose',
      message: `${scanned} scanned → ${trimmed.length} in queue (${trimmed.filter((c) => c.status === 'pending').length} pending)`,
      at: nowIso,
    },
    layout,
  );
  if (orphansPurged > 0) {
    await appendLogEntry(
      deps.vault,
      {
        kind: 'research:orphans-purged',
        message: `${orphansPurged} orphaned candidate(s) purged (no backing page): ${orphanedSlugs.slice(0, 10).join(', ')}`,
        at: nowIso,
      },
      layout,
    );
  }
  if (cappedSlugs.length > 0) {
    await appendLogEntry(
      deps.vault,
      {
        kind: 'research:queue-capped',
        message: `${cappedSlugs.length} candidate(s) dropped by queueCap (${cap}): ${cappedSlugs.slice(0, 10).join(', ')}`,
        at: nowIso,
      },
      layout,
    );
  }

  // G1: auto-drain decided-but-unexecuted candidates into research-execute
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/research.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite + build + lint**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS (aside from the pre-existing `intel-tick-exit.test.ts` flake).

- [ ] **Step 8: Commit**

```bash
git add src/intelligence/research-propose.ts test/intelligence/research.test.ts
git commit -m "fix(intelligence): purge B1-orphaned research candidates; fix confidenceGap default"
```

---

### Task 6: G3 (part 2) — write-guard against resurrecting deprecated architecture

**Files:**
- Modify: `src/intelligence/research-execute.ts`
- Test: `test/intelligence/research.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing new. Independent of Task 5 (different file), grouped next since it's the second half of G3's defense-in-depth (propose-side purge + execute-side guard).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add to `test/intelligence/research.test.ts`, a new top-level `describe` block right after `describe('research executor (D3)', ...)`'s closing `});`:

```typescript
describe('research executor — glossary-consolidated write guard (G3)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-guard-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to create a new individual concept page when the folder is glossary-consolidated', async () => {
    await vault.create(
      'wiki/concepts/glossary.md',
      `---
type: index
title: Concept glossary
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# Concept glossary
`,
    );
    const llm = fakeLLM({
      tldr: 'New concept summary.',
      body: '## What it is\nSomething new.',
      claims: [],
      contradictions: [],
      coverage: { 'what-is': true, 'why-it-matters': false, 'how-it-works': false, alternatives: false, 'recent-changes': false },
    });

    await expect(
      executeResearch({ vault, llm, config }, 'brand-new-concept', {
        depth: 'light',
        nowMs: Date.parse('2026-07-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/glossary-consolidated/);

    expect(await vault.exists('wiki/concepts/brand-new-concept.md')).toBe(false);
  });

  it('is unaffected when the concepts folder has no glossary.md (pre-B1-style, default layout regression)', async () => {
    const llm = fakeLLM({
      tldr: 'New concept summary.',
      body: '## What it is\nSomething new.',
      claims: [],
      contradictions: [],
      coverage: { 'what-is': true, 'why-it-matters': false, 'how-it-works': false, alternatives: false, 'recent-changes': false },
    });

    await executeResearch({ vault, llm, config }, 'genuinely-new-concept', {
      depth: 'light',
      nowMs: Date.parse('2026-07-01T00:00:00Z'),
    });

    expect(await vault.exists('wiki/concepts/genuinely-new-concept.md')).toBe(true);
  });
});
```

(`fakeLLM` is the helper already defined at the top of this file — reused as-is.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/intelligence/research.test.ts`
Expected: FAIL — the first test fails because `executeResearch` today has no glossary-consolidation guard, so it succeeds and creates `wiki/concepts/brand-new-concept.md` instead of throwing.

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/research-execute.ts`, change:

```typescript
async function writeConceptNote(deps: ResearchExecuteDeps, args: WriteArgs): Promise<void> {
  await deps.vault.ensureFolder(args.conceptsFolder);
  const exists = await deps.vault.exists(args.notePath);

  let fm: Record<string, unknown>;
  let body: string;
  if (exists) {
```

to:

```typescript
async function writeConceptNote(deps: ResearchExecuteDeps, args: WriteArgs): Promise<void> {
  await deps.vault.ensureFolder(args.conceptsFolder);
  const exists = await deps.vault.exists(args.notePath);

  // G3: refuse to (re)create an individual concept page inside a
  // glossary-consolidated folder. If the target doesn't exist AND the
  // concepts folder already has a glossary.md, the concept has been
  // consolidated (B1) -- writing a new individual page here would silently
  // fork a duplicate, disconnected representation of the same concept.
  const glossaryPath = `${args.conceptsFolder}/glossary.md`;
  if (!exists && (await deps.vault.exists(glossaryPath))) {
    throw new Error(
      `Refusing to create ${args.notePath}: ${args.conceptsFolder} is glossary-consolidated ` +
        `(${glossaryPath} exists). This concept should be researched as a topic, or its ` +
        `glossary entry enriched via concept-glossary synthesis, not given a new individual page.`,
    );
  }

  let fm: Record<string, unknown>;
  let body: string;
  if (exists) {
```

This throws rather than silently no-oping, so a job failure is visible in the job queue's own retry/quarantine machinery (spec §8.3) rather than a silent success that did the wrong thing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/intelligence/research.test.ts`
Expected: PASS — including the existing `describe('research executor (D3)', ...)` test, which creates its fixture in a `wiki/concepts` folder with no `glossary.md` present, so it is unaffected by this guard.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/research-execute.ts test/intelligence/research.test.ts
git commit -m "feat(intelligence): refuse to create individual concept pages in a glossary-consolidated folder"
```

---

### Task 7: G2 — budget gate + tier-aware LLM client for `research-execute`

**Files:**
- Modify: `src/jobs/handlers/research-execute.ts`
- Test: `test/jobs/handlers/research-execute.test.ts` (new file)

**Interfaces:**
- Consumes: `createBudgetTrackerFromConfig(config, projectRoot)` and `BudgetTier` (`src/shared/budget.js`, already exist, unmodified); `createLLMFromConfig(config, stateDir, tier?)` (`src/enrichment/llm-factory.js`, already exists, unmodified); `resolveStateDir(config)` (`src/config/defaults.js`, already exists).
- Produces: nothing new consumed by later tasks — this is the last task, fully self-contained in a different file from every prior task.

- [ ] **Step 1: Write the failing tests**

Create `test/jobs/handlers/research-execute.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { researchExecuteHandler } from '../../../src/jobs/handlers/research-execute.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: 'job-1', type: 'research-execute', status: 'pending', priority: 80,
    payload, trigger: 'cli', createdAt: new Date().toISOString(),
    retryCount: 0, maxRetries: 3, debounceMs: 0, transientRetryCount: 0,
  };
}

function fakeLLM(): LLMClient {
  return {
    async complete() { return '{}'; },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse({
        tldr: 'A tiny test summary.',
        body: '## What it is\nSomething.',
        claims: [],
        contradictions: [],
        coverage: { 'what-is': true, 'why-it-matters': false, 'how-it-works': false, alternatives: false, 'recent-changes': false },
      });
    },
  };
}

describe('research-execute job handler — budget gate + tier selection (G2)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-rx-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeCtx(config: ReturnType<typeof KarpathyConfigSchema.parse>): JobContext {
    return {
      vaultPath: dir,
      projectRoot: dir,
      enqueue: async () => makeJob({}),
      llm: fakeLLM(),
      vault,
      config,
    };
  }

  it('skips execution when the light-depth (fast-tier) budget is exhausted, even though medium/heavy have plenty', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 200, heavy: 200 } } },
    });

    await researchExecuteHandler.execute(makeJob({ slug: 'fsrs', depth: 'light' }), makeCtx(config));

    // If the handler had incorrectly reserved from 'medium' or 'heavy'
    // instead of 'fast' for a light-depth job, execution would have
    // succeeded (both have plenty of budget) and created the note.
    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(false);
  });

  it('executes when the medium-depth (medium-tier) budget is available even though fast is exhausted', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 200, heavy: 200 } } },
    });

    await researchExecuteHandler.execute(makeJob({ slug: 'fsrs', depth: 'medium' }), makeCtx(config));

    // Proves medium-depth reserves from 'medium', not 'fast' (which is 0).
    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(true);
  });

  it('skips execution when the heavy-depth (heavy-tier) budget is exhausted, even though fast/medium have plenty', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 200, medium: 200, heavy: 0 } } },
    });

    await researchExecuteHandler.execute(makeJob({ slug: 'raptor', depth: 'heavy' }), makeCtx(config));

    expect(await vault.exists('wiki/concepts/raptor.md')).toBe(false);
  });

  it('executes normally under default budget limits (a single job is well within any tier\'s daily allowance)', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });

    await researchExecuteHandler.execute(makeJob({ slug: 'fsrs', depth: 'heavy' }), makeCtx(config));

    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/jobs/handlers/research-execute.test.ts`
Expected: FAIL on the first and third tests — today's handler makes no budget reservation at all, so `executeResearch` always runs regardless of `llmCallsPerDay` limits, and the note gets created even when the relevant tier's budget is `0`.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/handlers/research-execute.ts`, change:

```typescript
import { z } from 'zod';
import type { JobHandler } from '../types.js';
import { executeResearch } from '../../intelligence/research-execute.js';
import { createWebSearchFromConfig } from '../../intelligence/web-search.js';

const Payload = z
  .object({
    slug: z.string(),
    depth: z.enum(['light', 'medium', 'heavy']),
    notePath: z.string().optional(),
  })
  .passthrough();

export const researchExecuteHandler: JobHandler = {
  async execute(job, ctx) {
    const payload = Payload.parse(job.payload ?? {});
    await executeResearch(
      { vault: ctx.vault, llm: ctx.llm, config: ctx.config },
      payload.slug,
      { depth: payload.depth, notePath: payload.notePath, search: createWebSearchFromConfig(ctx.config) },
    );
  },
};
```

to:

```typescript
import { z } from 'zod';
import type { JobHandler } from '../types.js';
import { executeResearch } from '../../intelligence/research-execute.js';
import { createWebSearchFromConfig } from '../../intelligence/web-search.js';
import { createBudgetTrackerFromConfig, type BudgetTier } from '../../shared/budget.js';
import { createLLMFromConfig } from '../../enrichment/llm-factory.js';
import { resolveStateDir } from '../../config/defaults.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('research-execute');

const Payload = z
  .object({
    slug: z.string(),
    depth: z.enum(['light', 'medium', 'heavy']),
    notePath: z.string().optional(),
  })
  .passthrough();

const DEPTH_TO_TIER: Record<'light' | 'medium' | 'heavy', BudgetTier> = {
  light: 'fast',
  medium: 'medium',
  heavy: 'heavy',
};

export const researchExecuteHandler: JobHandler = {
  async execute(job, ctx) {
    const payload = Payload.parse(job.payload ?? {});
    const tier = DEPTH_TO_TIER[payload.depth];

    // G2: reserve one call from the daily budget before doing any real work.
    const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot);
    if (!budget.tryReserve(tier)) {
      log.info('research-execute skipped: daily budget exhausted', {
        slug: payload.slug,
        depth: payload.depth,
        tier,
        remaining: budget.remaining(tier),
      });
      return; // queue row stays pending+decided; next drain cycle (or manual CLI) retries
    }

    // G2: tier-appropriate model instead of always using ctx.llm's default tier.
    const stateDir = resolveStateDir(ctx.config);
    const llm = createLLMFromConfig(ctx.config, stateDir, tier);

    await executeResearch(
      { vault: ctx.vault, llm, config: ctx.config },
      payload.slug,
      { depth: payload.depth, notePath: payload.notePath, search: createWebSearchFromConfig(ctx.config) },
    );
  },
};
```

`DEPTH_TO_TIER` maps `light → fast` (1 round, cheapest model), `medium → medium` (2 rounds, the general-purpose default), `heavy → heavy` (3 rounds, the most capable configured model — previously heavy-depth research used the *same* model as light-depth). Budget reservation happens once per job, not once per round, matching `topic-refresh`'s existing "one reservation per handler invocation" convention.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/jobs/handlers/research-execute.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite + build + lint**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS (aside from the pre-existing `intel-tick-exit.test.ts` flake).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/handlers/research-execute.ts test/jobs/handlers/research-execute.test.ts
git commit -m "feat(jobs): budget-gate and tier-select research-execute's LLM calls"
```

---

## Post-plan note (not a task — informational)

After all seven tasks land, update `CLAUDE.md`'s "Research handshake" bullet (under "Intelligence pipeline") to mention: (a) all three approval surfaces are layout-aware and verified working, (b) the new `intelligence.research.autoDrainEnabled` flag (default `false`) and what it does, (c) `research-execute` is now budget-gated and tier-aware like `topic-refresh`. Per this repo's `specifications.md` rule ("Update after building"), this doc update belongs with whichever task lands last in an actual execution session — not written speculatively here since exact wording should reflect the real final diff.

# Sub-project C: Draft/Archival Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute it task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `status` a genuinely live field across the vault — auto-promote `source_summary` notes from `draft` to `active` the moment the pipeline actually processes them (G0), surface the 96.8%-stuck-at-`draft` backlog in `vault-health.md` (G1), auto-archive drafts that never get processed past a longer threshold (G2), give rot-scan's already-computed candidate list a human-reviewed archive queue (G3/G4), give `NoteStatus`'s unused `rejected` value its first producer via the existing review approve/reject flow (G5), and close the loop so archived notes automatically come back to `active` the instant they're genuinely re-engaged with (G7) — while removing decay-scan's dead, untested `archive_candidate` write (G6).

**Architecture:** Two new base-schema frontmatter fields (`archived_at`, `archived_reason`) and a new `intelligence.lifecycle` config sub-schema are the foundation everything else reads. A new `src/maintenance/archive-queue.ts` mirrors Sub-project A's `reconciliation-queue.ts` pattern (persisted queue file, `karpathy archivist` CLI, `resolve_archive_candidate` MCP tool) and adds one shared `applyArchiveDecision()` helper so the CLI and MCP surfaces share one mutation code path. `rot-scan.ts` gains a stale-draft-source scan pass and feeds its existing rot candidates into the new queue. A new `archive-stale-drafts` job handler does the deterministic, no-review auto-archival. Five existing job handlers/functions (`link-concepts.ts`, `compile-entities.ts` ×2 sites, `agent-ingest.ts`, `review-queue.ts`, `src/intelligence/topic-refresh.ts`, `re-enrich-note.ts`) each get a small, targeted promotion/rejection/un-archival guard at their existing frontmatter-write points.

**Design spec:** `docs/superpowers/specs/2026-07-31-sub-project-c-draft-archival-lifecycle-design.md` (all 19 sections approved; §19 already resolved the one open design question — see "Design decisions already settled" below).

## Design decisions already settled (no task needed)

- **`staleDraftArchiveEnabled` defaults to `false`** (§12, §19, confirmed by the operator instruction that produced this plan): `staleDraftArchiveDays: 30` would auto-archive the large majority of the real vault's 11,499 currently-`draft` source summaries on the very first scheduled run after deploy. G0/G1/G3/G4/G5 and the "Stale draft sources" reporting table ship fully enabled by default (visibility only, zero risk); G2's actual auto-archival job (Task 8) stays off until an operator flips the flag. **Task 2's config-schema code below uses `false`, not `true` — this is load-bearing; do not "fix" it to `true`.**
- **`maintenance.reviewEnabled` stays `false` in the real vault's live config** (§0.1, §15): a one-line change to `~/.karpathy/config.json`, outside this git repo, not performed by this plan. Task 5's review-status wiring (G5) works correctly regardless of this flag; it just has nothing to act on until an operator either flips `reviewEnabled` or manually runs `karpathy review detect` (same finding B2c already made independently).
- **No physical file moves, no note deletion, no new LLM calls, no auto-archival of wiki content without human review** — all non-goals per §1, respected throughout every task below.

## Discrepancies found vs. the design doc (resolved inline in the affected tasks)

- **`serializeNote`'s underlying `gray-matter`/`js-yaml` stringifier does NOT omit `undefined`-valued keys — it throws.** The design's central "clear on un-archival" pattern (`data.archived_at = undefined; data.archived_reason = undefined;`) was verified directly against the real dependency:
  ```
  $ node -e "require('gray-matter').stringify('body', { archived_at: undefined })"
  YAMLException: unacceptable kind of an object to dump [object Undefined]
  ```
  Every G0/G7 promotion write and every G7 un-archival write in the design would crash the job runner the first time it fired. Fixed throughout this plan (Tasks 4, 6, 10) by using `delete obj.archived_at; delete obj.archived_reason;` instead, which was verified (same direct test) to correctly omit the keys from the serialized frontmatter with no error.
- **`compile-entities.ts`'s self-referential early-return branch (line 27-32) is not a simple mutation the design assumed it was.** The design's §4 says both of `compile-entities.ts`'s `ingest_status = 'linked'` write sites "get the identical block, immediately before their existing `ingest_status = 'linked'` assignment" — true for line 181 (a plain `data.ingest_status = 'linked';` statement), but the early-return branch at line 29 is an inline object-literal spread (`const updated = { ...summaryDataEarly, ingest_status: 'linked', updated_at: nowISO() };`) built from a *different* variable (`summaryDataEarly`, not `data`) with no separate statement to insert before. Task 4 restructures this branch to build `updated` first, then apply the promotion guard to `updated` before the existing `atomicWrite` call (see Task 4, Step 3).
- **`src/jobs/handlers/topic-refresh.ts` is not where G7's "successful protected-region rewrite" hook belongs.** That file is a 26-line wrapper that reserves a budget slot and delegates to `refreshTopic()` — a *different* file, `src/intelligence/topic-refresh.ts` (confirmed: `test/intelligence/topic-refresh.test.ts` imports `refreshTopic` directly from `../../src/intelligence/topic-refresh.js`, never touching the job-handler file). The design's §11 snippet targeting the job handler is corrected in Task 6 to modify `refreshTopic()` itself, right before its final `atomicWrite` call — reached only after a genuine synthesis, not either of the function's two early-return no-op branches (unsupported type; zero retrieval hits).
- **`src/config/loader.ts` has zero existing cross-field validation of any kind** — no `.refine()`, no warn-and-continue pattern anywhere. The design's §12 asks for a warning "alongside any existing cross-field validation," but none exists (the design's own text admits the analogous `decay.retrievabilityRefresh > decay.retrievabilityArchive` relationship is itself "unenforced"). No `console.warn` call exists anywhere in `src/` today either. Resolved in Task 2 by adding a small, independently unit-testable pure function (`lifecycleConfigWarnings`) rather than inventing an untested inline check — see Task 2.
- **`intelligence.decay.retrievabilityArchive` does not "remain meaningful" after G6 as the design's §8 prose claims — it becomes fully dead config.** Grep confirms its only reader anywhere in `src/` or `test/` is the exact `if (r < archiveThreshold && inbound === 0)` branch G6 deletes. Per the design's own non-goals (no schema restructuring), the field stays in `LifecycleConfigSchema`'s sibling `decay` schema unchanged — Task 9 documents this accurately as "now vestigial" rather than repeating the design's inaccurate "remains meaningful" framing. Separately **confirmed accurate**: `fm.retrievability`/`fm.retrievability_checked_at` stamping (two lines earlier in the same function, untouched by G6) is what actually feeds rot-scan's `RotEntry.retrievability` display column — that part of the design's claim holds.
- **Removing decay-scan.ts's dead branch requires removing more than the design called out, because `tsconfig.json` sets `"noUnusedLocals": true` and `"noUnusedParameters": true`.** Once the `if (r < archiveThreshold && inbound === 0) {...}` block is deleted, both the `archiveThreshold` local and the `inbound` local (and, transitively, the entire private `countInboundLinks()` helper, whose only call site was that same `inbound` assignment) become unused and would fail `pnpm lint`. Task 9 removes all three, not just the branch the design's snippet showed.
- **The design's §5 gates the new stale-draft reporting pass on `config.intelligence.lifecycle.staleDraftReportingEnabled`, a field §12's own `LifecycleConfigSchema` never defines.** (Only `enabled`, `staleDraftReportDays`, `staleDraftArchiveEnabled`, `staleDraftArchiveDays`, `archiveQueueEnabled` exist.) Resolved in Task 7 by not gating the pass behind any extra boolean — it always runs unconditionally, exactly like the pre-existing thin-content and bare-identity passes in the same function (neither is gated behind a flag either); only the numeric `staleDraftReportDays` threshold is configurable. This matches §14's decision table, which never mentions a reporting-specific enable flag.
- **`agent-ingest.ts`'s 4th `ingest_status = 'linked'` call site** (line 55 — confirmed exact match to the design's §15 edge-case note, which raised it almost in passing) **is a first-class part of Task 4**, with its own dedicated new test file (`test/jobs/handlers/agent-ingest.test.ts` — no test file previously existed for this handler at all), not left as a footnote.
- **`reconciliation-queue.ts` was read in full and confirmed to match §7's assumed shape exactly**, function-for-function (`readReconciliationQueue`/`writeReconciliationQueue`/`refreshQueue`/`resolveEntry`/`pendingEntries`, the same `OPEN_TAG`/`CLOSE_TAG` region-JSON-blob pattern, the same pair-key dedup). Task 3's `archive-queue.ts` mirrors it directly, with one deliberate addition beyond the design's literal snippet: a shared `applyArchiveDecision()` helper, since the design left the archive/supersede note-mutation logic duplicated between §9's CLI pseudocode and its MCP-tool description with no single place it lives. Centralizing it in `archive-queue.ts` means `karpathy archivist` (Task 10) and `resolve_archive_candidate` (Task 10) are both thin wrappers around one well-tested function instead of two independent, drifting copies of the same mutation.
- **`curatorCommand()` — the exact pattern §9 says `archivistCommand` should be "modeled on" — has zero test coverage in this codebase today**, and there is no established pattern anywhere in `test/bin/` for testing an interactive-readline CLI command (confirmed: that directory only covers `drain-queue-exit`, `hook-stdin-timeout`, `install-hooks`, `intel-tick-exit`, none of which touch readline). Task 10 does not invent new subprocess/readline test infrastructure to cover `archivistCommand` itself — disproportionate scope for mirroring a pattern that is itself untested — and instead achieves full coverage of the actual decision-application logic via `applyArchiveDecision()`'s tests (Task 3) and `resolve_archive_candidate`'s tests (Task 10), both plain async functions. This is stated explicitly rather than silently skipped.
- **Minor:** the design's §6 prose describes `DEFAULT_PRIORITIES['archive-stale-drafts'] = 90` as "same tier as rot-scan/decay-scan," but `rot-scan`/`decay-scan` are both `95` in the real file, not `90`. Implemented with the literal value `90` as the design explicitly specified (a reasonable one-tier-below-95 choice for a bulk sweep vs. a diagnostic scan) — just noting the surrounding prose was imprecise, not "fixing" the number.
- **Confirmed accurate, no discrepancy:** `agent-ingest.ts:55` (`data.ingest_status = 'linked';`), `link-concepts.ts:220-227`, `compile-entities.ts:181` all match the design's line references and code shapes exactly. `decay-scan.ts`'s dead branch is at lines 101-105 exactly as cited. `rot-scan.ts` already has `bareIdentityCandidates`/`BareIdentityEntry` merged in (from the already-shipped B2c work), matching what §5's "current state" snippet assumed before adding `staleDraftCandidates`. `curatorCommand`/`reconcile-entities.ts` work exactly as §9 assumes (confirmed by reading both in full). `nowISO`, `appendLogEntry(vault, entry, layout)`, `layoutFromConfig`, `DEFAULT_PRIORITIES`, `defaultSchedule()`, `asString` (in `rot-scan.ts`) all exist with the exact names/signatures the design assumes.

## Global Constraints

- ESM only — all imports use `.js` extensions, even for `.ts` source files.
- Strict TypeScript — `pnpm lint` (`tsc --noEmit`) must pass with no errors. Note `tsconfig.json` sets `noUnusedLocals`/`noUnusedParameters: true` and **excludes `test/` from type-checking** (`"exclude": ["node_modules", "dist", "test"]`) — test-file mock shapes are not type-checked by `pnpm lint`, only `src/**/*` is.
- `pnpm build && pnpm test && pnpm lint` must all pass before any commit.
- Vitest is the test runner; tests live under `test/`, mirroring `src/` structure. Tests use real temp directories + `createFsAdapter` + real `KarpathyConfigSchema.parse(...)` — never mock vault I/O.
- No new runtime dependencies.
- Every component in this plan is deterministic-lane (spec §7.1) — no new LLM calls anywhere. Nothing in this plan needs to special-case `TransientLLMError`.
- Never use `obj.field = undefined` to clear an optional frontmatter field before `serializeNote` — use `delete obj.field` (see "Discrepancies" above). This applies to every task that clears `archived_at`/`archived_reason`.
- `test/bin/intel-tick-exit.test.ts` is a known pre-existing flake in this environment (spawns the real CLI against whatever vault is configured on the host machine, unrelated to this plan) — if it's the only failure in a full `pnpm test` run, treat the run as clean.

---

### Task 1: Frontmatter additions — `archived_at`, `archived_reason`

**Files:**
- Modify: `src/vault/frontmatter.ts`
- Test: `test/vault/frontmatter.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: `BaseFrontmatterSchema` gains `archived_at?: string`, `archived_reason?: string` — consumed by every later task that reads/writes archival state (Tasks 4, 6, 7, 8, 9, 10).

- [ ] **Step 1: Write the failing test**

Add to `test/vault/frontmatter.test.ts`, inside the existing `describe('validateFrontmatter', ...)` block, right after the existing `'applies defaults for optional fields'` test (before that describe block's closing `});`):

```typescript
  it('archived_at/archived_reason are absent by default and round-trip when set (Sub-project C)', () => {
    const withoutArchival = BaseFrontmatterSchema.parse({
      id: 'archival-1',
      type: 'source_summary',
      title: 'No archival fields',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    });
    expect(withoutArchival.archived_at).toBeUndefined();
    expect(withoutArchival.archived_reason).toBeUndefined();

    const withArchival = BaseFrontmatterSchema.parse({
      id: 'archival-2',
      type: 'source_summary',
      title: 'Archived',
      status: 'archived',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      archived_at: '2026-05-01T00:00:00.000Z',
      archived_reason: 'stale-draft (34d at ingest_status: detected)',
    });
    expect(withArchival.archived_at).toBe('2026-05-01T00:00:00.000Z');
    expect(withArchival.archived_reason).toBe('stale-draft (34d at ingest_status: detected)');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/vault/frontmatter.test.ts`
Expected: FAIL — `withoutArchival.archived_at`/`archived_reason` are `undefined` already (harmless coincidence), but `withArchival.archived_at`/`archived_reason` are also `undefined` because Zod strips unrecognized keys — the second half of the assertion fails (`expect(undefined).toBe('2026-05-01T00:00:00.000Z')`).

- [ ] **Step 3: Write minimal implementation**

In `src/vault/frontmatter.ts`, change:

```typescript
  /**
   * Phase 3 (cross-project bridges): absolute project paths whose chunks
   * reference this concept. Maintained by `detect-bridges`.
   */
  also_relevant_to: z.array(z.string()).default([]),
});
export type BaseFrontmatter = z.infer<typeof BaseFrontmatterSchema>;
```

to:

```typescript
  /**
   * Phase 3 (cross-project bridges): absolute project paths whose chunks
   * reference this concept. Maintained by `detect-bridges`.
   */
  also_relevant_to: z.array(z.string()).default([]),

  // --- Sub-project C: draft/archival lifecycle ---
  /** ISO timestamp this note transitioned to status: archived. Deleted (not set to undefined — gray-matter's stringifier throws on undefined values) on un-archival. */
  archived_at: z.string().optional(),
  /** Free-text reason the note was archived, e.g. "stale-draft (34d at ingest_status: detected)", "rot-scan: age 9999d, confidence unknown, inbound no", "superseded". Deleted on un-archival. */
  archived_reason: z.string().optional(),
});
export type BaseFrontmatter = z.infer<typeof BaseFrontmatterSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/vault/frontmatter.test.ts`
Expected: PASS — including every pre-existing test in this file (regression: purely additive, optional fields).

- [ ] **Step 5: Commit**

```bash
git add src/vault/frontmatter.ts test/vault/frontmatter.test.ts
git commit -m "feat(vault): add archived_at/archived_reason to BaseFrontmatterSchema"
```

---

### Task 2: Config schema — `intelligence.lifecycle`

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Test: `test/config/schema.test.ts` (extend existing file)
- Test: `test/config/loader.test.ts` (new file)

**Interfaces:**
- Consumes: nothing (foundation task, independent of Task 1).
- Produces: `LifecycleConfigSchema` (exported Zod schema); `KarpathyConfig['intelligence']['lifecycle']: { enabled: boolean; staleDraftReportDays: number; staleDraftArchiveEnabled: boolean; staleDraftArchiveDays: number; archiveQueueEnabled: boolean }`; `lifecycleConfigWarnings(config): string[]` (pure, exported from `loader.ts`) — consumed by every later task that reads `config.intelligence.lifecycle.*` (Tasks 4, 6, 7, 8, 9).

- [ ] **Step 1: Write the failing tests**

Add to `test/config/schema.test.ts`, a new `describe` block after the existing `'KarpathyConfigSchema — enrichment.personResolution'` block:

```typescript
describe('KarpathyConfigSchema — intelligence.lifecycle', () => {
  it('defaults intelligence.lifecycle when omitted, with staleDraftArchiveEnabled OFF', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.lifecycle).toEqual({
      enabled: true,
      staleDraftReportDays: 14,
      staleDraftArchiveEnabled: false,
      staleDraftArchiveDays: 30,
      archiveQueueEnabled: true,
    });
  });

  it('allows overriding staleDraftArchiveEnabled and staleDraftArchiveDays', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 45 } },
    });
    expect(config.intelligence.lifecycle.staleDraftArchiveEnabled).toBe(true);
    expect(config.intelligence.lifecycle.staleDraftArchiveDays).toBe(45);
    // Other fields still default.
    expect(config.intelligence.lifecycle.staleDraftReportDays).toBe(14);
    expect(config.intelligence.lifecycle.archiveQueueEnabled).toBe(true);
  });
});
```

Create `test/config/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { lifecycleConfigWarnings } from '../../src/config/loader.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('lifecycleConfigWarnings', () => {
  it('returns no warnings when staleDraftArchiveDays >= staleDraftReportDays (the default relationship)', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(lifecycleConfigWarnings(config)).toEqual([]);
  });

  it('warns when staleDraftArchiveDays < staleDraftReportDays', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { lifecycle: { staleDraftArchiveDays: 5, staleDraftReportDays: 14 } },
    });
    const warnings = lifecycleConfigWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('staleDraftArchiveDays');
    expect(warnings[0]).toContain('staleDraftReportDays');
  });

  it('does not warn when the two thresholds are equal', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { lifecycle: { staleDraftArchiveDays: 14, staleDraftReportDays: 14 } },
    });
    expect(lifecycleConfigWarnings(config)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/config/schema.test.ts test/config/loader.test.ts`
Expected: FAIL — `config.intelligence.lifecycle` is `undefined` in the schema test; `test/config/loader.test.ts` fails to even import `lifecycleConfigWarnings` (does not exist yet).

- [ ] **Step 3: Write minimal implementation**

In `src/config/schema.ts`, add the new schema right before `IntelligenceConfigSchema` (it must be defined first since `IntelligenceConfigSchema` will reference it):

```typescript
/**
 * Sub-project C: draft/archival lifecycle. Master gate (`enabled`) plus
 * per-mechanism knobs — see docs/superpowers/specs/2026-07-31-sub-project-c-
 * draft-archival-lifecycle-design.md §12 for the full rationale.
 */
export const LifecycleConfigSchema = z.object({
  /** Master gate for all Sub-project C behavior (G0-G7). */
  enabled: z.boolean().default(true),
  /** G1: age (days) past which a draft source_summary appears in vault-health.md's
   *  "Stale draft sources" table. */
  staleDraftReportDays: z.number().int().positive().default(14),
  /**
   * G2: gate for auto-archiving stale drafts. Defaults to **false** — with a
   * large real-vault backlog of already-stale drafts, defaulting this on
   * would silently archive the majority of source_summary notes the moment
   * the daily job first runs after deploy. G0/G1/G3-G5 and the reporting
   * table are unaffected by this default and work identically regardless.
   * An operator opts in explicitly once ready.
   */
  staleDraftArchiveEnabled: z.boolean().default(false),
  /** G2: age (days) past which a draft source_summary is auto-archived (once
   *  staleDraftArchiveEnabled is true). Should be >= staleDraftReportDays — a
   *  note should always be reported as stale before it's auto-archived; see
   *  `lifecycleConfigWarnings` in config/loader.ts for the (warn-only) check. */
  staleDraftArchiveDays: z.number().int().positive().default(30),
  /** G3: gate for rot-scan feeding its candidates into the archive queue.
   *  Independent of maintenance.reviewEnabled — this queue is populated by
   *  the always-scheduled weekly rot-scan job, not by the reviewEnabled-
   *  gated detect-* jobs. */
  archiveQueueEnabled: z.boolean().default(true),
});
```

Then in `IntelligenceConfigSchema`, add `lifecycle` as the last field (after `research`):

```typescript
      /** Pluggable web search backend. `noop` = LLM-only, `duckduckgo` = no-key fallback, `mcp` = local search MCP server. */
      search: z
        .object({
          provider: z.enum(['noop', 'duckduckgo', 'mcp']).default('noop'),
          mcp: z
            .object({
              command: z.string().optional(),
              args: z.array(z.string()).default([]),
              toolName: z.string().default('search'),
              queryArg: z.string().default('query'),
              countArg: z.string().default('count'),
              extraArgs: z.record(z.unknown()).optional(),
              env: z.record(z.string()).optional(),
            })
            .optional(),
        })
        .default({}),
    })
    .default({}),
});
```

to:

```typescript
      /** Pluggable web search backend. `noop` = LLM-only, `duckduckgo` = no-key fallback, `mcp` = local search MCP server. */
      search: z
        .object({
          provider: z.enum(['noop', 'duckduckgo', 'mcp']).default('noop'),
          mcp: z
            .object({
              command: z.string().optional(),
              args: z.array(z.string()).default([]),
              toolName: z.string().default('search'),
              queryArg: z.string().default('query'),
              countArg: z.string().default('count'),
              extraArgs: z.record(z.unknown()).optional(),
              env: z.record(z.string()).optional(),
            })
            .optional(),
        })
        .default({}),
    })
    .default({}),
  /** Sub-project C: draft/archival lifecycle. */
  lifecycle: LifecycleConfigSchema.default({}),
});
```

No other schema changes needed: `PartialIntelligenceConfigSchema = IntelligenceConfigSchema.partial()` (already present) picks up the new nested field automatically — same precedent as `intelligence.richness` (B2b) and `intelligence.refresh` (Phase 1). No `ProjectOverrideSchema`/`GlobalDefaultsSchema` changes needed either (both already reference `PartialIntelligenceConfigSchema` generically).

In `src/config/loader.ts`, add the warning function right after the `mergeOverride` function and before `readGlobalConfig`:

```typescript
/**
 * Sub-project C: warn (never throw) when the auto-archive threshold is set
 * below the reporting threshold — a draft should always be surfaced in
 * vault-health.md's "Stale draft sources" table before it's silently
 * auto-archived. Exported as a pure function (not inlined into
 * loadConfig/loadConfigOrNull) so it's independently unit-testable without
 * touching the real, homedir-based GLOBAL_CONFIG_PATH those two functions
 * read from — there is no existing cross-field validation anywhere in this
 * file to follow a precedent from (the analogous
 * `decay.retrievabilityRefresh > decay.retrievabilityArchive` relationship
 * is itself unenforced today).
 */
export function lifecycleConfigWarnings(config: KarpathyConfig): string[] {
  const warnings: string[] = [];
  const { staleDraftArchiveDays, staleDraftReportDays } = config.intelligence.lifecycle;
  if (staleDraftArchiveDays < staleDraftReportDays) {
    warnings.push(
      `intelligence.lifecycle.staleDraftArchiveDays (${staleDraftArchiveDays}) is less than ` +
        `staleDraftReportDays (${staleDraftReportDays}) — a draft would be auto-archived before ` +
        `it is ever reported as stale in vault-health.md.`,
    );
  }
  return warnings;
}
```

Then call it at the end of both `loadConfigOrNull` and `loadConfig`, right before each `return` statement. In `loadConfigOrNull`, change:

```typescript
  const result = KarpathyConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(
      `Resolved config for ${root} is invalid:\n${issues}`,
    );
  }

  return {
    ...result.data,
    projectRoot: root,
    vaultPath: resolve(result.data.vaultPath),
  };
}

/**
 * Load and resolve Karpathy config, throwing a ConfigError when the global
 * config is missing or vaultPath cannot be determined.
 */
export async function loadConfig(projectRoot?: string): Promise<KarpathyConfig> {
```

to:

```typescript
  const result = KarpathyConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(
      `Resolved config for ${root} is invalid:\n${issues}`,
    );
  }

  for (const warning of lifecycleConfigWarnings(result.data)) {
    console.warn(`[karpathy config] ${warning}`);
  }

  return {
    ...result.data,
    projectRoot: root,
    vaultPath: resolve(result.data.vaultPath),
  };
}

/**
 * Load and resolve Karpathy config, throwing a ConfigError when the global
 * config is missing or vaultPath cannot be determined.
 */
export async function loadConfig(projectRoot?: string): Promise<KarpathyConfig> {
```

And apply the identical two-line addition (`for (const warning of lifecycleConfigWarnings(result.data)) { console.warn(...); }`) to `loadConfig`'s own `result = KarpathyConfigSchema.safeParse(merged)` block, right before its own `return { ...result.data, projectRoot: root, vaultPath: resolve(result.data.vaultPath) };`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/config/schema.test.ts test/config/loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/loader.ts test/config/schema.test.ts test/config/loader.test.ts
git commit -m "feat(config): add intelligence.lifecycle schema and stale-draft threshold warning"
```

---

### Task 3: Archive-queue infrastructure (G3)

**Files:**
- Create: `src/maintenance/archive-queue.ts`
- Test: `test/maintenance/archive-queue.test.ts` (new file)

**Interfaces:**
- Consumes: `OPEN_TAG`/`CLOSE_TAG` (`src/vault/protected-regions.js`); `DEFAULT_LAYOUT`, `type VaultLayout` (`src/vault/paths.js`); `parseNote`, `serializeNote` (`src/vault/frontmatter.js`); `nanoid` (already a dependency, confirmed used identically in `reconciliation-queue.ts`).
- Produces: `ARCHIVE_QUEUE_REGION`, `ArchiveQueueStatus`, `ArchiveDecision`, `ArchiveCandidate`, `ArchiveEntry`, `ArchiveQueue`, `archiveQueuePath(layout)`, `readArchiveQueue(vault, layout?)`, `writeArchiveQueue(vault, queue, layout?)`, `refreshArchiveQueue(vault, candidates, layout?): Promise<number>`, `resolveArchiveEntry(vault, id, decision, supersededByPath?, layout?): Promise<ArchiveEntry | null>`, `pendingArchiveEntries(queue): ArchiveEntry[]`, `applyArchiveDecision(vault, entry, decision, supersededByPath?, layout?): Promise<ArchiveEntry | null>` — consumed by Task 9 (rot-scan feed) and Task 10 (CLI + MCP).

- [ ] **Step 1: Write the failing tests**

Create `test/maintenance/archive-queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  readArchiveQueue,
  writeArchiveQueue,
  refreshArchiveQueue,
  resolveArchiveEntry,
  pendingArchiveEntries,
  applyArchiveDecision,
  type ArchiveEntry,
} from '../../src/maintenance/archive-queue.js';
import { serializeNote, parseNote } from '../../src/vault/frontmatter.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });
const layout = config.layout;

describe('archive-queue', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-aq-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder(layout.system);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty queue when file does not exist', async () => {
    const queue = await readArchiveQueue(vault, layout);
    expect(queue.entries).toEqual([]);
  });

  it('round-trips entries through write/read', async () => {
    await writeArchiveQueue(vault, {
      entries: [{
        id: 'abc',
        status: 'pending',
        path: 'wiki/concepts/glossary.md',
        title: 'Concept glossary',
        reason: 'rot-scan: age 9999d, confidence unknown, inbound no',
        ageDays: 9999,
        confidence: 'unknown',
      }],
    }, layout);

    const queue = await readArchiveQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0].id).toBe('abc');
    expect(queue.entries[0].title).toBe('Concept glossary');
    expect(queue.entries[0].status).toBe('pending');
  });

  it('refreshArchiveQueue appends new candidates', async () => {
    const candidates = [{
      path: 'wiki/topics/old-topic.md',
      title: 'Old topic',
      reason: 'rot-scan: age 300d, confidence low, inbound no',
      ageDays: 300,
      confidence: 'low',
    }];

    const added = await refreshArchiveQueue(vault, candidates, layout);
    expect(added).toBe(1);

    const queue = await readArchiveQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0].status).toBe('pending');
  });

  it('refreshArchiveQueue is idempotent — same path not re-added regardless of resolution status', async () => {
    const candidates = [{
      path: 'wiki/projects/dead-project.md',
      title: 'Dead project',
      reason: 'rot-scan: age 500d, confidence low, inbound no',
      ageDays: 500,
      confidence: 'low',
    }];

    const first = await refreshArchiveQueue(vault, candidates, layout);
    expect(first).toBe(1);

    const queue = await readArchiveQueue(vault, layout);
    await resolveArchiveEntry(vault, queue.entries[0].id, 'keep', undefined, layout);

    const second = await refreshArchiveQueue(vault, candidates, layout);
    expect(second).toBe(0);

    const finalQueue = await readArchiveQueue(vault, layout);
    expect(finalQueue.entries).toHaveLength(1);
    expect(finalQueue.entries[0].status).toBe('resolved');
  });

  it('resolveArchiveEntry marks entry resolved with decision', async () => {
    await writeArchiveQueue(vault, {
      entries: [{
        id: 'entry1', status: 'pending', path: 'a.md', title: 'A',
        reason: 'test', ageDays: 100, confidence: 'low',
      }],
    }, layout);

    const resolved = await resolveArchiveEntry(vault, 'entry1', 'archive', undefined, layout);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.decision).toBe('archive');
    expect(resolved!.resolvedAt).toBeDefined();
  });

  it('resolveArchiveEntry marks a skip decision as status: skipped', async () => {
    await writeArchiveQueue(vault, {
      entries: [{
        id: 'entry2', status: 'pending', path: 'b.md', title: 'B',
        reason: 'test', ageDays: 100, confidence: 'low',
      }],
    }, layout);

    const resolved = await resolveArchiveEntry(vault, 'entry2', 'skip', undefined, layout);
    expect(resolved!.status).toBe('skipped');
  });

  it('resolveArchiveEntry returns null for unknown id', async () => {
    await writeArchiveQueue(vault, { entries: [] }, layout);
    const result = await resolveArchiveEntry(vault, 'nonexistent', 'keep', undefined, layout);
    expect(result).toBeNull();
  });

  it('pendingArchiveEntries filters to pending status only', async () => {
    const queue = {
      entries: [
        { id: '1', status: 'pending' as const, path: 'a.md', title: 'A', reason: 'r', ageDays: 1, confidence: 'low' },
        { id: '2', status: 'resolved' as const, path: 'b.md', title: 'B', reason: 'r', ageDays: 1, confidence: 'low', decision: 'archive' as const, resolvedAt: new Date().toISOString() },
        { id: '3', status: 'skipped' as const, path: 'c.md', title: 'C', reason: 'r', ageDays: 1, confidence: 'low' },
      ],
    };
    const pending = pendingArchiveEntries(queue);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('1');
  });

  describe('applyArchiveDecision', () => {
    async function makeEntry(path: string, type = 'concept'): Promise<ArchiveEntry> {
      await vault.create(
        path,
        serializeNote(
          { id: 'x1', type, title: 'Target', status: 'draft', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
          '# Target\n',
        ),
      );
      await refreshArchiveQueue(vault, [{
        path, title: 'Target', reason: 'rot-scan: age 400d, confidence low, inbound no', ageDays: 400, confidence: 'low',
      }], layout);
      const queue = await readArchiveQueue(vault, layout);
      return queue.entries[0];
    }

    it('"archive" sets status: archived, archived_at, archived_reason (from entry.reason) on the target note', async () => {
      const entry = await makeEntry('wiki/concepts/target.md');
      const resolved = await applyArchiveDecision(vault, entry, 'archive', undefined, layout);
      expect(resolved!.status).toBe('resolved');
      expect(resolved!.decision).toBe('archive');

      const { data } = parseNote(await vault.read('wiki/concepts/target.md'));
      expect(data.status).toBe('archived');
      expect(data.archived_at).toBeDefined();
      expect(data.archived_reason).toBe(entry.reason);
    });

    it('"archive" also sets project_status: archived when the target note is type: project (G4)', async () => {
      const entry = await makeEntry('wiki/projects/target-project.md', 'project');
      await applyArchiveDecision(vault, entry, 'archive', undefined, layout);

      const { data } = parseNote(await vault.read('wiki/projects/target-project.md'));
      expect(data.status).toBe('archived');
      expect(data.project_status).toBe('archived');
    });

    it('"supersede" archives the note and appends supersededByPath to superseded_by, deduped across repeat calls (G4)', async () => {
      const entry = await makeEntry('wiki/concepts/old.md');
      await vault.create(
        'wiki/concepts/new.md',
        serializeNote(
          { id: 'x2', type: 'concept', title: 'New', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
          '# New\n',
        ),
      );

      const resolved = await applyArchiveDecision(vault, entry, 'supersede', 'wiki/concepts/new.md', layout);
      expect(resolved!.decision).toBe('supersede');
      expect(resolved!.supersededByPath).toBe('wiki/concepts/new.md');

      const { data } = parseNote(await vault.read('wiki/concepts/old.md'));
      expect(data.status).toBe('archived');
      expect(data.archived_reason).toBe('superseded');
      expect(data.superseded_by).toEqual(['wiki/concepts/new.md']);
    });

    it('"keep" resolves the queue entry without touching the note', async () => {
      const entry = await makeEntry('wiki/concepts/keep-me.md');
      await applyArchiveDecision(vault, entry, 'keep', undefined, layout);

      const { data } = parseNote(await vault.read('wiki/concepts/keep-me.md'));
      expect(data.status).toBe('draft');

      const queue = await readArchiveQueue(vault, layout);
      expect(queue.entries[0].status).toBe('resolved');
      expect(queue.entries[0].decision).toBe('keep');
    });

    it('"skip" resolves the queue entry as skipped without touching the note', async () => {
      const entry = await makeEntry('wiki/concepts/skip-me.md');
      await applyArchiveDecision(vault, entry, 'skip', undefined, layout);

      const { data } = parseNote(await vault.read('wiki/concepts/skip-me.md'));
      expect(data.status).toBe('draft');

      const queue = await readArchiveQueue(vault, layout);
      expect(queue.entries[0].status).toBe('skipped');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/maintenance/archive-queue.test.ts`
Expected: FAIL — `src/maintenance/archive-queue.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/maintenance/archive-queue.ts`:

```typescript
// Sub-project C, G3: archive queue at `{layout.system}/archive-queue.md`.
//
// Persistent store for archive candidates surfaced by rot-scan's existing
// stale+orphan+low-confidence rule. Operators resolve entries via
// `karpathy archivist` (interactive CLI) or the `resolve_archive_candidate`
// MCP tool. Deliberately mirrors reconciliation-queue.ts's shape and API —
// same problem shape (a detector produces candidates; a human resolves them
// at their own pace; resolutions persist and are never re-proposed), but a
// separate file/mechanism since the candidate shape (single `path` vs.
// `sourcePath`+`targetPath`) and decision vocabulary
// (archive/keep/supersede/skip vs. merge/rename/skip/manual) both differ.

import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

export const ARCHIVE_QUEUE_REGION = 'archive-entries';

export type ArchiveQueueStatus = 'pending' | 'resolved' | 'skipped';
export type ArchiveDecision = 'archive' | 'keep' | 'supersede' | 'skip';

export interface ArchiveCandidate {
  path: string;
  title: string;
  reason: string;
  ageDays: number;
  confidence: string;
  retrievability?: number;
}

export interface ArchiveEntry extends ArchiveCandidate {
  id: string;
  status: ArchiveQueueStatus;
  decision?: ArchiveDecision;
  supersededByPath?: string;
  resolvedAt?: string;
}

export interface ArchiveQueue {
  entries: ArchiveEntry[];
}

export function archiveQueuePath(layout: VaultLayout): string {
  return `${layout.system}/archive-queue.md`;
}

const HEADER = `---
type: index
title: Archive queue
---

# Archive queue

Wiki pages the system has flagged as rot candidates (stale + orphan + low
confidence, per \`rot-scan\`). Use \`karpathy archivist\` to walk through
pending entries interactively, or the \`resolve_archive_candidate\` MCP tool
to resolve entries from within a Claude session.

Pending decisions are shown with **status: pending**. Resolved entries are
kept for audit purposes. Entries with **status: skipped** are not shown in
future archivist runs.

`;

export async function readArchiveQueue(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ArchiveQueue> {
  const path = archiveQueuePath(layout);
  if (!(await vault.exists(path))) return { entries: [] };

  const content = await vault.read(path);
  const open = OPEN_TAG(ARCHIVE_QUEUE_REGION);
  const close = CLOSE_TAG(ARCHIVE_QUEUE_REGION);
  const openIdx = content.indexOf(open);
  const closeIdx = openIdx >= 0 ? content.indexOf(close, openIdx + open.length) : -1;

  if (openIdx < 0 || closeIdx < 0) return { entries: [] };

  const inner = content.slice(openIdx + open.length, closeIdx).trim();
  if (!inner) return { entries: [] };

  try {
    const entries = JSON.parse(inner) as ArchiveEntry[];
    return { entries: Array.isArray(entries) ? entries : [] };
  } catch {
    return { entries: [] };
  }
}

export async function writeArchiveQueue(
  vault: VaultAdapter,
  queue: ArchiveQueue,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  await vault.ensureFolder(layout.system);

  const pending = queue.entries.filter((e) => e.status === 'pending').length;
  const resolved = queue.entries.filter((e) => e.status === 'resolved').length;
  const skipped = queue.entries.filter((e) => e.status === 'skipped').length;
  const summary = `*${pending} pending · ${resolved} resolved · ${skipped} skipped*\n\n`;

  const open = OPEN_TAG(ARCHIVE_QUEUE_REGION);
  const close = CLOSE_TAG(ARCHIVE_QUEUE_REGION);
  const json = JSON.stringify(queue.entries, null, 2);
  const body = `${HEADER}${summary}${open}\n${json}\n${close}\n`;

  await vault.atomicWrite(archiveQueuePath(layout), body);
}

/**
 * Append new candidates, deduplicated by `path` (unlike reconciliation-
 * queue's pair-key dedup — archive candidates are single notes, not pairs).
 * Existing entries in ANY status (pending/resolved/skipped) block
 * re-addition, so a 'keep' or 'skip' decision permanently silences that
 * candidate.
 */
export async function refreshArchiveQueue(
  vault: VaultAdapter,
  candidates: ArchiveCandidate[],
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const queue = await readArchiveQueue(vault, layout);
  const existing = new Set(queue.entries.map((e) => e.path));

  let added = 0;
  for (const candidate of candidates) {
    if (existing.has(candidate.path)) continue;
    existing.add(candidate.path);
    queue.entries.push({ id: nanoid(), status: 'pending', ...candidate });
    added++;
  }

  if (added > 0) {
    await writeArchiveQueue(vault, queue, layout);
  }

  return added;
}

/**
 * Apply a decision to a queue entry by id (queue bookkeeping only — no note
 * mutation). Returns the updated entry, or null if not found.
 */
export async function resolveArchiveEntry(
  vault: VaultAdapter,
  id: string,
  decision: ArchiveDecision,
  supersededByPath?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ArchiveEntry | null> {
  const queue = await readArchiveQueue(vault, layout);
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) return null;

  entry.status = decision === 'skip' ? 'skipped' : 'resolved';
  entry.decision = decision;
  entry.resolvedAt = new Date().toISOString();
  if (supersededByPath) entry.supersededByPath = supersededByPath;

  await writeArchiveQueue(vault, queue, layout);
  return entry;
}

/** Return only entries with status === 'pending'. */
export function pendingArchiveEntries(queue: ArchiveQueue): ArchiveEntry[] {
  return queue.entries.filter((e) => e.status === 'pending');
}

/**
 * Apply an archive/keep/supersede/skip decision end-to-end: 'archive' and
 * 'supersede' mutate the target note's frontmatter (never its body, never
 * deleting anything); 'keep' and 'skip' only update the queue entry. Shared
 * by `karpathy archivist` and the `resolve_archive_candidate` MCP tool so
 * the mutation logic lives in exactly one place.
 */
export async function applyArchiveDecision(
  vault: VaultAdapter,
  entry: ArchiveEntry,
  decision: ArchiveDecision,
  supersededByPath?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ArchiveEntry | null> {
  if (decision === 'archive' || decision === 'supersede') {
    const content = await vault.read(entry.path);
    const { data, body } = parseNote(content);
    data.status = 'archived';
    data.archived_at = new Date().toISOString();

    if (decision === 'archive') {
      data.archived_reason = entry.reason;
      if (data.type === 'project') data.project_status = 'archived';
    } else {
      data.archived_reason = 'superseded';
      const supersededBy = new Set((data.superseded_by as string[]) ?? []);
      if (supersededByPath) supersededBy.add(supersededByPath);
      data.superseded_by = [...supersededBy];
    }

    await vault.atomicWrite(entry.path, serializeNote(data, body));
  }

  return resolveArchiveEntry(vault, entry.id, decision, supersededByPath, layout);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/maintenance/archive-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/maintenance/archive-queue.ts test/maintenance/archive-queue.test.ts
git commit -m "feat(maintenance): add archive-queue infrastructure mirroring reconciliation-queue"
```

---

### Task 4: Draft/archived → active promotion on successful ingest (G0, G7)

**Files:**
- Modify: `src/jobs/handlers/link-concepts.ts`
- Modify: `src/jobs/handlers/compile-entities.ts`
- Modify: `src/jobs/handlers/agent-ingest.ts`
- Test: `test/jobs/handlers/link-concepts.test.ts` (extend existing file)
- Test: `test/jobs/handlers/compile-entities.test.ts` (extend existing file)
- Test: `test/jobs/handlers/agent-ingest.test.ts` (new file)

**Interfaces:**
- Consumes: `archived_at`/`archived_reason` (Task 1); `config.intelligence.lifecycle.enabled` (Task 2).
- Produces: nothing new for later tasks — this closes G0 (draft → active on real processing) and the ingest-side half of G7 (archived → active recovery) for all four real `ingest_status = 'linked'` call sites in the codebase.

- [ ] **Step 1: Write the failing tests**

Add to `test/jobs/handlers/link-concepts.test.ts`, a new `describe` block appended after the existing `describe('link-concepts handler', ...)` block's closing `});`:

```typescript
describe('link-concepts handler — draft/archived -> active promotion (Sub-project C, G0/G7)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'off' },
      ...overrides,
    });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-link-concepts-promo-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeSummary(path: string, status: string): Promise<void> {
    await vault.ensureFolder('sources');
    await vault.create(
      path,
      serializeNote(
        { id: 's1', type: 'source_summary', title: 'S', status, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\nBody.\n',
      ),
    );
  }

  it('promotes a draft source to active once entities are linked', async () => {
    const summaryPath = 'sources/draft.md';
    await makeSummary(summaryPath, 'draft');

    await linkConceptsHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });

  it('recovers an archived source to active, clearing archived_at/archived_reason (G7)', async () => {
    const summaryPath = 'sources/archived.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        {
          id: 's2', type: 'source_summary', title: 'S', status: 'archived',
          archived_at: '2026-04-01T00:00:00Z', archived_reason: 'stale-draft (40d at ingest_status: detected)',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
        },
        '\nBody.\n',
      ),
    );

    await linkConceptsHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });

  it('never overrides an explicit rejected status', async () => {
    const summaryPath = 'sources/rejected.md';
    await makeSummary(summaryPath, 'rejected');

    await linkConceptsHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('rejected');
  });

  it('does not promote when intelligence.lifecycle.enabled is false', async () => {
    const summaryPath = 'sources/draft-disabled.md';
    await makeSummary(summaryPath, 'draft');

    await linkConceptsHandler.execute(
      makeJob(summaryPath, {}),
      makeCtx({ intelligence: { lifecycle: { enabled: false } } }),
    );

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('draft');
  });
});
```

Add to `test/jobs/handlers/compile-entities.test.ts`, inside the existing `describe('compile-entities handler — self-reference filtering', ...)` block, two new tests right after the existing `'skips entity creation when project_slug matches the tool\'s own project root'` test (this exercises the early-return branch — line 29 — that Step 3 restructures):

```typescript
  it('promotes a draft self-referential source to active on the early-return path (Sub-project C, G0)', async () => {
    const { slugify } = await import('../../../src/vault/paths.js');
    const selfSlug = slugify(dir.split('/').pop()!);

    const summaryPath = 'sources/self-draft.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        { id: 's3', type: 'source_summary', title: 'Self session', status: 'draft', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: selfSlug },
        '\nBody.\n',
      ),
    );

    await compileEntitiesHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });

  it('recovers an archived self-referential source to active on the early-return path (G7)', async () => {
    const { slugify } = await import('../../../src/vault/paths.js');
    const selfSlug = slugify(dir.split('/').pop()!);

    const summaryPath = 'sources/self-archived.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        {
          id: 's4', type: 'source_summary', title: 'Self session', status: 'archived',
          archived_at: '2026-04-01T00:00:00Z', archived_reason: 'stale-draft (40d at ingest_status: detected)',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: selfSlug,
        },
        '\nBody.\n',
      ),
    );

    await compileEntitiesHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });
```

Add a third new test inside the existing `describe('compile-entities handler — glossary synthesis threshold', ...)` block (this exercises the normal-completion path — line 181), right after that block's existing `'does not enqueue glossary-synthesize when the threshold is not crossed'` test:

```typescript
  it('promotes a draft source to active on the normal completion path (Sub-project C, G0)', async () => {
    const ctx = makeCtx();
    await makeSummary('sources/normal-draft.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/normal-draft.md', { concepts: [{ name: 'Some Concept', definition: 'x', confidence: 0.9 }] }),
      ctx,
    );

    const { data } = parseNote(await vault.read('sources/normal-draft.md'));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });
```

Create `test/jobs/handlers/agent-ingest.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

vi.mock('../../../src/agent/runner.js', () => ({
  runIngestAgent: vi.fn(async () => ({
    completionData: { conversation_intent: 'test-intent' },
    agentResult: { turns: 1, toolCalls: 0 },
  })),
}));

import { agentIngestHandler } from '../../../src/jobs/handlers/agent-ingest.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(summaryPath: string, rawPath: string): Job {
  return {
    id: 'test-agent-ingest',
    type: 'agent-ingest',
    status: 'running',
    priority: 25,
    payload: { sourceSummaryPath: summaryPath, rawPath, contentCategory: 'ai-conversation-claude' },
    trigger: 'cascade',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('agent-ingest handler — draft/archived -> active promotion (Sub-project C, G0/G7, 4th call site)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-agent-ingest-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('raw');
    await vault.ensureFolder('outputs/source-summaries');
    await vault.create('raw/session.md', 'Raw session content.');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function makeSummary(path: string, status: string): Promise<void> {
    await vault.create(
      path,
      serializeNote(
        {
          id: 's1', type: 'source_summary', title: 'Session', status,
          source_type: 'transcript', source_path: 'raw/session.md', ingest_status: 'detected',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        },
        'body.',
      ),
    );
  }

  it('promotes a draft source to active once the agent completes', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'draft');

    await agentIngestHandler.execute(makeJob(summaryPath, 'raw/session.md'), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });

  it('recovers an archived source to active (G7)', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'archived');

    await agentIngestHandler.execute(makeJob(summaryPath, 'raw/session.md'), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });

  it('never overrides an explicit rejected status', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'rejected');

    await agentIngestHandler.execute(makeJob(summaryPath, 'raw/session.md'), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('rejected');
  });

  it('does not promote when intelligence.lifecycle.enabled is false', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'draft');

    await agentIngestHandler.execute(
      makeJob(summaryPath, 'raw/session.md'),
      makeCtx({ intelligence: { lifecycle: { enabled: false } } }),
    );

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('draft');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/jobs/handlers/link-concepts.test.ts test/jobs/handlers/compile-entities.test.ts test/jobs/handlers/agent-ingest.test.ts`
Expected: FAIL — `agent-ingest.test.ts` fails to find `agentIngestHandler` promotion behavior (status stays `draft`/`archived`/whatever it started as); the new link-concepts/compile-entities assertions on `data.status` fail identically (status never changes from its initial value today).

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/handlers/link-concepts.ts`, change:

```typescript
    // Update source summary with links
    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    data.links = [...new Set([...(data.links as string[] ?? []), ...linkedPaths])];
    data.ingest_status = 'linked';
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(summaryPath, updated);
```

to:

```typescript
    // Update source summary with links
    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    data.links = [...new Set([...(data.links as string[] ?? []), ...linkedPaths])];
    data.ingest_status = 'linked';
    // Sub-project C (G0/G7): a source that just got linked has demonstrably
    // been processed — promote out of 'draft', and out of 'archived' if a
    // prior stale-draft sweep or manual edit had parked it there. Never
    // touch 'rejected' — an explicit human rejection is a stronger signal
    // than pipeline progress. gray-matter's stringifier throws on
    // `undefined`-valued keys, so clearing archived_at/archived_reason uses
    // `delete`, not assignment.
    if (context.config.intelligence.lifecycle.enabled && data.status !== 'active' && data.status !== 'rejected') {
      data.status = 'active';
      delete data.archived_at;
      delete data.archived_reason;
    }
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(summaryPath, updated);
```

In `src/jobs/handlers/compile-entities.ts`, change the self-referential early-return branch:

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

to (this branch was built from a separate object literal, not a `data` mutation — restructured so the promotion guard can run against it; incidentally reuses the body already captured by the first `parseNote` call instead of re-parsing `summaryContentEarly` a second time):

```typescript
    const summaryContentEarly = await context.vault.read(sourceSummaryPath);
    const { data: summaryDataEarly, body: summaryBodyEarly } = parseNote(summaryContentEarly);
    const projectSlug = (summaryDataEarly.project_slug as string | undefined) ?? '_general';
    const selfSlug = slugify(basename(context.projectRoot));

    if (projectSlug === selfSlug) {
      log.debug('Skipping entity creation for self-referential source', { sourceSummaryPath, projectSlug });
      const updated: Record<string, unknown> = { ...summaryDataEarly, ingest_status: 'linked', updated_at: nowISO() };
      // Sub-project C (G0/G7): the self-referential no-op branch still
      // counts as "genuinely processed" — the pipeline correctly decided
      // there's nothing further to compile. Same guard as the normal
      // completion path below.
      if (context.config.intelligence.lifecycle.enabled && updated.status !== 'active' && updated.status !== 'rejected') {
        updated.status = 'active';
        delete updated.archived_at;
        delete updated.archived_reason;
      }
      await context.vault.atomicWrite(sourceSummaryPath, serializeNote(updated, summaryBodyEarly));
      return;
    }
```

Then, in the same file, change the normal-completion path:

```typescript
    // 3. Update source summary: set ingest_status to 'linked', update links array
    const { data, body } = parseNote(summaryContentEarly);
    const allPages = [...result.created, ...result.updated];
    data.links = [...new Set([...(data.links as string[] ?? []), ...allPages])];
    data.ingest_status = 'linked';
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(sourceSummaryPath, updated);
```

to:

```typescript
    // 3. Update source summary: set ingest_status to 'linked', update links array
    const { data, body } = parseNote(summaryContentEarly);
    const allPages = [...result.created, ...result.updated];
    data.links = [...new Set([...(data.links as string[] ?? []), ...allPages])];
    data.ingest_status = 'linked';
    // Sub-project C (G0/G7): same promotion guard as link-concepts.ts.
    if (context.config.intelligence.lifecycle.enabled && data.status !== 'active' && data.status !== 'rejected') {
      data.status = 'active';
      delete data.archived_at;
      delete data.archived_reason;
    }
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(sourceSummaryPath, updated);
```

In `src/jobs/handlers/agent-ingest.ts`, change:

```typescript
        data.ingest_status = 'linked';
        data.conversation_intent = result.completionData?.conversation_intent;

        const updated = serializeNote(data, body);
        await context.vault.atomicWrite(summaryPath, updated);
```

to:

```typescript
        data.ingest_status = 'linked';
        data.conversation_intent = result.completionData?.conversation_intent;
        // Sub-project C (G0/G7): agent-ingest's own completion path — a 4th
        // call site (alongside link-concepts.ts and compile-entities.ts's
        // two sites) that stamps ingest_status: 'linked'. Same guard.
        if (context.config.intelligence.lifecycle.enabled && data.status !== 'active' && data.status !== 'rejected') {
          data.status = 'active';
          delete data.archived_at;
          delete data.archived_reason;
        }

        const updated = serializeNote(data, body);
        await context.vault.atomicWrite(summaryPath, updated);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/jobs/handlers/link-concepts.test.ts test/jobs/handlers/compile-entities.test.ts test/jobs/handlers/agent-ingest.test.ts`
Expected: PASS — including every pre-existing test in `link-concepts.test.ts` and `compile-entities.test.ts` (regression: the existing `'skips entity creation...'`/`'does not skip...'`/glossary-threshold tests never asserted on `data.status`, so they're unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/handlers/link-concepts.ts src/jobs/handlers/compile-entities.ts src/jobs/handlers/agent-ingest.ts test/jobs/handlers/link-concepts.test.ts test/jobs/handlers/compile-entities.test.ts test/jobs/handlers/agent-ingest.test.ts
git commit -m "feat(jobs): promote draft/archived source_summary notes to active on successful linking"
```

---

### Task 5: `review_state` → `status` wiring (G5)

**Files:**
- Modify: `src/review/review-queue.ts`
- Test: `test/review/review.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing new (`NoteStatus`'s `'rejected'` value already exists in the schema since before this spec).
- Produces: nothing new for later tasks — gives `NoteStatus`'s `rejected` value its first real producer.

- [ ] **Step 1: Write the failing tests**

Add to `test/review/review.test.ts`, inside the existing `describe('Review queue', ...)` block, two new tests right after the existing `'rejects a review item'` test:

```typescript
  it('approving a review item sets status: active (Sub-project C, G5)', async () => {
    await vault.create(
      'review/approve-status.md',
      '---\ntitle: Approve Status\nstatus: draft\nreview_state: unreviewed\nupdated_at: "2026-04-11T00:00:00.000Z"\n---\n# Test\n\n## Analysis\n%% begin:analysis %%\nPending.\n%% end:analysis %%\n',
    );

    await approveReviewItem(vault, 'review/approve-status.md');
    const content = await vault.read('review/approve-status.md');
    expect(content).toContain('review_state: approved');
    expect(content).toContain('status: active');
  });

  it('rejecting a review item sets status: rejected (Sub-project C, G5 — NoteStatus\'s 4th enum value, first real producer)', async () => {
    await vault.create(
      'review/reject-status.md',
      '---\ntitle: Reject Status\nstatus: draft\nreview_state: unreviewed\nresolution_state: open\nupdated_at: "2026-04-11T00:00:00.000Z"\n---\n# Test\n\n## Analysis\n%% begin:analysis %%\nPending.\n%% end:analysis %%\n',
    );

    await rejectReviewItem(vault, 'review/reject-status.md');
    const content = await vault.read('review/reject-status.md');
    expect(content).toContain('review_state: rejected');
    expect(content).toContain('resolution_state: dismissed');
    expect(content).toContain('status: rejected');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/review/review.test.ts`
Expected: FAIL — the new fixtures' `status: draft` line is left completely untouched by `approveReviewItem`/`rejectReviewItem` today, so `content` never contains `'status: active'`/`'status: rejected'`.

- [ ] **Step 3: Write minimal implementation**

In `src/review/review-queue.ts`, change:

```typescript
export async function approveReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: approved')
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);

  updated = updateProtectedRegion(
    updated,
    'analysis',
    (extractAnalysis(updated) + '\n\n**Approved** at ' + nowISO()).trim(),
  );

  await vault.write(path, updated);
  log.info('Review item approved', { path });
}

export async function rejectReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: rejected')
    .replace(/resolution_state: \w+/, 'resolution_state: dismissed')
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);

  updated = updateProtectedRegion(
    updated,
    'analysis',
    (extractAnalysis(updated) + '\n\n**Rejected** at ' + nowISO()).trim(),
  );

  await vault.write(path, updated);
  log.info('Review item rejected', { path });
}
```

to:

```typescript
export async function approveReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: approved')
    .replace(/status: \w+/, 'status: active') // Sub-project C (G5)
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);

  updated = updateProtectedRegion(
    updated,
    'analysis',
    (extractAnalysis(updated) + '\n\n**Approved** at ' + nowISO()).trim(),
  );

  await vault.write(path, updated);
  log.info('Review item approved', { path });
}

export async function rejectReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: rejected')
    .replace(/resolution_state: \w+/, 'resolution_state: dismissed')
    .replace(/status: \w+/, 'status: rejected') // Sub-project C (G5) — NoteStatus's 4th enum value, first real producer
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);

  updated = updateProtectedRegion(
    updated,
    'analysis',
    (extractAnalysis(updated) + '\n\n**Rejected** at ' + nowISO()).trim(),
  );

  await vault.write(path, updated);
  log.info('Review item rejected', { path });
}
```

This is a plain string `.replace()`, matching the file's existing style for `review_state`/`resolution_state`/`updated_at` (not `parseNote`/`serializeNote`) — `create-review-item.ts` always writes a flat, single-line `status: "draft"` (confirmed: its frontmatter is built via `Object.entries(...).map(([k, v]) => \`${k}: ${JSON.stringify(v)}\`)`, never YAML block form), so the same regex approach that already works for the other two fields on this exact file shape works identically here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/review/review.test.ts`
Expected: PASS — including every pre-existing test in this file (regression: the two pre-existing approve/reject fixtures have no `status:` line at all, so the new `.replace(/status: \w+/, ...)` is a harmless no-op against them — confirmed by inspection, no assertion in those two tests depends on `status`).

- [ ] **Step 5: Commit**

```bash
git add src/review/review-queue.ts test/review/review.test.ts
git commit -m "feat(review): wire status transitions into review-item approve/reject"
```

---

### Task 6: Un-archival on re-engagement (G7 — topic-refresh, re-enrich-note)

**Files:**
- Modify: `src/intelligence/topic-refresh.ts` (**not** `src/jobs/handlers/topic-refresh.ts` — see "Discrepancies" above)
- Modify: `src/jobs/handlers/re-enrich-note.ts`
- Test: `test/intelligence/topic-refresh.test.ts` (extend existing file)
- Test: `test/jobs/handlers/re-enrich-note.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `archived_at`/`archived_reason` (Task 1).
- Produces: nothing new for later tasks — closes the remaining half of G7 for wiki content archived via Task 10's queue resolution.

- [ ] **Step 1: Write the failing tests**

Add to `test/intelligence/topic-refresh.test.ts`, inside the existing `describe('topic-refresh (B2)', ...)` block, three new tests (place them after the existing `'integrates new evidence and bumps last_verified + stability'` test — reuse that test's `store.upsert([...])` fixture shape for the successful-synthesis case):

```typescript
  it('un-archives a note on a successful synthesis, clearing archived_at/archived_reason (Sub-project C, G7)', async () => {
    const topicPath = 'wiki/topics/archived-topic.md';
    await vault.create(
      topicPath,
      `---
id: t2
type: topic
title: Archived topic
status: archived
archived_at: 2026-04-01T00:00:00Z
archived_reason: "rot-scan: age 400d, confidence low, inbound no"
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
last_verified: 2026-04-01T00:00:00Z
stability: 30
half_life_domain: topic
---
# Archived topic

%% begin:current-understanding %%
Old framing.
%% end:current-understanding %%
`,
    );

    await store.upsert([
      {
        doc_id: 'wiki/sessions/2026-04-15.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'New evidence about the archived topic surfaced recently.',
        metadata: { type: 'session_summary' },
      },
    ]);

    await refreshTopic({ vault, llm: fakeLLM({
      primary: 'Updated framing incorporating the new evidence.',
      contradictions: [],
      new_sources: [],
    }), store, config }, topicPath);

    const { data } = parseNote(await vault.read(topicPath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });

  it('does not un-archive when no supporting evidence is retrieved (no-op branch)', async () => {
    const topicPath = 'wiki/topics/archived-no-evidence.md';
    await vault.create(
      topicPath,
      `---
id: t3
type: topic
title: Archived, no evidence
status: archived
archived_at: 2026-04-01T00:00:00Z
archived_reason: "rot-scan: age 400d, confidence low, inbound no"
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
last_verified: 2026-04-01T00:00:00Z
stability: 30
half_life_domain: topic
---
# Archived, no evidence

%% begin:current-understanding %%
Old framing.
%% end:current-understanding %%
`,
    );

    // No embeddings upserted — retrieve() will find zero hits.
    await refreshTopic({ vault, llm: fakeLLM({ primary: '', contradictions: [], new_sources: [] }), store, config }, topicPath);

    const { data } = parseNote(await vault.read(topicPath));
    expect(data.status).toBe('archived');
    expect(data.archived_at).toBeDefined();
    expect(data.archived_reason).toBeDefined();
  });

  it('does not un-archive for an unsupported note type (no-op branch)', async () => {
    await vault.ensureFolder('wiki/misc');
    const notePath = 'wiki/misc/archived-unsupported.md';
    await vault.create(
      notePath,
      `---
id: t4
type: tool
title: Archived unsupported type
status: archived
archived_at: 2026-04-01T00:00:00Z
archived_reason: "manual"
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
---
# Archived unsupported type
`,
    );

    await refreshTopic({ vault, llm: fakeLLM({ primary: '', contradictions: [], new_sources: [] }), store, config }, notePath);

    const { data } = parseNote(await vault.read(notePath));
    expect(data.status).toBe('archived');
  });
```

Add to `test/jobs/handlers/re-enrich-note.test.ts`, inside the existing `describe('re-enrich-note handler', ...)` block, two new tests right after the existing `'does not overwrite protected region content'` test:

```typescript
  it('un-archives a note on a real (non-no-op) re-enrichment pass (Sub-project C, G7)', async () => {
    const notePath = 'wiki/entities/people/dave.md';
    const fm = {
      id: 'dave',
      type: 'entity',
      title: 'Dave',
      status: 'archived',
      archived_at: '2026-04-01T00:00:00Z',
      archived_reason: 'rot-scan: age 300d, confidence low, inbound no',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const body =
      `${OPEN_TAG('summary')}\nMachine content here.\n${CLOSE_TAG('summary')}\n\n` +
      'Dave recently rejoined the platform team and has been mentoring engineers on service mesh work.';
    await vault.create(notePath, serializeNote(fm, body));

    const fakeEntities = { people: [], projects: [], concepts: [], topics: [], decisions: [], tools: [], organizations: [] };
    const ctx = makeCtx(fakeEntities);
    await reEnrichNoteHandler.execute(makeJob(notePath), ctx);

    const { data } = parseNote(await vault.read(notePath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });

  it('does not un-archive through the <50-char no-op gate (regression)', async () => {
    const notePath = 'wiki/entities/people/erin.md';
    const fm = {
      id: 'erin',
      type: 'entity',
      title: 'Erin',
      status: 'archived',
      archived_at: '2026-04-01T00:00:00Z',
      archived_reason: 'rot-scan: age 300d, confidence low, inbound no',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const body = `${OPEN_TAG('summary')}\nMachine content.\n${CLOSE_TAG('summary')}`;
    await vault.create(notePath, serializeNote(fm, body));

    const ctx = makeCtx({});
    await reEnrichNoteHandler.execute(makeJob(notePath), ctx);

    const { data } = parseNote(await vault.read(notePath));
    expect(data.status).toBe('archived');
    expect(data.archived_at).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/topic-refresh.test.ts test/jobs/handlers/re-enrich-note.test.ts`
Expected: FAIL — `refreshTopic`/`reEnrichNoteHandler` never touch `status` today, so the archived fixtures stay `archived` in every new test, including the ones that should have flipped to `active`.

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/topic-refresh.ts`, change:

```typescript
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
```

to:

```typescript
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

  // Sub-project C (G7): a note that just received a genuine synthesis
  // rewrite has demonstrably been re-engaged with — reverse any prior
  // archival. Only reached after a successful LLM synthesis; the two
  // early-return no-op branches above (unsupported type; zero retrieval
  // hits) bail out before this point without rewriting the body, so they
  // correctly do NOT un-archive.
  if (fm.status === 'archived') {
    fm.status = 'active';
    delete fm.archived_at;
    delete fm.archived_reason;
    log.info('Un-archived note on successful refresh', { path: notePath });
  }

  await deps.vault.atomicWrite(notePath, serializeNote(fm, nextBody));
```

In `src/jobs/handlers/re-enrich-note.ts`, change:

```typescript
    // Update frontmatter timestamps.
    data.last_verified = nowISO();
    data.updated_at = nowISO();
    await context.vault.atomicWrite(notePath, serializeNote(data, body));

    log.info('re-enrich-note complete', {
```

to:

```typescript
    // Sub-project C (G7): a note that just received a genuine re-enrichment
    // pass (past the <50-char no-op gate above) has demonstrably been
    // re-engaged with — reverse any prior archival.
    if (data.status === 'archived') {
      data.status = 'active';
      delete data.archived_at;
      delete data.archived_reason;
      log.info('Un-archived note on successful re-enrichment', { path: notePath });
    }

    // Update frontmatter timestamps.
    data.last_verified = nowISO();
    data.updated_at = nowISO();
    await context.vault.atomicWrite(notePath, serializeNote(data, body));

    log.info('re-enrich-note complete', {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/topic-refresh.test.ts test/jobs/handlers/re-enrich-note.test.ts`
Expected: PASS — including every pre-existing test in both files (regression: the pre-existing `'no-ops when human text is too short'` test's fixture has no `status: archived`, so the new un-archival check simply doesn't fire for it — no change in behavior).

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/topic-refresh.ts src/jobs/handlers/re-enrich-note.ts test/intelligence/topic-refresh.test.ts test/jobs/handlers/re-enrich-note.test.ts
git commit -m "feat(intelligence): un-archive notes on successful topic-refresh/re-enrich-note (G7)"
```

---

### Task 7: Stale-draft visibility in rot-scan (G1)

**Files:**
- Modify: `src/intelligence/rot-scan.ts`
- Modify: `src/jobs/handlers/rot-scan.ts`
- Test: `test/intelligence/decay-scan.test.ts` (extend existing `describe('rot-scan (C2)', ...)` block)

**Interfaces:**
- Consumes: `config.intelligence.lifecycle.staleDraftReportDays` (Task 2).
- Produces: `StaleDraftEntry`, `RotScanResult.staleDraftCandidates: StaleDraftEntry[]` — consumed by Task 9 (no direct dependency, but both live in the same file).

- [ ] **Step 1: Write the failing tests**

Add to `test/intelligence/decay-scan.test.ts`, inside the existing `describe('rot-scan (C2)', ...)` block, two new tests right after the existing `'flags a person page with identity_uncertain=true...'` test:

```typescript
  it('flags a stale-draft source_summary in its own table, using the default 14-day threshold', async () => {
    await vault.ensureFolder('outputs/source-summaries');
    await vault.create(
      'outputs/source-summaries/2026-04-01-stuck.md',
      `---
id: s1
type: source_summary
title: Stuck source
status: draft
source_type: transcript
source_path: raw/stuck.md
ingest_status: detected
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
---
body.`,
    );
    await vault.create(
      'outputs/source-summaries/2026-05-01-fresh.md',
      `---
id: s2
type: source_summary
title: Fresh source
status: draft
source_type: transcript
source_path: raw/fresh.md
ingest_status: detected
created_at: 2026-05-01T00:00:00Z
updated_at: 2026-05-01T00:00:00Z
---
body.`,
    );
    await vault.create(
      'outputs/source-summaries/2026-01-01-processed.md',
      `---
id: s3
type: source_summary
title: Processed source
status: active
source_type: transcript
source_path: raw/processed.md
ingest_status: linked
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
body.`,
    );

    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));

    expect(result.staleDraftCandidates.map((c) => c.path)).toEqual([
      'outputs/source-summaries/2026-04-01-stuck.md',
    ]);
    expect(result.staleDraftCandidates[0].ingestStatus).toBe('detected');
    // Below the 14-day default threshold — excluded.
    expect(result.staleDraftCandidates.map((c) => c.path)).not.toContain('outputs/source-summaries/2026-05-01-fresh.md');
    // Already-active — excluded regardless of age.
    expect(result.staleDraftCandidates.map((c) => c.path)).not.toContain('outputs/source-summaries/2026-01-01-processed.md');

    const report = await vault.read(result.reportPath);
    expect(report).toContain('Stale draft sources');
    expect(report).toContain('Stuck source');
  });

  it('excludes _index.md and respects a custom staleDraftReportDays threshold', async () => {
    await vault.ensureFolder('outputs/source-summaries');
    await vault.create(
      'outputs/source-summaries/_index.md',
      `---
id: idx
type: index
title: Sources index
status: draft
created_at: 2020-01-01T00:00:00Z
updated_at: 2020-01-01T00:00:00Z
---
body.`,
    );
    await vault.create(
      'outputs/source-summaries/six-days-old.md',
      `---
id: s4
type: source_summary
title: Six days old
status: draft
source_type: transcript
source_path: raw/six.md
ingest_status: detected
created_at: 2026-04-30T00:00:00Z
updated_at: 2026-04-30T00:00:00Z
---
body.`,
    );

    const defaultResult = await runRotScan(vault, { nowMs: Date.parse('2026-05-06T00:00:00Z') });
    expect(defaultResult.staleDraftCandidates).toHaveLength(0);

    const customResult = await runRotScan(vault, {
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
      staleDraftReportDays: 5,
    });
    expect(customResult.staleDraftCandidates.map((c) => c.path)).toEqual([
      'outputs/source-summaries/six-days-old.md',
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: FAIL — `result.staleDraftCandidates` is `undefined` (property doesn't exist on `RotScanResult` yet).

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/rot-scan.ts`, change the region-id constants:

```typescript
const REGION_ID = 'vault-health';
const THIN_REGION_ID = 'vault-health-thin-content';
const BARE_IDENTITY_REGION_ID = 'vault-health-bare-identity';
```

to:

```typescript
const REGION_ID = 'vault-health';
const THIN_REGION_ID = 'vault-health-thin-content';
const BARE_IDENTITY_REGION_ID = 'vault-health-bare-identity';
const STALE_DRAFT_REGION_ID = 'vault-health-stale-drafts';
```

Change:

```typescript
export interface BareIdentityEntry {
  path: string;
  title: string;
}

export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  bareIdentityCandidates: BareIdentityEntry[];
  reportPath: string;
}
```

to:

```typescript
export interface BareIdentityEntry {
  path: string;
  title: string;
}

export interface StaleDraftEntry {
  path: string;
  title: string;
  ageDays: number;
  ingestStatus: string;
}

export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  bareIdentityCandidates: BareIdentityEntry[];
  staleDraftCandidates: StaleDraftEntry[];
  reportPath: string;
}
```

Change `RunRotScanOptions`:

```typescript
export interface RunRotScanOptions {
  nowMs?: number;
  layout?: VaultLayout;
}
```

to:

```typescript
export interface RunRotScanOptions {
  nowMs?: number;
  layout?: VaultLayout;
  /** G1: age (days) past which a draft source_summary appears in the "Stale
   *  draft sources" table. Defaults to 14. This pass always runs — same
   *  unconditional precedent as the thin-content/bare-identity passes below,
   *  neither of which is gated behind a config flag either; only the
   *  threshold is configurable. */
  staleDraftReportDays?: number;
}
```

Add a new function right after the existing `asNumber` helper and before `export interface RunRotScanOptions`:

```typescript
async function scanStaleDraftSources(
  vault: VaultAdapter,
  layout: VaultLayout,
  nowMs: number,
  reportDays: number,
): Promise<StaleDraftEntry[]> {
  const entries: StaleDraftEntry[] = [];
  if (!(await vault.exists(layout.sources))) return entries;
  const files = await vault.listMarkdownFiles(layout.sources);
  for (const path of files) {
    if (path.endsWith('/_index.md')) continue;
    const raw = await vault.read(path);
    const { data } = parseNote(raw);
    const fm = data as Record<string, unknown>;
    if (asString(fm.type) !== 'source_summary') continue;
    if (asString(fm.status) !== 'draft') continue; // already active/archived/rejected — not our concern
    const createdAt = asString(fm.created_at);
    const ageDays = createdAt ? (nowMs - new Date(createdAt).getTime()) / 86_400_000 : Infinity;
    if (ageDays >= reportDays) {
      entries.push({
        path,
        title: asString(fm.title) || path,
        ageDays: Math.round(ageDays === Infinity ? 9999 : ageDays),
        ingestStatus: asString(fm.ingest_status) || 'unknown',
      });
    }
  }
  return entries.sort((a, b) => b.ageDays - a.ageDays);
}
```

In `runRotScan`, change:

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  await vault.ensureFolder(layout.system);
  await vault.atomicWrite(healthPath, renderReport(scanned, candidates, thinCandidates, bareIdentityCandidates, nowMs));
  return { scanned, candidates, thinCandidates, bareIdentityCandidates, reportPath: healthPath };
}
```

to:

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);

  // G1: stale-draft source scan — a separate folder (layout.sources) and a
  // separate note `type` (source_summary) from the wiki-content rot rule
  // above, which was tuned for curated pages, not never-processed stubs.
  const staleDraftCandidates = await scanStaleDraftSources(
    vault,
    layout,
    nowMs,
    options.staleDraftReportDays ?? 14,
  );

  await vault.ensureFolder(layout.system);
  await vault.atomicWrite(
    healthPath,
    renderReport(scanned, candidates, thinCandidates, bareIdentityCandidates, staleDraftCandidates, nowMs),
  );
  return { scanned, candidates, thinCandidates, bareIdentityCandidates, staleDraftCandidates, reportPath: healthPath };
}
```

Change `renderReport`'s signature:

```typescript
function renderReport(
  scanned: number,
  candidates: RotEntry[],
  thinCandidates: ThinContentEntry[],
  bareIdentityCandidates: BareIdentityEntry[],
  nowMs: number,
): string {
```

to:

```typescript
function renderReport(
  scanned: number,
  candidates: RotEntry[],
  thinCandidates: ThinContentEntry[],
  bareIdentityCandidates: BareIdentityEntry[],
  staleDraftCandidates: StaleDraftEntry[],
  nowMs: number,
): string {
```

And insert a fourth table between the existing bare-identity table and the final `return`:

```typescript
  lines.push(CLOSE_TAG(BARE_IDENTITY_REGION_ID));
  lines.push('');
  return lines.join('\n');
}
```

to:

```typescript
  lines.push(CLOSE_TAG(BARE_IDENTITY_REGION_ID));
  lines.push('');
  lines.push('## Stale draft sources');
  lines.push('');
  lines.push(`${staleDraftCandidates.length} source_summary notes are still status: draft past the reporting threshold.`);
  lines.push('');
  lines.push(OPEN_TAG(STALE_DRAFT_REGION_ID));
  if (staleDraftCandidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path | Age (days) | ingest_status |');
    lines.push('|------|-----------:|---------------|');
    for (const s of staleDraftCandidates) {
      lines.push(`| [[${s.path.replace(/\.md$/, '')}|${s.title}]] | ${s.ageDays} | ${s.ingestStatus} |`);
    }
  }
  lines.push(CLOSE_TAG(STALE_DRAFT_REGION_ID));
  lines.push('');
  return lines.join('\n');
}
```

In `src/jobs/handlers/rot-scan.ts`, change:

```typescript
import type { JobHandler } from '../types.js';
import { runRotScan } from '../../intelligence/rot-scan.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const rotScanHandler: JobHandler = {
  async execute(_job, ctx) {
    await runRotScan(ctx.vault, { layout: layoutFromConfig(ctx.config) });
  },
};
```

to:

```typescript
import type { JobHandler } from '../types.js';
import { runRotScan } from '../../intelligence/rot-scan.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const rotScanHandler: JobHandler = {
  async execute(_job, ctx) {
    await runRotScan(ctx.vault, {
      layout: layoutFromConfig(ctx.config),
      staleDraftReportDays: ctx.config.intelligence.lifecycle.staleDraftReportDays,
    });
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: PASS — including every pre-existing test in the `describe('rot-scan (C2)', ...)` block (regression: `renderReport`'s new 5th parameter is threaded through every existing call site inside `runRotScan` itself, so no test call site needs updating).

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/rot-scan.ts src/jobs/handlers/rot-scan.ts test/intelligence/decay-scan.test.ts
git commit -m "feat(intelligence): add stale-draft-sources table to the rot-scan vault-health report (G1)"
```

---

### Task 8: Stale-draft auto-archival job (G2)

**Files:**
- Create: `src/jobs/handlers/archive-stale-drafts.ts`
- Modify: `src/jobs/types.ts`
- Modify: `src/jobs/handlers/index.ts`
- Modify: `src/intelligence/scheduler.ts`
- Test: `test/jobs/handlers/archive-stale-drafts.test.ts` (new file)

**Interfaces:**
- Consumes: `archived_at`/`archived_reason` (Task 1); `config.intelligence.lifecycle.{enabled,staleDraftArchiveEnabled,staleDraftArchiveDays}` (Task 2).
- Produces: `archiveStaleDraftsHandler: JobHandler`; new `JobType` member `'archive-stale-drafts'` — consumed by nothing else in this plan (it's a leaf job, scheduled directly).

- [ ] **Step 1: Write the failing tests**

Create `test/jobs/handlers/archive-stale-drafts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { archiveStaleDraftsHandler } from '../../../src/jobs/handlers/archive-stale-drafts.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(): Job {
  return {
    id: 'test-archive-stale-drafts', type: 'archive-stale-drafts', status: 'running', priority: 90,
    payload: {}, trigger: 'timer', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('archive-stale-drafts handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-asd-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('outputs/source-summaries');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeDraft(path: string, createdAt: string, status = 'draft'): Promise<void> {
    await vault.create(
      path,
      serializeNote(
        {
          id: path, type: 'source_summary', title: path, status,
          source_type: 'transcript', source_path: 'raw/x.md', ingest_status: 'detected',
          created_at: createdAt, updated_at: createdAt,
        },
        'body.',
      ),
    );
  }

  it('is a no-op when staleDraftArchiveEnabled is false (the default)', async () => {
    await makeDraft('outputs/source-summaries/old.md', '2026-01-01T00:00:00Z');
    await archiveStaleDraftsHandler.execute(makeJob(), makeCtx());

    const { data } = parseNote(await vault.read('outputs/source-summaries/old.md'));
    expect(data.status).toBe('draft');
  });

  it('archives a draft source_summary past staleDraftArchiveDays when enabled', async () => {
    await makeDraft('outputs/source-summaries/old.md', '2026-01-01T00:00:00Z');
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/old.md'));
    expect(data.status).toBe('archived');
    expect(data.archived_at).toBeDefined();
    expect(data.archived_reason).toContain('stale-draft');
    expect(data.archived_reason).toContain('detected');
  });

  it('does not archive a draft younger than staleDraftArchiveDays', async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await makeDraft('outputs/source-summaries/recent.md', recent);
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/recent.md'));
    expect(data.status).toBe('draft');
  });

  it('does not touch a source_summary that is already active, regardless of age', async () => {
    await makeDraft('outputs/source-summaries/done.md', '2020-01-01T00:00:00Z', 'active');
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const { data } = parseNote(await vault.read('outputs/source-summaries/done.md'));
    expect(data.status).toBe('active');
  });

  it('logs a lifecycle:archive-stale-drafts entry only when at least one note is archived', async () => {
    await makeDraft('outputs/source-summaries/old.md', '2026-01-01T00:00:00Z');
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    const log = await vault.read('log.md');
    expect(log).toContain('lifecycle:archive-stale-drafts');
    expect(log).toContain('1 stale draft source(s) archived');
  });

  it('does not log when nothing is archived', async () => {
    const ctx = makeCtx({ intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 30 } } });
    await archiveStaleDraftsHandler.execute(makeJob(), ctx);

    expect(await vault.exists('log.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/jobs/handlers/archive-stale-drafts.test.ts`
Expected: FAIL — `src/jobs/handlers/archive-stale-drafts.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/jobs/handlers/archive-stale-drafts.ts`:

```typescript
// Sub-project C, G2: auto-archive source_summary notes that have sat at
// status: draft past a configurable age. Fully deterministic, no review —
// nothing is deleted, the raw evidence in raw/ and the summary note's body
// are untouched, and the transition is fully reversible (manual edit, or
// automatically the moment the source is actually processed — see
// link-concepts.ts/compile-entities.ts/agent-ingest.ts's G0/G7 guard).

import type { JobHandler } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { nowISO } from '../../shared/date-utils.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:archive-stale-drafts');

export const archiveStaleDraftsHandler: JobHandler = {
  async execute(_job, ctx) {
    const layout = layoutFromConfig(ctx.config);
    const cfg = ctx.config.intelligence.lifecycle;
    if (!cfg.enabled || !cfg.staleDraftArchiveEnabled) return;
    if (!(await ctx.vault.exists(layout.sources))) return;

    const nowMs = Date.now();
    const files = await ctx.vault.listMarkdownFiles(layout.sources);
    let archived = 0;

    for (const path of files) {
      if (path.endsWith('/_index.md')) continue;
      const raw = await ctx.vault.read(path);
      const { data, body } = parseNote(raw);
      if (data.type !== 'source_summary' || data.status !== 'draft') continue;

      const createdAt = typeof data.created_at === 'string' ? data.created_at : undefined;
      const ageDays = createdAt ? (nowMs - new Date(createdAt).getTime()) / 86_400_000 : Infinity;
      if (ageDays < cfg.staleDraftArchiveDays) continue;

      data.status = 'archived';
      data.archived_at = new Date(nowMs).toISOString();
      data.archived_reason = `stale-draft (${Math.round(ageDays)}d at ingest_status: ${data.ingest_status ?? 'unknown'})`;
      data.updated_at = nowISO();
      await ctx.vault.atomicWrite(path, serializeNote(data, body));
      archived++;
    }

    if (archived > 0) {
      await appendLogEntry(
        ctx.vault,
        { kind: 'lifecycle:archive-stale-drafts', message: `${archived} stale draft source(s) archived (>${cfg.staleDraftArchiveDays}d)` },
        layout,
      );
    }
    log.info('Stale-draft archival complete', { archived, thresholdDays: cfg.staleDraftArchiveDays });
  },
};
```

In `src/jobs/types.ts`, change:

```typescript
  'topic-refresh',
  'decay-scan',
  'rot-scan',
  'research-propose',
```

to:

```typescript
  'topic-refresh',
  'decay-scan',
  'rot-scan',
  'archive-stale-drafts',
  'research-propose',
```

And change:

```typescript
  'topic-refresh': 75,
  'decay-scan': 95,
  'rot-scan': 95,
  'research-propose': 90,
```

to:

```typescript
  'topic-refresh': 75,
  'decay-scan': 95,
  'rot-scan': 95,
  'archive-stale-drafts': 90,
  'research-propose': 90,
```

In `src/jobs/handlers/index.ts`, add the import:

```typescript
import { rotScanHandler } from './rot-scan.js';
```

change to:

```typescript
import { rotScanHandler } from './rot-scan.js';
import { archiveStaleDraftsHandler } from './archive-stale-drafts.js';
```

And add the registration right after `rot-scan`'s:

```typescript
  map.set('rot-scan', rotScanHandler);
```

to:

```typescript
  map.set('rot-scan', rotScanHandler);
  map.set('archive-stale-drafts', archiveStaleDraftsHandler);
```

In `src/intelligence/scheduler.ts`, change:

```typescript
    {
      type: 'rot-scan',
      cadence: 'weekly',
      intervalSec: 7 * 86_400,
      priority: 95,
      dedupeKey: 'rot-scan',
    },
    {
      type: 'digest-weekly',
```

to:

```typescript
    {
      type: 'rot-scan',
      cadence: 'weekly',
      intervalSec: 7 * 86_400,
      priority: 95,
      dedupeKey: 'rot-scan',
    },
    {
      type: 'archive-stale-drafts',
      cadence: 'daily',
      intervalSec: 86_400,
      priority: 90,
      dedupeKey: 'archive-stale-drafts',
    },
    {
      type: 'digest-weekly',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/jobs/handlers/archive-stale-drafts.test.ts`
Expected: PASS

Also run: `pnpm vitest run test/jobs/handlers/index.test.ts test/intelligence/scheduler.test.ts` if either exists (check first with `ls test/jobs/handlers/index.test.ts test/intelligence/scheduler.test.ts` — if present, they likely assert against `JobType.options`/`defaultSchedule()`'s exact contents and may need no changes since both already generically iterate, but confirm no hardcoded job-count/list assertions break).
Expected: PASS (or "no such file" if neither test file exists, which is fine).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/handlers/archive-stale-drafts.ts src/jobs/types.ts src/jobs/handlers/index.ts src/intelligence/scheduler.ts test/jobs/handlers/archive-stale-drafts.test.ts
git commit -m "feat(jobs): add archive-stale-drafts job for auto-archiving stale draft sources (G2)"
```

---

### Task 9: Rot-scan → archive-queue feed + decay-scan dead-code removal (G3 cont'd, G6)

**Files:**
- Modify: `src/intelligence/rot-scan.ts`
- Modify: `src/jobs/handlers/rot-scan.ts`
- Modify: `src/intelligence/decay-scan.ts`
- Test: `test/intelligence/decay-scan.test.ts` (extend both the `describe('decay-scan (C1)', ...)` and `describe('rot-scan (C2)', ...)` blocks)

**Interfaces:**
- Consumes: `refreshArchiveQueue`, `type ArchiveCandidate` (Task 3); `config.intelligence.lifecycle.archiveQueueEnabled` (Task 2).
- Produces: nothing new for later tasks — this is what makes Task 10's queue non-empty in real operation.

- [ ] **Step 1: Write the failing tests**

Add to `test/intelligence/decay-scan.test.ts`, inside the existing `describe('rot-scan (C2)', ...)` block, a new test right after the two stale-draft tests added in Task 7:

```typescript
  it('feeds rot candidates into the archive queue only when archiveQueueEnabled is true (G3)', async () => {
    await vault.create(
      'wiki/concepts/dead-for-queue.md',
      `---
id: q1
type: concept
title: Dead for queue
created_at: 2024-01-01T00:00:00Z
updated_at: 2024-01-01T00:00:00Z
confidence: low
---
body.`,
    );

    // Legacy call form (no options) — every existing pre-Sub-project-C call
    // site — must see no behavior change: the queue file is never created.
    const legacy = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));
    expect(legacy.candidates.map((c) => c.path)).toContain('wiki/concepts/dead-for-queue.md');
    expect(await vault.exists('wiki/_system/archive-queue.md')).toBe(false);

    const withFeed = await runRotScan(vault, {
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
      archiveQueueEnabled: true,
    });
    expect(withFeed.candidates.map((c) => c.path)).toContain('wiki/concepts/dead-for-queue.md');

    const { readArchiveQueue } = await import('../../src/maintenance/archive-queue.js');
    const queue = await readArchiveQueue(vault);
    const entry = queue.entries.find((e) => e.path === 'wiki/concepts/dead-for-queue.md');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
    expect(entry!.reason).toContain('rot-scan: age');
  });
```

Add to `test/intelligence/decay-scan.test.ts`, inside the existing `describe('decay-scan (C1)', ...)` block, a new regression test right after the existing `'enqueues refresh for stale concept and surfaces a research candidate'` test:

```typescript
  it('never writes archive_candidate (Sub-project C, G6: dead branch removed)', async () => {
    await vault.create(
      'wiki/concepts/very-stale.md',
      `---
id: vs1
type: concept
title: Very stale
created_at: 2020-01-01T00:00:00Z
updated_at: 2020-01-01T00:00:00Z
last_verified: 2020-01-01T00:00:00Z
stability: 10
---
body.`,
    );

    await runDecayScan({
      vault,
      config,
      enqueue: async (i) => ({} as never),
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    const { data } = parseNote(await vault.read('wiki/concepts/very-stale.md'));
    expect(data.archive_candidate).toBeUndefined();
    expect(typeof data.retrievability).toBe('number');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: FAIL — the new rot-scan test fails because `runRotScan` never writes to the archive queue yet (`entry` is `undefined`); the new decay-scan regression test currently PASSES already (there is no `archive_candidate` assertion failure yet, since the branch hasn't been removed) — this is expected per the design's own note that this particular test is "confirmation-only." Proceed to Step 3 regardless so the removal is verified not to have broken anything else; if you want a true red-before-green cycle for this one test specifically, temporarily skip it (`it.skip`) until Step 3, or accept that it passes both before and after (it is a regression guard, not a new-behavior test).

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/rot-scan.ts`, add the import:

```typescript
import { REFRESH_TARGETS, isPlaceholderContent, type RefreshTarget } from './refresh-targets.js';
```

change to:

```typescript
import { REFRESH_TARGETS, isPlaceholderContent, type RefreshTarget } from './refresh-targets.js';
import { refreshArchiveQueue, type ArchiveCandidate } from '../maintenance/archive-queue.js';
```

Change `RunRotScanOptions` (as left by Task 7):

```typescript
export interface RunRotScanOptions {
  nowMs?: number;
  layout?: VaultLayout;
  /** G1: age (days) past which a draft source_summary appears in the "Stale
   *  draft sources" table. Defaults to 14. This pass always runs — same
   *  unconditional precedent as the thin-content/bare-identity passes below,
   *  neither of which is gated behind a config flag either; only the
   *  threshold is configurable. */
  staleDraftReportDays?: number;
}
```

to:

```typescript
export interface RunRotScanOptions {
  nowMs?: number;
  layout?: VaultLayout;
  /** G1: age (days) past which a draft source_summary appears in the "Stale
   *  draft sources" table. Defaults to 14. This pass always runs — same
   *  unconditional precedent as the thin-content/bare-identity passes below,
   *  neither of which is gated behind a config flag either; only the
   *  threshold is configurable. */
  staleDraftReportDays?: number;
  /** G3: feed this scan's own rot candidates (unchanged stale+orphan+low-
   *  confidence rule) into the archive queue. Defaults to false so every
   *  pre-Sub-project-C call site (including every rot-scan test that
   *  predates this feature) sees no behavior change. */
  archiveQueueEnabled?: boolean;
}
```

In `runRotScan`, change (as left by Task 7):

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);

  // G1: stale-draft source scan — a separate folder (layout.sources) and a
  // separate note `type` (source_summary) from the wiki-content rot rule
  // above, which was tuned for curated pages, not never-processed stubs.
  const staleDraftCandidates = await scanStaleDraftSources(
    vault,
    layout,
    nowMs,
    options.staleDraftReportDays ?? 14,
  );

  await vault.ensureFolder(layout.system);
```

to:

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);

  // G3: feed this scan's own rot candidates (unchanged stale+orphan+low-
  // confidence rule) into the archive queue for human resolution via
  // `karpathy archivist` / `resolve_archive_candidate`. Opt-in via options
  // so every pre-Sub-project-C call site (including every test in this file
  // predating this feature) sees no behavior change.
  if (options.archiveQueueEnabled && candidates.length > 0) {
    const archiveCandidates: ArchiveCandidate[] = candidates.map((c) => ({
      path: c.path,
      title: c.title,
      reason: `rot-scan: age ${c.ageDays}d, confidence ${c.confidence}, inbound ${c.hasInboundMarker ? 'yes' : 'no'}`,
      ageDays: c.ageDays,
      confidence: c.confidence,
      retrievability: c.retrievability,
    }));
    await refreshArchiveQueue(vault, archiveCandidates, layout);
  }

  // G1: stale-draft source scan — a separate folder (layout.sources) and a
  // separate note `type` (source_summary) from the wiki-content rot rule
  // above, which was tuned for curated pages, not never-processed stubs.
  const staleDraftCandidates = await scanStaleDraftSources(
    vault,
    layout,
    nowMs,
    options.staleDraftReportDays ?? 14,
  );

  await vault.ensureFolder(layout.system);
```

In `src/jobs/handlers/rot-scan.ts`, change (as left by Task 7):

```typescript
export const rotScanHandler: JobHandler = {
  async execute(_job, ctx) {
    await runRotScan(ctx.vault, {
      layout: layoutFromConfig(ctx.config),
      staleDraftReportDays: ctx.config.intelligence.lifecycle.staleDraftReportDays,
    });
  },
};
```

to:

```typescript
export const rotScanHandler: JobHandler = {
  async execute(_job, ctx) {
    await runRotScan(ctx.vault, {
      layout: layoutFromConfig(ctx.config),
      staleDraftReportDays: ctx.config.intelligence.lifecycle.staleDraftReportDays,
      archiveQueueEnabled: ctx.config.intelligence.lifecycle.archiveQueueEnabled,
    });
  },
};
```

In `src/intelligence/decay-scan.ts` (G6), change:

```typescript
export interface DecayScanResult {
  scanned: number;
  refreshEnqueued: number;
  thinContentEnqueued: number;
  archiveCandidates: string[];
  researchCandidates: number;
}
```

to:

```typescript
export interface DecayScanResult {
  scanned: number;
  refreshEnqueued: number;
  thinContentEnqueued: number;
  researchCandidates: number;
}
```

Change:

```typescript
export async function runDecayScan(deps: DecayScanDeps): Promise<DecayScanResult> {
  const result: DecayScanResult = {
    scanned: 0,
    refreshEnqueued: 0,
    thinContentEnqueued: 0,
    archiveCandidates: [],
    researchCandidates: 0,
  };
  const refreshThreshold = deps.config.intelligence.decay.retrievabilityRefresh;
  const archiveThreshold = deps.config.intelligence.decay.retrievabilityArchive;
  const nowMs = deps.nowMs ?? Date.now();
```

to:

```typescript
export async function runDecayScan(deps: DecayScanDeps): Promise<DecayScanResult> {
  const result: DecayScanResult = {
    scanned: 0,
    refreshEnqueued: 0,
    thinContentEnqueued: 0,
    researchCandidates: 0,
  };
  const refreshThreshold = deps.config.intelligence.decay.retrievabilityRefresh;
  const nowMs = deps.nowMs ?? Date.now();
```

(`intelligence.decay.retrievabilityArchive` stays in `LifecycleConfigSchema`'s sibling `decay` schema unchanged, per the design's non-goal against schema restructuring — it now has zero runtime readers anywhere in `src/`, confirmed by grep; documented here rather than silently repeating the design's inaccurate "remains meaningful" framing.)

Change:

```typescript
      // Persist the score for downstream consumers (research-queue, indexes).
      fm.retrievability = Number(r.toFixed(4));
      fm.retrievability_checked_at = nowIso;
      const inbound = countInboundLinks(body);

      if (r < archiveThreshold && inbound === 0) {
        result.archiveCandidates.push(path);
        fm.review_state = 'unreviewed';
        fm.archive_candidate = true;
      }

      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
```

to:

```typescript
      // Persist the score for downstream consumers (research-queue, indexes,
      // and rot-scan's RotEntry.retrievability display field — that path is
      // unaffected by the G6 removal below, since it reads this same
      // fm.retrievability stamp, not the deleted archive-candidate branch).
      fm.retrievability = Number(r.toFixed(4));
      fm.retrievability_checked_at = nowIso;

      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
```

And remove the now-fully-unused `countInboundLinks` helper entirely (its only call site was the `inbound` assignment just deleted above; `tsconfig.json`'s `noUnusedLocals: true` fails the build if it's left in place):

```typescript
function countInboundLinks(body: string): number {
  // Cheap heuristic; full backlinks live elsewhere. We just check whether
  // any obvious inbound markers exist within the note body itself (e.g.
  // it's referenced in a backlinks region). Detailed accounting can be
  // added once backlinks scanner exposes a query API.
  return (body.match(/%% begin:backlinks %%[\s\S]*?\[\[/g) ?? []).length;
}
```

Delete this function entirely (it has no other call site in `src/` or `test/` — confirmed by grep).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: PASS — including every pre-existing test in both describe blocks (regression: no existing test in this file asserted on `archiveCandidates`/`archive_candidate`, confirmed by grep before this task started).

Run: `pnpm lint`
Expected: PASS — confirms `archiveThreshold`, `inbound`, and `countInboundLinks` were fully removed with no leftover unused-local errors.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/rot-scan.ts src/jobs/handlers/rot-scan.ts src/intelligence/decay-scan.ts test/intelligence/decay-scan.test.ts
git commit -m "feat(intelligence): feed rot-scan candidates into the archive queue; remove dead decay-scan archive_candidate write (G3, G6)"
```

---

### Task 10: CLI `archivist` + MCP `resolve_archive_candidate` (G3, G4 resolution paths)

**Files:**
- Modify: `src/bin/karpathy.ts`
- Create: `src/mcp/tools/resolve-archive-candidate.ts`
- Modify: `src/mcp/tools/index.ts`
- Modify: `src/mcp/tools/router.ts`
- Test: `test/mcp/tools.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `readArchiveQueue`, `pendingArchiveEntries`, `applyArchiveDecision` (Task 3).
- Produces: `karpathy archivist` CLI command; `resolve_archive_candidate` MCP tool — the last two components in this plan; nothing downstream depends on them.

- [ ] **Step 1: Write the failing test**

Add to `test/mcp/tools.test.ts` a new `describe` block, modeled on the existing `describe('reconcile_entities — non-default layout.wiki (whole-branch-review regression)', ...)` block's `MCPContext` construction (append after that block's closing `});`):

```typescript
describe('resolve_archive_candidate', () => {
  let tempDir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-mcp-archive-'));
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

    await mkdir(join(tempDir, 'wiki/concepts'), { recursive: true });
    await mkdir(join(tempDir, 'wiki/_system'), { recursive: true });

    const note = serializeNote(
      { id: 'c1', type: 'concept', title: 'Old concept', status: 'draft', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      '# Old concept\n',
    );
    await vault.create('wiki/concepts/old-concept.md', note);

    await refreshArchiveQueue(vault, [{
      path: 'wiki/concepts/old-concept.md',
      title: 'Old concept',
      reason: 'rot-scan: age 400d, confidence low, inbound no',
      ageDays: 400,
      confidence: 'low',
    }], config.layout);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns pending entries when called with no arguments', async () => {
    const result = await handleResolveArchiveCandidate({}, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pending).toBe(1);
    expect(parsed.entries[0].path).toBe('wiki/concepts/old-concept.md');
  });

  it('archives the target note and resolves the entry', async () => {
    const queue = await readArchiveQueue(ctx.vault, ctx.config.layout);
    const id = queue.entries[0].id;

    const result = await handleResolveArchiveCandidate({ id, decision: 'archive' }, ctx);
    expect(result.isError).toBeFalsy();

    const { data } = parseNote(await ctx.vault.read('wiki/concepts/old-concept.md'));
    expect(data.status).toBe('archived');
    expect(data.archived_at).toBeDefined();
    expect(data.archived_reason).toContain('rot-scan');

    const resolvedQueue = await readArchiveQueue(ctx.vault, ctx.config.layout);
    expect(resolvedQueue.entries[0].status).toBe('resolved');
  });

  it('errors when decision is "supersede" without supersededByPath', async () => {
    const queue = await readArchiveQueue(ctx.vault, ctx.config.layout);
    const id = queue.entries[0].id;

    const result = await handleResolveArchiveCandidate({ id, decision: 'supersede' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('errors when supersededByPath does not exist', async () => {
    const queue = await readArchiveQueue(ctx.vault, ctx.config.layout);
    const id = queue.entries[0].id;

    const result = await handleResolveArchiveCandidate(
      { id, decision: 'supersede', supersededByPath: 'wiki/concepts/nonexistent.md' },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it('errors for an unknown id', async () => {
    const result = await handleResolveArchiveCandidate({ id: 'nope', decision: 'keep' }, ctx);
    expect(result.isError).toBe(true);
  });
});
```

Add the two new imports this block needs, alongside the existing imports at the top of `test/mcp/tools.test.ts`:

```typescript
import { handle as handleResolveArchiveCandidate } from '../../src/mcp/tools/resolve-archive-candidate.js';
import { refreshArchiveQueue, readArchiveQueue } from '../../src/maintenance/archive-queue.js';
```

(`mkdtemp`, `rm`, `mkdir`, `join`, `tmpdir`, `createFsAdapter`, `serializeNote`, `parseNote`, `KarpathyConfigSchema`, `createSessionLogManager`, `createHotCacheManager`, and `type MCPContext` are already imported in this file — confirmed by the pre-existing `reconcile_entities` regression block using all of them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/mcp/tools.test.ts`
Expected: FAIL — `src/mcp/tools/resolve-archive-candidate.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/tools/resolve-archive-candidate.ts`:

```typescript
// Sub-project C — MCP path for archive-queue resolution (G3, G4). Mirrors
// reconcile-entities.ts's read/apply-decision shape.
//
// Without arguments: returns pending queue entries (up to 10).
// With { id, decision, supersededByPath? }: applies the decision via
// applyArchiveDecision (archive/supersede mutate the target note; keep/skip
// only touch the queue).

import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readArchiveQueue,
  pendingArchiveEntries,
  applyArchiveDecision,
} from '../../maintenance/archive-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';

const MAX_ENTRIES_RETURNED = 10;

const InputSchema = z.object({
  id: z.string().optional(),
  decision: z.enum(['archive', 'keep', 'supersede', 'skip']).optional(),
  supersededByPath: z.string().optional(),
}).strict();

export const definition = {
  name: 'resolve_archive_candidate',
  description:
    'Manage the archive queue (rot-scan candidates awaiting human review). Call with no arguments ' +
    'to see up to 10 pending candidates. Call with { id, decision } to apply a decision: "archive" ' +
    'flips status to archived (and project_status for project pages); "supersede" archives the note ' +
    'and records supersededByPath in its superseded_by list (supersededByPath required, must exist); ' +
    '"keep" dismisses the candidate without changing the note; "skip" hides it from future archivist ' +
    'runs. Run karpathy archivist for an interactive walkthrough.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' as const, description: 'Entry id to resolve' },
      decision: {
        type: 'string' as const,
        enum: ['archive', 'keep', 'supersede', 'skip'],
        description: 'Resolution decision',
      },
      supersededByPath: {
        type: 'string' as const,
        description: 'Replacement note path (required when decision is "supersede")',
      },
    },
    required: [] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const layout = layoutFromConfig(ctx.config);

  // -- Read-only: return pending entries -----------------------------------
  if (!input.id) {
    const queue = await readArchiveQueue(ctx.vault, layout);
    const pending = pendingArchiveEntries(queue).slice(0, MAX_ENTRIES_RETURNED);
    if (pending.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Archive queue is empty — no pending candidates.' }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ pending: pending.length, total: queue.entries.length, entries: pending }, null, 2),
      }],
    };
  }

  // -- Apply a decision ----------------------------------------------------
  if (!input.decision) {
    return {
      content: [{ type: 'text' as const, text: 'decision is required when id is provided' }],
      isError: true,
    };
  }

  if (input.decision === 'supersede' && !input.supersededByPath) {
    return {
      content: [{ type: 'text' as const, text: 'supersededByPath is required when decision is "supersede"' }],
      isError: true,
    };
  }

  const queue = await readArchiveQueue(ctx.vault, layout);
  const entry = queue.entries.find((e) => e.id === input.id);
  if (!entry) {
    return {
      content: [{ type: 'text' as const, text: `Entry not found: ${input.id}` }],
      isError: true,
    };
  }

  if (input.decision === 'supersede' && !(await ctx.vault.exists(input.supersededByPath!))) {
    return {
      content: [{ type: 'text' as const, text: `Replacement path does not exist: ${input.supersededByPath}` }],
      isError: true,
    };
  }

  const resolved = await applyArchiveDecision(ctx.vault, entry, input.decision, input.supersededByPath, layout);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ message: `Entry marked as ${input.decision}`, entry: resolved }, null, 2),
    }],
  };
}
```

In `src/mcp/tools/index.ts`, add the import right after `reconcileEntities`:

```typescript
import { definition as reconcileEntities } from './reconcile-entities.js';
import { definition as reEnrichNote } from './re-enrich-note.js';
```

to:

```typescript
import { definition as reconcileEntities } from './reconcile-entities.js';
import { definition as resolveArchiveCandidate } from './resolve-archive-candidate.js';
import { definition as reEnrichNote } from './re-enrich-note.js';
```

and add it to `TOOL_DEFINITIONS`:

```typescript
  approveResearch,
  reconcileEntities,
  reEnrichNote,
];
```

to:

```typescript
  approveResearch,
  reconcileEntities,
  resolveArchiveCandidate,
  reEnrichNote,
];
```

In `src/mcp/tools/router.ts`, add the import right after `reconcileEntities`:

```typescript
import { handle as reconcileEntities } from './reconcile-entities.js';
import { handle as reEnrichNote } from './re-enrich-note.js';
```

to:

```typescript
import { handle as reconcileEntities } from './reconcile-entities.js';
import { handle as resolveArchiveCandidate } from './resolve-archive-candidate.js';
import { handle as reEnrichNote } from './re-enrich-note.js';
```

and register the handler:

```typescript
  reconcile_entities: reconcileEntities,
  re_enrich_note: reEnrichNote,
};
```

to:

```typescript
  reconcile_entities: reconcileEntities,
  resolve_archive_candidate: resolveArchiveCandidate,
  re_enrich_note: reEnrichNote,
};
```

Finally, in `src/bin/karpathy.ts`: add the import right after the existing `reconciliation-queue.js` import block:

```typescript
import {
  readReconciliationQueue,
  refreshQueue,
  resolveEntry,
  pendingEntries,
} from '../maintenance/reconciliation-queue.js';
```

to:

```typescript
import {
  readReconciliationQueue,
  refreshQueue,
  resolveEntry,
  pendingEntries,
} from '../maintenance/reconciliation-queue.js';
import {
  readArchiveQueue,
  pendingArchiveEntries,
  applyArchiveDecision,
} from '../maintenance/archive-queue.js';
```

Add the new command function right after `curatorCommand`'s closing `}` (before `async function touchCommand`):

```typescript
async function archivistCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const layout = config.layout;

  const queue = await readArchiveQueue(vault, layout);
  const pending = pendingArchiveEntries(queue);

  if (pending.length === 0) {
    process.stdout.write('Archive queue is empty — no pending candidates.\n');
    return;
  }

  process.stdout.write(`\nArchive queue: ${pending.length} pending candidate(s).\n`);
  process.stdout.write('Decisions: [a]rchive  [k]eep  [S]upersede  [s]kip  [q]uit\n\n');

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  let processed = 0;

  for (const entry of pending) {
    process.stdout.write(
      `\n─────────────────────────────────────────\n` +
      `  Note:    "${entry.title}"\n` +
      `           ${entry.path}\n` +
      `  Reason:  ${entry.reason}\n`,
    );

    const answer = (await question('Decision [a/k/S/s/q]: ')).trim();

    if (answer.toLowerCase() === 'q') {
      process.stdout.write('Exiting archivist. Remaining entries stay pending.\n');
      break;
    }

    if (answer === 'a') {
      await applyArchiveDecision(vault, entry, 'archive', undefined, layout);
      process.stdout.write(`  Archived "${entry.title}".\n`);
      processed++;
    } else if (answer === 'k') {
      await applyArchiveDecision(vault, entry, 'keep', undefined, layout);
      process.stdout.write('  Kept — will not be re-flagged.\n');
    } else if (answer === 'S') {
      const supersededByPath = (await question('  Replacement note path: ')).trim();
      if (!supersededByPath || !(await vault.exists(supersededByPath))) {
        process.stdout.write('  Skipping — replacement path not found.\n');
        continue;
      }
      await applyArchiveDecision(vault, entry, 'supersede', supersededByPath, layout);
      process.stdout.write(`  Superseded by "${supersededByPath}".\n`);
      processed++;
    } else if (answer === 's') {
      await applyArchiveDecision(vault, entry, 'skip', undefined, layout);
      process.stdout.write('  Skipped.\n');
    } else {
      process.stdout.write('  Unknown input — skipping.\n');
    }
  }

  rl.close();

  if (processed > 0) {
    process.stdout.write('\nRebuilding indexes...\n');
    await rebuildAllIndexes(vault, layout);
    process.stdout.write(`Done. ${processed} decision(s) applied.\n`);
  } else {
    process.stdout.write('\nNo archival changes applied.\n');
  }
}
```

Register the command in the switch statement — change:

```typescript
    case 'curator':
      await curatorCommand();
      break;
    case 'touch':
```

to:

```typescript
    case 'curator':
      await curatorCommand();
      break;
    case 'archivist':
      await archivistCommand();
      break;
    case 'touch':
```

And add the help-text line — change:

```typescript
          '  curator             Interactive entity reconciliation queue walkthrough',
          '  touch <note-path>   Re-run entity extraction on a wiki note you edited',
```

to:

```typescript
          '  curator             Interactive entity reconciliation queue walkthrough',
          '  archivist           Interactive archive-queue walkthrough (rot-scan candidates)',
          '  touch <note-path>   Re-run entity extraction on a wiki note you edited',
```

**Note on CLI test coverage:** `curatorCommand` — the exact pattern `archivistCommand` mirrors — has no test coverage anywhere in this codebase (confirmed: `test/bin/` only covers `drain-queue-exit`, `hook-stdin-timeout`, `install-hooks`, `intel-tick-exit`; no readline-based CLI command is tested). This task deliberately does not add new subprocess/readline test infrastructure to cover `archivistCommand` itself — the actual decision-application logic it calls (`applyArchiveDecision`) is already fully covered by Task 3's tests, and the equivalent MCP surface (`resolve_archive_candidate`, a plain async function) is fully covered by this task's own tests above. `archivistCommand` is left at the same (zero) CLI-level test coverage as `curatorCommand`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/mcp/tools.test.ts`
Expected: PASS — including every pre-existing test in this file (regression: purely additive registrations in `index.ts`/`router.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/bin/karpathy.ts src/mcp/tools/resolve-archive-candidate.ts src/mcp/tools/index.ts src/mcp/tools/router.ts test/mcp/tools.test.ts
git commit -m "feat(cli): add karpathy archivist CLI and resolve_archive_candidate MCP tool (G3, G4)"
```

---

## Final verification

After Task 10, run the full suite once more to confirm nothing upstream regressed:

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: all pass (module/test count will have grown by the new files/tests added across Tasks 1-10; `test/bin/intel-tick-exit.test.ts` may still flake per the Global Constraints note above — that alone does not indicate a regression).

## Operator follow-ups (not part of this plan)

Per the design's §16, §18, §19:

- **`staleDraftArchiveEnabled` ships `false`.** Flip it to `true` in `~/.karpathy/config.json` (`intelligence.lifecycle.staleDraftArchiveEnabled`) once ready for G2's auto-archival to actually run against the real vault's stale-draft backlog — watch the "Stale draft sources" table in `vault-health.md` for a cycle first if a gentler rollout is wanted.
- **`maintenance.reviewEnabled` stays `false`.** A one-line config change, outside this repo, not performed by this plan (same finding B2c already made independently).
- **Why 93.7% of `source_summary` notes never advance past `ingest_status: 'detected'`, and the orphaned `finalize-session` job, remain unfixed** — both are job-queue/scheduler throughput questions, explicitly out of scope for this lifecycle-semantics spec (§0.3, §18).
- **`superseded_by` has a writer as of this plan (Task 3/10) but still no reader anywhere** (no banner in `get_note`, no exclusion from `search` ranking) — designing a consumer is deferred until real data exists to design against (§18).

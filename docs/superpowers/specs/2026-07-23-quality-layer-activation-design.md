# Design: Activate the Dormant Quality-Control Layer

**Status:** Approved for spec write-up (design conversation complete 2026-07-23)
**Sub-project:** A of 4 (see decomposition note in §0). B (taxonomy & extraction redesign), C (draft/archival lifecycle), D (research-queue redesign) are separate specs, not covered here.

## 0. Context

A curation-effectiveness audit of the Karpathy vault (2026-07-23) found that three pieces of quality-control machinery already exist in the codebase, are fully implemented, and do nothing today because nothing schedules or calls them:

1. **Contradiction/duplicate detection** (`src/review/contradiction-detector.ts`, `src/review/duplicate-detector.ts`) — both are registered job handlers (`detect-contradictions`, `detect-duplicates`, `src/jobs/types.ts:20-21`, priority 80 each, `src/jobs/types.ts:88-89`) but are **not in `defaultSchedule()`** (`src/intelligence/scheduler.ts:42-91`), so they only ever run via manual `karpathy review detect`. The config flag meant to gate this, `config.maintenance.reviewEnabled` (`src/config/schema.ts:49`, default `false`), is read in exactly one place in the whole codebase — copied through during `karpathy init` scaffolding (`src/bin/karpathy.ts:177`) — and never checked as a conditional anywhere. It is dead config.

2. **Entity-dedup detection** (`src/compilation/entity-merger.ts:detectMergeCandidates()`, `:243-335`) — detects misspelling/duplicate entities via Levenshtein distance, substring match, and alias overlap, and is the mechanism behind the vault owner's "look up a misspelled name" use case. It's exposed as the `detect-entity-dupes` job type (`src/jobs/types.ts:42`, priority 80, `:106`) and the `reconcile_entities` MCP tool for human review. Like the review detectors, it is **not on the automatic schedule** — must be triggered manually.

3. **The significance gate** (`src/intelligence/significance-gate.ts`) — `heuristicGate()` and `llmGate()` implement keep/merge/drop judgment for newly-extracted entity candidates, configurable via `enrichment.significanceGate: 'off'|'heuristic'|'llm'` (default `'heuristic'`, `src/config/schema.ts:219-220`). It is only ever called from the legacy, no-longer-used `extract-entities`/`link-concepts` path (`src/jobs/handlers/link-concepts.ts:95-104`) and from `re-enrich-note.ts`. **The actual production ingest cascade never calls it** — `src/compilation/compiler.ts` calls `resolveEntity()` + `createEntityPage()` directly, with only a blocklist (`isNoiseEntity`) and a confidence floor (`minEntityConfidence`) applied upstream in `compile-entities.ts` (`:26-36`). This is the likely root cause of noise found in the audit (Claude Code's own `Glob`/`Read` tools, the system's own state/config files, becoming permanent wiki pages).

This spec covers wiring all three into place. It does **not** cover redesigning what the gate should catch, taxonomy changes, or self-referential (project) exclusion — those are sub-project B.

## 1. Goals / Non-Goals

**Goals:**
- `config.maintenance.reviewEnabled` becomes a real, single switch: `true` schedules contradiction detection, duplicate detection, and entity-dedup detection daily; `false` leaves all three manual-only (unchanged CLI behavior either way).
- Entity-dedup candidates ≥85% confidence auto-merge without human intervention; candidates below that route to the existing `reconcile_entities` human-review queue.
- The significance gate (LLM mode) actually runs on the real ingest path, at the one shared choke-point (`compiler.ts`) both ingest paths pass through. Clear-drop verdicts skip page creation; verdicts the LLM itself isn't confident about still create the page but flag it for human review instead of guessing.
- No regression to existing manual CLI paths (`karpathy review detect`, `karpathy merge --auto`, `reconcile_entities` MCP tool) — all continue to work exactly as today, independent of whether the new scheduling is enabled.

**Non-goals (deferred to sub-project B):**
- Changing what counts as noise in the blocklist/prompts (e.g., catching self-referential system-file "tools" more broadly).
- Project-based (`project_slug`) exclusion of the tool's own development sessions.
- Any taxonomy changes to note types.
- Tightening "decision" note criteria.

## 2. Architecture Overview

Three independent changes, sharing one config-driven on/off switch for two of them:

```
config.maintenance.reviewEnabled (bool, existing field, currently dead)
        │
        ├─ true → defaultSchedule() includes 3 new ScheduledJob entries:
        │           detect-contradictions (daily)
        │           detect-duplicates     (daily)
        │           detect-entity-dupes   (daily)
        │
        └─ false → schedule unchanged from today; all three remain CLI-only

config.enrichment.significanceGate ('heuristic'|'llm'|'off', existing field)
        │
        └─ independent of reviewEnabled — gates entity-page creation in
           compiler.ts on every ingest, regardless of review scheduling
```

`reviewEnabled` and `significanceGate` are deliberately independent: one controls whether the vault polices itself for existing contradictions/duplicates on a schedule, the other controls entity quality at creation time. Both were "dead" for different reasons and are fixed by different code paths.

## 3. Component 1 — Scheduler wiring

**File:** `src/intelligence/scheduler.ts`

`defaultSchedule()` currently takes no arguments and returns a static array (`:42-91`). Change its signature to accept an optional narrow options object — not the full config type, to avoid a new dependency on `src/config/schema.ts` from the scheduler module:

```typescript
export interface ScheduleOptions {
  reviewEnabled?: boolean;
}

export function defaultSchedule(opts: ScheduleOptions = {}): ScheduledJob[] {
  const base: ScheduledJob[] = [ /* existing 6 entries, unchanged */ ];

  if (opts.reviewEnabled) {
    base.push(
      {
        type: 'detect-contradictions',
        cadence: 'daily',
        intervalSec: 86_400,
        priority: 80, // matches PRIORITY['detect-contradictions'] in jobs/types.ts:88
        dedupeKey: 'detect-contradictions',
      },
      {
        type: 'detect-duplicates',
        cadence: 'daily',
        intervalSec: 86_400,
        priority: 80, // matches PRIORITY['detect-duplicates'] in jobs/types.ts:89
        dedupeKey: 'detect-duplicates',
      },
      {
        type: 'detect-entity-dupes',
        cadence: 'daily',
        intervalSec: 86_400,
        priority: 80, // matches PRIORITY['detect-entity-dupes'] in jobs/types.ts:106
        dedupeKey: 'detect-entity-dupes',
      },
    );
  }
  return base;
}
```

**Call site:** `src/bin/intel-command.ts:281` currently calls `tickScheduler({ stateDir, enqueue: ... })`, relying on `tickScheduler`'s internal `deps.schedule ?? defaultSchedule()` fallback (`scheduler.ts:121`). Change to pass the schedule explicitly:

```typescript
const tickResult = await tickScheduler({
  stateDir,
  enqueue: async (i) => queue.enqueue(i),
  schedule: defaultSchedule({ reviewEnabled: config.maintenance.reviewEnabled }),
});
```

`config` is already in scope at this call site (used earlier in the same function for `config.vaultPath`). No other call sites of `defaultSchedule()` exist outside tests (confirmed via repo-wide grep).

**Behavior once enabled:** identical mechanics to the 6 existing scheduled jobs — `tickScheduler` checks `lastFire[type] + intervalSec` against `now`, enqueues via the existing job queue with `trigger: 'timer'`, and persists the new `lastFire` timestamp to `.karpathy/state/intel-scheduler.json`. No changes needed to `tickScheduler` itself.

**Test additions:** `test/intelligence/scheduler.test.ts` — assert `defaultSchedule({ reviewEnabled: false })` returns exactly the existing 6 entries (regression guard), and `defaultSchedule({ reviewEnabled: true })` returns 9 entries including the 3 new ones with correct `type`/`cadence`/`intervalSec`/`priority`/`dedupeKey`.

## 4. Component 2 — Entity-dedup auto-merge routing

**File:** `src/jobs/handlers/detect-entity-dupes.ts`

Today (confirmed via grounding): this handler calls `detectMergeCandidates()` then `refreshQueue()` unconditionally, appending every candidate to the reconciliation queue regardless of confidence.

**New flow:**

```typescript
const candidates = await detectMergeCandidates(vault);
const AUTO_MERGE_THRESHOLD = 0.85; // matches entity-merger.ts:343 default, kept in sync manually — see note below

const autoCandidates = candidates.filter(c => c.confidence >= AUTO_MERGE_THRESHOLD);
const queueCandidates = candidates.filter(c => c.confidence < AUTO_MERGE_THRESHOLD);

let merged = 0;
const mergeFailures: { sourcePath: string; targetPath: string; error: string }[] = [];
for (const c of autoCandidates) {
  try {
    await mergeEntities(vault, c.sourcePath, c.targetPath);
    merged++;
    await appendLogEntry(vault, `**entity:automerge** — ${c.sourceName} → ${c.targetName} (confidence ${c.confidence.toFixed(2)})`);
  } catch (err) {
    // Isolate per-candidate failures (e.g. target deleted concurrently by
    // another process) so one bad candidate doesn't abort the whole run.
    mergeFailures.push({ sourcePath: c.sourcePath, targetPath: c.targetPath, error: (err as Error).message });
  }
}

if (queueCandidates.length > 0) {
  await refreshQueue(vault, queueCandidates); // existing function, unchanged signature
}
```

This bypasses the existing `autoMerge()` wrapper (`entity-merger.ts:341-377`) deliberately: `autoMerge()` re-runs `detectMergeCandidates()` internally and has no way to hand back the non-auto-merged remainder for queueing. The scheduled job instead calls the same lower-level primitives (`detectMergeCandidates`, `mergeEntities`, `refreshQueue`) that both `autoMerge()` and `reconcile_entities` already use, computing candidates once and routing by confidence itself. `autoMerge()` and its CLI entry point (`karpathy merge --auto`) are untouched and keep working as a separate, on-demand path.

**Note on the 0.85 constant:** it's currently a default parameter value in `autoMerge(vault, threshold = 0.85)`, not an exported constant. Extract it to an exported `AUTO_MERGE_THRESHOLD = 0.85` in `entity-merger.ts` and import it in both places, so the scheduled path and the manual `--auto` CLI path can never drift out of sync.

**Failure mode covered:** if `mergeEntities()` throws (target page deleted between detection and merge — plausible given multiple concurrent job-runner processes were observed during the audit), the candidate is logged as a failure and left out of both the merge count and the queue for this run; it'll be re-detected and re-attempted on the next daily run since `detectMergeCandidates()` re-scans from scratch each time.

## 5. Component 3 — Significance gate wiring into `compiler.ts`

**Files:** `src/intelligence/significance-gate.ts`, `src/compilation/compiler.ts`

### 5.1 Schema extension

`GateResultSchema` (`significance-gate.ts:56-60`) and the `GateDecision` union (`:29-32`) currently have no confidence signal on `drop`. Add one:

```typescript
export type GateDecision =
  | { action: 'keep' }
  | { action: 'merge'; intoSlug: string }
  | { action: 'drop'; reason: string; confidence?: number }; // confidence added

const GateResultSchema = z.object({
  action: z.enum(['keep', 'merge', 'drop']),
  into_slug: z.string().nullable().optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(), // added
});
```

Prompt addition (append to the existing prompt in `llmGate()`, `:76-95`):
```
"confidence": <0.0-1.0, how certain you are in this judgment — especially
  important for "drop": a low-confidence drop means you're not sure this
  isn't a real, worth-keeping entity>
```

`llmGate()`'s `drop` branch (`:101-103`) changes from:
```typescript
if (result.action === 'drop') {
  return { action: 'drop', reason: result.reason ?? 'LLM-judged low signal' };
}
```
to:
```typescript
if (result.action === 'drop') {
  return { action: 'drop', reason: result.reason ?? 'LLM-judged low signal', confidence: result.confidence };
}
```

Heuristic-originated drops (`heuristicGate()`, name-too-short / stopword matches, `:46-47`) never set `confidence` — they're deterministic rules, not judgment calls, so they're never "uncertain" and always execute as outright drops. The confidence field is only ever populated for LLM-judged drops; its absence is itself the signal "this was a clear-cut rule match, not an opinion."

### 5.2 Call-site wiring in `compiler.ts`

Insert before `resolveEntity()`/`createEntityPage()` are called for a new entity candidate:

```typescript
const DROP_REVIEW_THRESHOLD = 0.7; // new config value, see §6

const decision = config.enrichment.significanceGate === 'off'
  ? { action: 'keep' as const }
  : config.enrichment.significanceGate === 'llm'
    ? await llmGate(llm, extracted, candidates)
    : heuristicGate(extracted, candidates);

if (decision.action === 'drop') {
  const isUncertain = decision.confidence !== undefined && decision.confidence < DROP_REVIEW_THRESHOLD;
  if (isUncertain) {
    // Create the page as normal, but flag it — don't silently guess on a
    // judgment call the LLM itself wasn't confident about.
    await createEntityPage(vault, extracted, { review_state: 'unreviewed' });
  }
  // else: confident drop (heuristic rule, or high-confidence LLM drop) — skip page creation entirely.
  continue; // to next extracted candidate
}
if (decision.action === 'merge') {
  await mergeEntityPage(vault, decision.intoSlug, extracted);
  continue;
}
// decision.action === 'keep'
await resolveEntity(vault, extracted); // existing call, unchanged
```

`candidates` (the K most-similar existing entities the gate needs) must be resolved before this call — reuse whatever similarity lookup `resolveEntity()`/`heuristicGate()`'s existing callers already use (the audit's grounding pass found `heuristicGate` is already called with a `candidates: ExistingEntity[]` parameter from `link-concepts.ts`, so a compatible lookup already exists to port over).

**Budget interaction:** `llmGate()` invocation should reserve one `fast`-tier call from the existing `BudgetTracker` (`src/shared/budget.ts`) before calling the LLM, consistent with how `topic-refresh` already reserves a `medium`-tier call (per CLAUDE.md's documented pattern). On budget refusal, fall back to `heuristicGate()`'s result for that candidate (same fallback `llmGate()` already uses internally on LLM API failure, `:105-108`) rather than blocking ingestion.

**Why `compiler.ts` and not `compile-entities.ts`:** `compiler.ts` is the shared execution point both the production rich-extraction path (`compile-entities.ts` → `compiler.ts`) and the legacy path (`link-concepts.ts` → `compiler.ts`, used by manual `re-enrich-note`) pass through. Wiring here means the gate can't silently go stale again if a third caller appears later, versus wiring it into `compile-entities.ts` alone which only fixes today's one active caller.

## 6. Config schema changes

**File:** `src/config/schema.ts`

Two changes to `EnrichmentConfigSchema` (`:210-221`):

1. **`significanceGate` default changes from `'heuristic'` to `'llm'`.** This reflects the explicit choice made in the design conversation (LLM mode, flag uncertain cases for review) — without this change, the wiring in §5 would ship but silently run in heuristic-only mode by default, which is not what was decided. Existing installs that explicitly set `significanceGate: 'heuristic'` or `'off'` in their own config are unaffected (this only changes the schema default applied when the field is unset).
2. New field:

```typescript
significanceGateDropConfidence: z.number().min(0).max(1).default(0.7),
```

Purpose: below this confidence, an LLM `drop` verdict is downgraded to "create the page but flag `review_state: 'unreviewed'`" instead of an outright drop. No new field needed for the entity auto-merge threshold — it reuses the existing `0.85` value from `entity-merger.ts` (extracted to an exported constant per §4), keeping manual (`karpathy merge --auto`) and scheduled behavior identical by construction rather than by two independently-configured numbers.

`config.maintenance.reviewEnabled` — no schema change, it already exists (`schema.ts:49`, default `false`). This spec makes it meaningful; the default stays `false` so nothing changes for existing installs until explicitly opted in.

## 7. Data model / frontmatter

No new frontmatter fields. Reuses the existing base-schema `review_state` (`unreviewed|reviewed|approved|rejected`, `frontmatter.ts:base schema`) for gate-flagged entities — this is the same field the review workflow's `get_review_queue`/`approveReviewItem`/`rejectReviewItem` already read and write, so gate-flagged entities surface through the same existing review UI/tooling as contradiction/duplicate candidates, with no new surface to build.

## 8. Decision tables

**Significance gate outcome, by mode:**

| `significanceGate` config | Candidate matches heuristic drop rule | LLM verdict | Outcome |
|---|---|---|---|
| `off` | — | — | always `keep` (page created, current behavior preserved) |
| `heuristic` | yes | not consulted | drop, no page, no review flag |
| `heuristic` | no, but ≥85% similar to existing | not consulted | merge into existing entity |
| `heuristic` | no | not consulted | keep, page created |
| `llm` | yes | not consulted (heuristic short-circuits) | drop, no page, no review flag |
| `llm` | no | drop, confidence ≥ 0.7 | drop, no page, no review flag |
| `llm` | no | drop, confidence < 0.7 | **keep, page created, `review_state: 'unreviewed'`** |
| `llm` | no | merge | merge into existing entity |
| `llm` | no | keep | keep, page created |
| `llm` | no | LLM call fails / budget refused | falls back to heuristic result for this candidate |

**Entity-dedup routing:**

| Candidate confidence | Action |
|---|---|
| ≥ 0.85 | Immediate merge via `mergeEntities()`, logged to `log.md` |
| < 0.85 | Appended to `reconcile_entities` queue for human decision |
| Merge throws (race/deleted target) | Logged as failure, left for next daily re-scan |

## 9. Observability

New `log.md` entries, following the existing one-line-per-run convention:
- `**entity:automerge** — {sourceName} → {targetName} (confidence {x})` — one per auto-merge
- `**entity:dedupe** — {N} scanned → {M} auto-merged, {K} queued` — one per `detect-entity-dupes` run
- `**review:contradictions** — {N} candidates flagged` — one per `detect-contradictions` run
- `**review:duplicates** — {N} candidates flagged` — one per `detect-duplicates` run

These follow the exact pattern already used by `research:propose`/`topic:refresh`/`digest:weekly` entries, so existing log-parsing conventions (and the quarterly measurement framework from the audit) keep working without change.

## 10. Testing plan

- **Unit — scheduler:** `defaultSchedule({reviewEnabled: false})` === today's 6 entries; `defaultSchedule({reviewEnabled: true})` === 9 entries with correct fields (§3).
- **Unit — entity-dedup routing:** given a mixed list of mock candidates (some ≥0.85, some below), verify auto-merge is called only for the former and `refreshQueue` receives only the latter; verify a thrown merge error doesn't abort processing of remaining candidates.
- **Unit — significance gate schema:** `GateResultSchema` accepts/rejects `confidence` correctly; `llmGate()` propagates `confidence` through on drop verdicts.
- **Unit — compiler.ts gate integration:** mock gate decisions for all rows of the §8 decision table; assert page-creation calls and `review_state` match expectations.
- **Regression:** existing `karpathy review detect`, `karpathy merge --auto`, and `reconcile_entities` MCP tool behavior unchanged (existing tests should still pass unmodified).
- **Manual end-to-end (post-build, before considering this done):** set `reviewEnabled: true` in a test config, run `karpathy intel tick`, confirm `detect-contradictions`/`detect-duplicates`/`detect-entity-dupes` fire, confirm the reconciliation and review queues populate as expected, confirm `log.md` gets the new entry types.

## 11. Explicitly deferred (sub-project B and beyond)

- Tuning the blocklist/prompts for what counts as noise (e.g., catching `Glob`/`Read`-style self-referential tool names more broadly than the current narrow `AGENT_TOOL_NAMES` list).
- Excluding the tool's own development sessions via `project_slug` (the tag already exists end-to-end per the audit's grounding pass — just not used for exclusion anywhere yet).
- Taxonomy changes (which note types exist, indices vs. standalone objects).
- Tightening what counts as a "decision" note.

## 12. Open implementation questions (for the plan phase, not product decisions)

- Confirm the exact "K most-similar existing entities" lookup `compiler.ts` should reuse for `candidates` — the grounding pass found this already exists for `heuristicGate()`'s callers in `link-concepts.ts` but didn't pin down the exact shared helper to port; the implementer should locate and reuse it rather than reimplement similarity lookup.
- Confirm `refreshQueue()`'s exact signature accepts a pre-filtered candidate array (used today with the full unfiltered list) — should be a non-issue but worth a quick read before wiring §4.

# Design: Draft/Archival Lifecycle (Sub-project C)

**Status:** Approved for plan write-up (design conversation complete 2026-07-31, run in minimal-interaction mode per operator instruction; see §16 for the one open item that needs Tom's confirmation — it does not block plan write-up).
**Sub-project:** C. Standalone — not part of the three-way "Content Richness" split (B2a/B2b/B2c), which is complete and merged. No soft dependency on B2's code; this spec reuses the **pattern** Sub-project A established (a persisted, human-resolved queue file) via a new, separate queue, and reuses B1/intelligence-plan machinery (`decay-scan.ts`, `rot-scan.ts`) that already exists.

## 0. Context

Sub-project C had no prior brief beyond the one-line audit label "draft/archival lifecycle." Per the operating instructions, this doc starts from the same place B2b/B2c did: read `specs/specification.md` for lifecycle-relevant normative language, read the real code that implements it, then read the real production vault to find concrete, dated evidence before designing anything.

`specs/specification.md` defines a real state enum for every note — §10.1: `status: draft | active | archived | rejected` — and a real ingest state machine (§11.1: `detected -> classified -> summarized -> extracted -> linked -> logged`). §11.2 additionally sketches a review-state flow (`unreviewed -> reviewed -> approved`, with `rejected` as a terminal alternative). CLAUDE.md's frontmatter section documents `superseded_by` — "wiki-link IDs of newer notes that replace this one" — as an already-shipped time-aware field, implying a designed active → superseded → archived path. None of this, it turns out, is wired to anything in the shipped code for the overwhelming majority of vault content.

### 0.1 Concrete evidence — vault content

Config (`~/.karpathy/config.json`): `vaultPath` = `/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes`, production `Curated/` layout, `maintenance.reviewEnabled: false`. Today's date in-session is 2026-07-31.

**Every single `source_summary` note in the real vault is `status: draft`, forever.** `Curated/sources/` holds 11,876 files. Of these:

```
status: draft     11,499   (96.8% of all files; 100% of real, non-index source summaries)
status: active         1   (the folder's own _index.md — not a real source)
status: archived        0
```

`review_state: unreviewed` on all 11,499 (100%) — no variance at all. `created_at` spans `2026-05-14` through `2026-07-30` — **yesterday**, relative to today's session — so this is an active, ongoing accumulation, not a one-time historical batch that stopped.

**Worse and directly adjacent: 93.7% of those same files are also stuck at the very first stage of the spec's own ingest state machine.**

```
ingest_status: detected      11,133   (93.7%)
ingest_status: classified       133
ingest_status: summarized       222
ingest_status: extracted          2
ingest_status: linked              9
```

Two real files, read in full, confirm these are not merely mis-tagged — they are genuinely never-processed stubs, verbatim:

- `Curated/sources/2026-06-12-c9ecdbb9-3.md` (`ingest_status: detected`, `content_category: ai-conversation-claude`, `project_slug: wf-business-context`, `created_at: 2026-06-12`) — the full raw conversation is copied in under "## Original Content," but:
  ```
  ## Summary
  %% begin:summary %%
  Pending extraction.
  %% end:summary %%

  ## Extracted Entities
  %% begin:entities %%
  No entities extracted yet.
  %% end:entities %%
  ```
- `Curated/sources/p-2026-03-16-...-project-unity-strategy-and-ai-tooling-9.md` (`ingest_status: detected`, `content_category: meeting-notes`, no `project_slug`, `created_at: 2026-05-22`) — same shape, same untouched placeholders.

Age distribution of the 11,133 stuck-at-`detected` files by `created_at` date (top entries): `4916` on `2026-06-12`, `1215` on `2026-06-15`, `1199` on `2026-05-20`, `978` on `2026-05-22`, `858` on `2026-06-11` — and still `321` on `2026-07-28`, `35` on `2026-07-30`. This backlog has never stopped growing.

**By contrast, wiki content is small, correctly `active`, and shows real hand-maintained lifecycle behavior that the base `status` field never gets to participate in.** `Curated/wiki/entities/` (22 files, all `status: active`), `decisions/` (10 files, all `status: active`) — but `decision_status` (a separate, decision-specific field) shows genuine human variety: `confirmed`, `in progress`, `open/pending`, `planned`, `requested` — proof Tom already hand-curates a status-like field for decisions today. He just has no equivalent lever for the base `status` field, or for `project_status`, or for anything in `Curated/sources/`.

**`Curated/review/` — the folder the entire contradiction/duplicate-review mechanism writes into — is completely empty (0 files).** Consistent with `maintenance.reviewEnabled: false`: `detect-contradictions`/`detect-duplicates` have never produced a single artifact in the real vault. `{layout.system}/reconciliation-queue.md` (Sub-project A) likewise does not exist on disk — `detect-entity-dupes`/`karpathy curator` have never been run here either (matching B2c's independent finding).

**`vault-health.md` (rot-scan's output) *does* exist and was regenerated today** (`updated_at: 2026-07-31T23:11:04.786Z`) — 86 notes scanned (only the 7 wiki-content folders rot-scan covers; `Curated/sources/` is not among them), **exactly 1 rot candidate: `Curated/wiki/concepts/glossary.md`**, flagged with age `9999` (unparseable/very old) and no inbound marker. This is a live, present-tense example of the exact gap the task brief hypothesized: **a real detection mechanism (rot-scan) has, right now, identified a real candidate — and there is no button anywhere in the system to act on it.** It just sits in a markdown table forever.

**`decay-scan.ts`'s own archive-candidate signal has a real write path and zero real occurrences.** The field it writes, `archive_candidate: true` (set when `retrievability < archiveThreshold && inboundLinks === 0`), appears **zero times** in real vault frontmatter — the one grep hit across the whole vault was a false-positive substring match inside this very investigation session's own transcript-capture region (`echo "=== archive_candidate usages ==="`), not a real frontmatter value. `retrievability` itself *does* appear on 35 real concept/topic notes, confirming decay-scan has run against real content — its archive-candidate branch just hasn't fired for any of them yet in this vault's current data.

**`superseded_by` is entirely inert.** 215 real occurrences in the vault, **all `[]`** (the schema default). Zero non-empty values anywhere. The field CLAUDE.md documents as a designed part of the lifecycle has never been written to once.

**`project_status`'s "archived"/"completed" buckets are rendered by code that will structurally never have anything to show.** `src/maintenance/indexes.ts`'s `renderProjectsCategory` groups project index entries into `Active | Completed | Archived | Other`, keyed on `project_status` — a fully-built rendering path, confirmed live in the real vault's `Curated/wiki/projects/_index.md`. But `project_status` is written by exactly 3 sites in the whole codebase (`entity-writer.ts`, `project-hub.ts`, `migrate-vault.ts`), and every one of them writes `'active'`. No code path anywhere writes `'archived'` or `'completed'`.

**A partial, existing manual backstop already tacitly acknowledges this exact problem, but only for a slice of it.** `karpathy reprocess-agent` (`src/bin/karpathy.ts`) finds all `Curated/sources/*.md` with `content_category.startsWith('ai-conversation')` AND a `project_slug` AND `ingest_status !== 'linked'`, and manually re-drives them through `agent-ingest`. It does not cover `meeting-notes`-category sources (no `project_slug` in the sample above), does not run on a schedule, and — even when it successfully unsticks a source — never touches the base `status` field.

### 0.2 Concrete evidence — code (the mechanism, precisely)

Full-codebase inspection of every place that writes the base `status` field confirms the vault evidence is not an anomaly — it is the *only possible outcome* of the shipped code:

- **Writers at note-creation time only**, no exceptions found anywhere in `src/`:
  - `status: 'draft'` — `src/ingest/pipeline.ts:69`, `src/ingest/scanner.ts:81`, `src/jobs/handlers/ingest-raw-file.ts:90` (all three `source_summary` creation paths), `src/jobs/handlers/summarize-meeting.ts:164` (`meeting_summary`), `src/review/create-review-item.ts:35` (`contradiction`/review items).
  - `status: 'active'` — `src/ingest/entity-writer.ts:196` (`entity`), `src/compilation/project-hub.ts:74,178` (`project`), `src/session/session-log.ts:42` (`session_summary`).
- **No writer anywhere transitions the base `status` field after creation.** Exhaustive grep for `.status =`, `data.status`, `fm.status`, and every string-literal `status:` assignment across `src/` turns up only the creation sites above, plus read-only consumers (`lint-vault.ts`, `vault-status.ts`, `get-decisions.ts`, `search-entities.ts`, `indexes.ts`) that fall back to `'draft'`/`'unknown'` when reading. **There is no promotion path, no demotion path, no archival path, for any note type, anywhere in the shipped system.**
- **`review_state` *does* have a real post-creation transition** — `approveReviewItem`/`rejectReviewItem` (`src/review/review-queue.ts`), invoked by `karpathy review approve|reject`, do string-replace `review_state: \w+` → `approved`/`rejected` (plus `resolution_state: dismissed` on reject) directly on the raw file. But **neither function touches the base `status` field** — an approved or rejected contradiction note stays `status: draft` forever, alongside its now-settled `review_state`. **`NoteStatus`'s `'rejected'` value (`src/vault/frontmatter.ts:15`) has zero producers anywhere in the codebase** despite being an explicit, deliberately-defined enum member — the schema clearly intended this transition to exist; nothing implements it.
- **`lint_vault`'s `stale_notes` check is structurally blind to 96.8% of the vault.** `src/mcp/tools/lint-vault.ts:173`: `if (status === 'active' && updatedAt && updatedAt < cutoff)`. Because every `source_summary`/`contradiction` note is permanently `draft`, the one general-purpose staleness lint tool that exists cannot ever flag them, by construction.
- **`decay-scan.ts` (4 folders: `concepts/topics/projects/decisions`) and `rot-scan.ts` (7 folders, adds `entities/tools/organizations`) never scan `Curated/sources/`.** The single largest, most stagnant category of vault content — 11,876 files, some untouched for 2.5 months — is invisible to both of the system's only two staleness-detection mechanisms.
- **`decay-scan.ts`'s `archive_candidate` write is dead code with a latent bug.** `runDecayScan()` (`src/intelligence/decay-scan.ts:101-105`):
  ```typescript
  if (r < archiveThreshold && inbound === 0) {
    result.archiveCandidates.push(path);
    fm.review_state = 'unreviewed';
    fm.archive_candidate = true;
  }
  ```
  There is no `else` branch — once set, `archive_candidate` is **never cleared**, even if a later `topic-refresh` fully restores the note's retrievability. Full-codebase grep for `archive_candidate` finds exactly one write site and **zero read sites**. `test/intelligence/decay-scan.test.ts` has zero assertions on this branch — it has never been under test either.
- **`finalize-session` — the one job handler that would advance stuck `summarized`/`extracted`/`linked` sources to `logged` — is itself never enqueued anywhere in the codebase.** `src/jobs/handlers/finalize-session.ts` is registered in the handler map (`src/jobs/handlers/index.ts:57`) and its own type exists in `JobType`, but grep for `type: 'finalize-session'` across every file that isn't its own registration/definition returns **zero results**. It is orphaned, dead code, exactly like `archive_candidate` — a second, independent instance of the same "the mechanism exists, nothing invokes it" pattern.
- **The `ingest_status` state machine itself is real and wired correctly** for the notes that do traverse it: `classify-source.ts:17` → `classified`; `summarize-source.ts:49` / `summarize-meeting.ts:117` → `summarized`; `extract-entities.ts:61,246` → `extracted`; `link-concepts.ts:224` / `compile-entities.ts:29,181` / `agent-ingest.ts:55` → `linked`. This is the *correct* mechanism, actively executing for ~6% of sources; this spec does not touch it (see §0.3).

### 0.3 What's not broken / scope validation

- The `ingest_status` machine correctly runs to completion for every source that reaches it — 222 notes made it to `summarized`, 9 to `linked`, and every entity/decision/project page created via `compileFromSource`/`link-concepts` is correctly `status: active` from the moment it's written. Topic-refresh, decay-scan's refresh path (not its archive path), and rot-scan's thin-content/bare-identity tables all work as B2b/B2c documented. **This spec is not re-litigating extraction or enrichment quality** — it's about the lifecycle layer riding on top of (and, for `source_summary`, currently completely disconnected from) that machinery.
- Tom already hand-maintains a status-like field (`decision_status`) for decisions — proof that manual lifecycle curation is a workflow he already does, it just has no plumbing for the fields this spec addresses (`status`, `project_status`, `superseded_by`).
- **Why 93.7% of sources never advance past `ingest_status: detected` is explicitly *not* investigated or fixed by this spec.** That is a job-queue/scheduler throughput question (is `classify-source` being enqueued? is it draining? is a cron/hook not firing?) — orthogonal to what `status` values should mean and how they should transition once a note *is* processed. It is flagged prominently in §16 as an urgent, separate operator follow-up, alongside the discovery that `finalize-session` is orphaned.

## 1. Goals / Non-goals

**Goals:**

- **G0 — Make `status` a genuinely live field for `source_summary` notes.** Auto-promote `draft → active` the instant a source is meaningfully processed — at the exact points the code already stamps `ingest_status: 'linked'` (`compile-entities.ts:29,181`, `link-concepts.ts:224`). Deterministic, no LLM, no review — this is purely "the pipeline finished its work on this note," a fact the code already knows and simply never writes back to `status`.
- **G1 — Give the stuck-draft backlog visibility.** A new "Stale draft sources" table in `vault-health.md`, surfacing `source_summary` notes still `status: draft` past a configurable age — closing the blind spot identified in §0.2 (rot-scan/decay-scan never scan `Curated/sources/`).
- **G2 — Give stuck drafts a real terminal state.** Auto-archive (`status: draft → archived`) `source_summary` notes that remain `draft` past a longer age threshold. Deterministic, **no human review** — safe because the immutable raw evidence in `raw/` is untouched, the summary note's body is untouched (nothing is deleted), and the transition is trivially reversible (manual edit, or automatically reversed the moment the source is actually processed — see G7).
- **G3 — Give rot-scan's already-computed candidate list (currently reported, never actioned — proven live today by the concept-glossary example in §0.1) a human-reviewed action path.** A new archive queue, modeled directly on Sub-project A's reconciliation-queue pattern, plus a CLI (`karpathy archivist`) and MCP tool (`resolve_archive_candidate`) to decide `archive` / `keep` / `supersede` / `skip` per candidate.
- **G4 — Give `superseded_by` and `project_status: archived`/`completed` their first real producers**, wired through the same archive-queue resolution path from G3.
- **G5 — Give `NoteStatus`'s `rejected` value its first real producer**, by wiring the base `status` field into the existing `review_state` approve/reject transitions (`review-queue.ts`).
- **G6 — Remove decay-scan's dead, buggy `archive_candidate` write.** It has no consumer, no clear-on-recovery branch, and no test coverage; it is fully superseded by rot-scan's already-existing, already-displayed candidate list feeding the new G3 queue.
- **G7 — Close the loop in both directions.** A note that gets archived (via G2 or G3) and later receives genuine new attention — the ingest pipeline finally processes a stuck draft, or `topic-refresh`/`re-enrich-note` successfully rewrites an archived wiki note's content — automatically flips back to `status: active`. Archival should never become a one-way trap that silently excludes a note from future automated engagement.

**Non-goals:**

- **Fixing why 93.7% of `source_summary` notes never advance past `ingest_status: 'detected'`.** A job-queue/scheduler throughput problem, not a lifecycle-semantics problem. Flagged as an urgent operator follow-up in §16, not fixed here.
- **Any physical file moves or a literal `archived/` folder.** Frontmatter-only, matching every prior sub-project (B2a/B2b/B2c never move files) and avoiding the wikilink-breakage risk that folder restructuring would introduce.
- **Deleting any note, ever.** Archival is a status flip plus two optional metadata fields (`archived_at`, `archived_reason`) — never a delete, never a content change.
- **Auto-archiving wiki content (entity/concept/project/decision/topic pages) without human review.** Those pages represent curated understanding a human may still value even at low retrievability or with an orphan/rot signal — always queue-and-decide (G3), never silent, matching FR-6's spirit and Sub-project A's established precedent even though FR-6 doesn't literally name archival among its required-review list.
- **Changing rot-scan's or decay-scan's existing stale/thin-content/bare-identity/retrievability detection algorithms.** Reused exactly as they are (G3 consumes rot-scan's existing `candidates` output unmodified; only decay-scan's dead archive-candidate *write* is removed, per G6).
- **Any new LLM call.** Every component in this spec is deterministic-lane (spec §7.1) — string comparisons, age arithmetic, frontmatter writes. Matches decay-scan/rot-scan's existing zero-LLM cost profile.
- **Enabling `maintenance.reviewEnabled` in the real vault's config.** An operator action outside this repo, flagged (§16) not performed — matching the precedent set by B2c for the identical setting.
- **`session_summary` lifecycle.** Sessions are append-only history, already correctly `status: active` from creation, and archiving old sessions was not identified as a real problem in the audit (5,802 of 5,809 are `active`, and nothing in the vault or code suggests Tom wants old sessions hidden from search/backlinks the way stale drafts or rotted wiki pages should be). Not scoped.
- **Re-enqueuing or fixing the orphaned `finalize-session` job.** Flagged in §16 as further evidence of the scheduling-side gap; not wired up by this spec, since doing so correctly would require understanding *why* it was never enqueued in the first place — a scheduler-design question, not a lifecycle-semantics one.

## 2. Architecture overview

```
src/vault/frontmatter.ts (MODIFIED)
  BaseFrontmatterSchema gains archived_at (optional ISO string) and
  archived_reason (optional string) — apply to any note type, mirroring
  how last_verified/stability/superseded_by already live on the base schema.

src/intelligence/decay-scan.ts (MODIFIED)
  Removes the dead archive_candidate / review_state='unreviewed' write
  branch (G6). DecayScanResult drops archiveCandidates: string[].
  Retrievability computation and the refresh-enqueue path are UNCHANGED.

src/intelligence/rot-scan.ts (MODIFIED)
  Two additions, each an independent pass alongside the existing rot/
  thin-content/bare-identity checks:
    1. Stale-draft source scan (NEW folder: layout.sources) — G1.
       Produces StaleDraftEntry[] + a new "Stale draft sources" table.
    2. Feeds its own existing `candidates: RotEntry[]` (already computed,
       already rendered) into the new archive queue via
       refreshArchiveQueue() — G3.

src/maintenance/archive-queue.ts (NEW)
  Mirrors reconciliation-queue.ts's shape and API exactly:
  {layout.system}/archive-queue.md, ArchiveEntry, readArchiveQueue(),
  refreshArchiveQueue(), resolveArchiveEntry(), pendingArchiveEntries().

src/jobs/handlers/archive-stale-drafts.ts (NEW)
  New job type 'archive-stale-drafts'. Scans layout.sources for
  status:'draft' notes older than staleDraftArchiveDays; sets
  status:'archived' + archived_at + archived_reason. Deterministic,
  no review (G2). Scheduled daily.

src/jobs/handlers/compile-entities.ts, link-concepts.ts (MODIFIED)
  One-line draft/archived -> active promotion at the two existing
  ingest_status = 'linked' write sites (G0, G7).

src/jobs/handlers/topic-refresh.ts, re-enrich-note.ts (MODIFIED)
  archived -> active recovery on a successful content write (G7).

src/review/review-queue.ts (MODIFIED)
  approveReviewItem sets status: active; rejectReviewItem sets
  status: rejected (G5) — alongside their existing review_state writes.

src/bin/karpathy.ts (MODIFIED)
  New `karpathy archivist` interactive CLI command, modeled on
  `curatorCommand` (G3).

src/mcp/tools/resolve-archive-candidate.ts (NEW)
  Mirrors reconcile-entities.ts's read/apply-decision shape (G3).
  Registered in src/mcp/tools/index.ts + router.ts.

src/config/schema.ts (MODIFIED)
  New intelligence.lifecycle sub-schema (§9).

src/jobs/types.ts, src/jobs/handlers/index.ts, src/intelligence/scheduler.ts (MODIFIED)
  New job type 'archive-stale-drafts', scheduled daily. No new job type
  needed for G3 — folded into the existing weekly rot-scan job.
```

## 3. Component 0 — Frontmatter additions

**File:** `src/vault/frontmatter.ts`

```typescript
export const BaseFrontmatterSchema = z.object({
  // ...existing fields unchanged...

  // --- Sub-project C: draft/archival lifecycle ---
  /** ISO timestamp this note transitioned to status: archived. Cleared on un-archival (G7). */
  archived_at: z.string().optional(),
  /** Free-text reason the note was archived, e.g. "stale-draft (34d at ingest_status: detected)",
   *  "rot: stale+orphan", "superseded". Cleared on un-archival (G7). */
  archived_reason: z.string().optional(),
});
```

Both fields live on the base schema (not a type-specific extension) because archival applies uniformly across `source_summary` (G2), `entity`/`concept`/`project`/`decision`/`topic` (G3), and `contradiction` (G5 rejection is a related-but-distinct terminal state, not archival, and does not set these fields) — matching how `last_verified`/`stability`/`superseded_by` are already base-schema fields for the identical "applies broadly" reason. Both are optional/defaulted-absent, fully backward-compatible with every existing note.

## 4. Component 1 — Draft → active promotion for `source_summary` (G0)

The three real, currently-executing call sites that stamp `data.ingest_status = 'linked'` are exactly the right hook points — reaching `'linked'` means the pipeline extracted real value from the source (or, for a self-referential source, correctly decided there was nothing further to compile — `compile-entities.ts`'s early-return branch at line 29 already stamps `'linked'` in that case too, so no special-casing is needed).

**File:** `src/jobs/handlers/link-concepts.ts`, existing block around line 220-227:

```typescript
// Update source summary with links
const summaryContent = await context.vault.read(summaryPath);
const { data, body } = parseNote(summaryContent);
data.links = [...new Set([...(data.links as string[] ?? []), ...linkedPaths])];
data.ingest_status = 'linked';
// NEW (G0/G7): a source that just got linked has demonstrably been processed —
// promote out of 'draft', and out of 'archived' if a prior stale-draft sweep
// (§6) or manual edit had parked it there. Never touch 'rejected' — a human
// explicitly rejecting a source is a stronger signal than pipeline progress.
if (context.config.intelligence.lifecycle.enabled && data.status !== 'active' && data.status !== 'rejected') {
  data.status = 'active';
  data.archived_at = undefined;
  data.archived_reason = undefined;
}
data.updated_at = nowISO();
const updated = serializeNote(data, body);
await context.vault.atomicWrite(summaryPath, updated);
```

**File:** `src/jobs/handlers/compile-entities.ts`, both write sites (line 29's self-referential early return, and line 181's normal completion path) get the identical block, immediately before their existing `ingest_status = 'linked'` assignment.

`serializeNote`'s underlying `gray-matter` stringifier omits `undefined`-valued keys, so setting `archived_at`/`archived_reason` to `undefined` cleanly removes them from the written frontmatter rather than serializing literal `null`s — verified against the existing pattern in `entity-writer.ts`'s `mergeEntityPage`, which relies on the same omission behavior.

This closes G0 completely for the ~6% of sources that do reach `'linked'` today, and — per §0.3's scope boundary — does *nothing* for the 93.7% still stuck at `detected`/`classified`, because there is no live code path that would ever call this block for them. That gap is what G1/G2 exist for.

## 5. Component 2 — Stale-draft visibility (G1)

**File:** `src/intelligence/rot-scan.ts` (modified)

A new, independent scan pass over `layout.sources`, deliberately **not** folded into the existing 3-of-4 rot-scoring rule (§0.2 already shows why: every `source_summary` is "low confidence" and orphan by design — that scoring rule was tuned for wiki content, and running it unmodified against 11,876 sources would flag nearly all of them under a rule not built for this shape of content).

```typescript
export interface StaleDraftEntry {
  path: string;
  title: string;
  ageDays: number;
  ingestStatus: string;
}

// Added to RotScanResult:
export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  bareIdentityCandidates: BareIdentityEntry[];
  staleDraftCandidates: StaleDraftEntry[]; // NEW
  reportPath: string;
}
```

Inside `runRotScan`, a new pass gated on `config.intelligence.lifecycle.staleDraftReportingEnabled` (default `true`), run **before** the existing `scanFolders(layout)` loop since it targets a different folder and a different note `type`:

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

`renderReport()` gains a fourth table, "Stale draft sources," following the exact same convention as the existing three (own protected-region id `vault-health-stale-drafts`, own markdown table, reporting-only — this pass never writes to the source notes themselves; that's G2's job, a separate mechanism with a separate, longer threshold). Note the check is on `status === 'draft'`, not on `ingest_status` directly — because Component 1 already guarantees that once a source is genuinely processed (`ingest_status` reaches `'linked'`), `status` flips to `'active'` and the note naturally drops out of this table. A note appearing here is, by construction, exactly the class of note this spec is about: still `draft`, still not meaningfully processed, sitting past a week or two.

Given real vault data (11,499 notes currently `draft`, most well past 14 days old), this table will initially be enormous — expected and correct; see §11 edge cases for the intentional design response (a `limit` parameter, matching every other MCP-facing report in this codebase).

## 6. Component 3 — Stale-draft auto-archival (G2)

**File:** `src/jobs/handlers/archive-stale-drafts.ts` (new)

```typescript
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

This is a **fully deterministic, no-review** transition — spec §12.2 explicitly permits automation to update "deterministic fields such as backlinks, index references, alias tables, metadata" without review, and `status` here is being used in exactly that register: nothing is deleted, the raw evidence in `raw/` is untouched (spec §5.1's immutability rule was never at risk), the summary note's body/protected regions are untouched, and the transition is fully reversible (manual edit, or automatically the moment the source is actually processed — Component 1's `data.status !== 'active'` guard already flips a previously-archived note back to `active` the instant `link-concepts`/`compile-entities` finally runs on it).

**Job registration:** `'archive-stale-drafts'` added to `JobType` (`src/jobs/types.ts`), `DEFAULT_PRIORITIES['archive-stale-drafts'] = 90` (same tier as `rot-scan`/`decay-scan`), handler registered in `src/jobs/handlers/index.ts`, scheduled daily in `defaultSchedule()` (`src/intelligence/scheduler.ts`) at `intervalSec: 86_400`, `dedupeKey: 'archive-stale-drafts'` — same cadence and pattern as `decay-scan`.

## 7. Component 4 — Archive queue infrastructure (G3)

**File:** `src/maintenance/archive-queue.ts` (new) — deliberately mirrors `src/maintenance/reconciliation-queue.ts` field-for-field and function-for-function, since it solves the identical problem shape (a detector produces candidates; a human resolves them at their own pace; resolutions persist and are never re-proposed).

```typescript
import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
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
  await vault.atomicWrite(archiveQueuePath(layout), `${HEADER}${summary}${open}\n${json}\n${close}\n`);
}

/** Append new candidates, deduplicated by `path` (unlike reconciliation-queue's
 *  pair-key dedup — archive candidates are single notes, not pairs). Existing
 *  entries in ANY status (pending/resolved/skipped) block re-addition, so a
 *  'keep' or 'skip' decision permanently silences that candidate. */
export async function refreshArchiveQueue(
  vault: VaultAdapter,
  candidates: ArchiveCandidate[],
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const queue = await readArchiveQueue(vault, layout);
  const existing = new Set(queue.entries.map((e) => e.path));
  let added = 0;
  for (const c of candidates) {
    if (existing.has(c.path)) continue;
    existing.add(c.path);
    queue.entries.push({ id: nanoid(), status: 'pending', ...c });
    added++;
  }
  if (added > 0) await writeArchiveQueue(vault, queue, layout);
  return added;
}

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

export function pendingArchiveEntries(queue: ArchiveQueue): ArchiveEntry[] {
  return queue.entries.filter((e) => e.status === 'pending');
}
```

## 8. Component 5 — Feeding rot-scan's existing candidates into the queue (G3, continued) + decay-scan cleanup (G6)

**File:** `src/intelligence/rot-scan.ts` (modified) — `runRotScan` already computes `candidates: RotEntry[]` (the stale+orphan+low-confidence 3-of-4 rule, unchanged). The only new work is turning that already-displayed list into queue entries:

```typescript
// At the end of runRotScan, after candidates/thinCandidates/bareIdentityCandidates
// are computed and before the report is written:
if (layout && candidates.length > 0 /* gated on config.intelligence.lifecycle.archiveQueueEnabled, threaded in via options */) {
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
```

`RunRotScanOptions` gains `archiveQueueEnabled?: boolean` (threaded from `rotScanHandler`'s `context.config.intelligence.lifecycle.archiveQueueEnabled`), so `runRotScan` itself stays testable without the config plumbing when called directly from unit tests (defaults to `false` when the option is omitted, preserving every existing `rot-scan.test.ts` call site byte-for-byte — an explicit opt-in avoids a silent behavior change for any test or caller that doesn't pass the new option).

This is the entire fix for the "detection exists, no action" gap demonstrated live by the concept-glossary example in §0.1: rot-scan already runs weekly, already computes exactly the right candidate list, already writes it to a human-readable table — it just needed one more line calling `refreshArchiveQueue`.

**File:** `src/intelligence/decay-scan.ts` (modified, G6) — remove the dead branch entirely:

```typescript
// REMOVED:
//   if (r < archiveThreshold && inbound === 0) {
//     result.archiveCandidates.push(path);
//     fm.review_state = 'unreviewed';
//     fm.archive_candidate = true;
//   }
```

`DecayScanResult.archiveCandidates: string[]` is removed from the interface. `archive_candidate` is removed from `EntitySchema`/`BaseFrontmatterSchema` consideration — it was never added to the Zod schema in the first place (it was always an ad-hoc frontmatter write bypassing schema validation), so no schema change is needed, only the write-site removal. The `archiveThreshold` config value (`intelligence.decay.retrievabilityArchive`) is **kept** — it remains meaningful input to rot-scan's candidate reasoning is not directly reused (rot-scan's own stale+orphan+low-confidence rule is independent of decay-scan's retrievability number), but decay-scan's `retrievability`/`retrievability_checked_at` frontmatter stamping is unchanged and still feeds rot-scan's `RotEntry.retrievability` display field. Since `test/intelligence/decay-scan.test.ts` has zero existing assertions on `archiveCandidates`/`archive_candidate` (confirmed in §0.2), this removal requires no test updates beyond deleting the now-nonexistent field from any fixture result objects that happen to reference it.

## 9. Component 6 — Resolution paths (G3, G4)

Three resolution surfaces, modeled directly on Sub-project A's `karpathy curator` / `reconcile_entities` pair.

**CLI — `karpathy archivist`** (`src/bin/karpathy.ts`, new function `archivistCommand`, modeled on `curatorCommand`):

```
$ karpathy archivist

Archive queue: 1 pending candidate(s).
Decisions: [a]rchive  [k]eep  [S]upersede  [s]kip  [q]uit

─────────────────────────────────────────
  Note:    "Concept glossary"
           Curated/wiki/concepts/glossary.md
  Reason:  rot-scan: age 9999d, confidence unknown, inbound no
Decision [a/k/S/s/q]:
```

- `a` (archive) — sets `status: 'archived'`, `archived_at: now`, `archived_reason: entry.reason` on the target note. If `data.type === 'project'`, **also** sets `project_status: 'archived'` in the same write (G4 — this is the archived bucket's first real producer). Calls `resolveArchiveEntry(vault, entry.id, 'archive')`. Enqueues `rebuild-indexes` (not a full backlinks rebuild — archival never changes wikilink targets, so a backlinks rebuild is unnecessary work; `rebuild-indexes` is needed so index pages that group by `status`/`project_status` reflect the change).
- `k` (keep) — `resolveArchiveEntry(vault, entry.id, 'keep')`. No note changes. Permanently silences this candidate (dedup-by-path in `refreshArchiveQueue` blocks re-addition regardless of resolved status), matching the design intent that a human "keep" decision should never be re-nagged by next week's rot-scan re-detecting the identical note.
- `S` (supersede) — prompts for a replacement note path (validated to exist via `vault.exists`), sets `status: 'archived'`, `archived_at: now`, `archived_reason: 'superseded'`, and **appends** the replacement path to the target's `superseded_by` array (deduped) — G4's second producer, the field's first-ever real write anywhere in the codebase. One-directional only (the replacement note is not back-linked), matching the field's documented purpose ("wiki-link IDs of newer notes that replace this one" — directional by definition). Calls `resolveArchiveEntry(vault, entry.id, 'supersede', supersededByPath)`.
- `s` (skip) — `resolveArchiveEntry(vault, entry.id, 'skip')`. Hidden from future `archivist` runs, matching `curator`'s skip semantics exactly.
- `q` (quit) — exits; remaining entries stay `pending`.

**MCP — `resolve_archive_candidate`** (`src/mcp/tools/resolve-archive-candidate.ts`, new): mirrors `reconcile-entities.ts`'s exact shape — no arguments returns up to 10 pending entries (`readArchiveQueue` + `pendingArchiveEntries`, `.slice(0, 10)`); `{ id, decision, supersededByPath? }` applies a decision. `decision: 'supersede'` requires `supersededByPath` and validates its existence via `ctx.vault.exists`, mirroring `reconcile_entities`'s existing path-existence guard for merge/rename. Registered in `src/mcp/tools/index.ts` (definitions) and `src/mcp/tools/router.ts` (handler dispatch), with a test added to `test/mcp/tools.test.ts` per this project's established convention (CLAUDE.md "Add a new MCP tool").

**No third CLI path is added** (Sub-project A additionally has `karpathy merge` as a direct non-queue path; there is no equivalent direct "archive this note right now" one-liner in this spec — `karpathy archivist`/`resolve_archive_candidate` are the only two paths, since a direct-archive command would bypass the very review step G3 exists to enforce, and manual frontmatter editing already covers the "I just want to flip one field by hand" case per the project's "repairable by a human using ordinary files on disk" goal, spec §3.7).

## 10. Component 7 — `review_state` → `status` wiring (G5)

**File:** `src/review/review-queue.ts` (modified) — one additional `.replace()` in each function, matching the existing raw-string-replace style already used in this file (not `parseNote`/`serializeNote`, to stay consistent with how `review_state`/`resolution_state`/`updated_at` are already mutated here):

```typescript
export async function approveReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: approved')
    .replace(/status: \w+/, 'status: active') // NEW (G5)
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);
  // ...unchanged below...
}

export async function rejectReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: rejected')
    .replace(/resolution_state: \w+/, 'resolution_state: dismissed')
    .replace(/status: \w+/, 'status: rejected') // NEW (G5) — NoteStatus's 4th enum value, first real producer
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);
  // ...unchanged below...
}
```

An approved contradiction/duplicate finding becomes genuinely-settled `active` knowledge; a rejected one becomes `rejected` — giving that enum value, defined in the schema since before this spec and never once produced, its first real writer. Both regexes match the existing single-line `status: draft` frontmatter format that `create-review-item.ts` always writes (confirmed: every review item's frontmatter is built via the same flat `Object.entries(...).map(...)` serialization in that file, never YAML block form for scalar fields), so the same regex approach that already works for `review_state`/`resolution_state` on this exact file shape works identically here.

## 11. Component 8 — Un-archival on re-engagement (G7)

Beyond Component 1's `source_summary` recovery (§4), two more integration points close the loop for wiki content archived via G3:

**File:** `src/jobs/handlers/topic-refresh.ts` (modified) — after a successful protected-region rewrite:

```typescript
// Existing: clears pending_evidence, stamps last_verified, bumps stability...
if (data.status === 'archived') {
  data.status = 'active';
  data.archived_at = undefined;
  data.archived_reason = undefined;
  log.info('Un-archived note on successful refresh', { path: targetPath });
}
```

**File:** `src/jobs/handlers/re-enrich-note.ts` (modified) — identical block after a successful (non-no-op) enrichment pass, per spec §23.2's existing "fewer than 50 characters → no-op" gate: only a *real* re-enrichment (human added substantive content, extraction found something) counts as re-engagement; the existing no-op path is unaffected and does not un-archive.

This means an archived note is never a dead end: if the decay/refresh machinery (or a human running `karpathy touch`) ever successfully engages with it again, it comes back to `active` automatically, without requiring a second trip through the archive queue's resolution UI. Manual `status: archived → active` frontmatter edits remain available at all times regardless of this mechanism, per the project's general "repairable by hand" principle.

## 12. Config schema changes

**File:** `src/config/schema.ts`

```typescript
export const LifecycleConfigSchema = z.object({
  /** Master gate for all Sub-project C behavior (G0-G7). */
  enabled: z.boolean().default(true),
  /** G1: age (days) past which a draft source_summary appears in vault-health.md's
   *  "Stale draft sources" table. */
  staleDraftReportDays: z.number().int().positive().default(14),
  /** G2: gate for auto-archiving stale drafts. Independent of `enabled` so an
   *  operator can keep G0/G1/G3-G5 while opting out of auto-archival specifically. */
  staleDraftArchiveEnabled: z.boolean().default(true),
  /** G2: age (days) past which a draft source_summary is auto-archived. Must be
   *  >= staleDraftReportDays (validated at config-load time, matching the existing
   *  pattern for intelligence.decay's two-threshold refresh/archive relationship). */
  staleDraftArchiveDays: z.number().int().positive().default(30),
  /** G3: gate for rot-scan feeding its candidates into the new archive queue.
   *  Defaults to true; independent of maintenance.reviewEnabled (this queue is
   *  populated by the always-scheduled weekly rot-scan, not by the
   *  reviewEnabled-gated detect-* jobs). */
  archiveQueueEnabled: z.boolean().default(true),
});
```

Wired into `IntelligenceConfigSchema` as `lifecycle: LifecycleConfigSchema.default({})`, alongside the existing `decay`/`refresh`/`richness` fields, plus the corresponding entry in the partial/override schema (already generic via `.partial()`, matching the existing pattern for every other intelligence sub-schema — no `loader.ts` changes needed, `mergeOverride()` already merges nested keys generically).

A config-load-time check (in `src/config/loader.ts`, alongside any existing cross-field validation) warns (does not throw) if `staleDraftArchiveDays < staleDraftReportDays`, since a note should always be *reported* before it's *archived* — matching `intelligence.decay`'s existing (unenforced, but semantically intended) `retrievabilityRefresh > retrievabilityArchive` relationship.

**No new fields needed on `ReviewConfigSchema`, `MaintenanceConfigSchema`, or `intelligence.decay`.** Component 5's `archiveQueueEnabled` check is independent of `maintenance.reviewEnabled` deliberately: `reviewEnabled` gates the contradiction/duplicate/entity-dedup jobs (which are opt-in, off by default, and off in the real vault today per §0.1), whereas `rot-scan` is **already unconditionally scheduled weekly** regardless of `reviewEnabled` (confirmed: `rot-scan` is in `defaultSchedule()`'s unconditional block, not the `if (opts.reviewEnabled)` block) — so gating G3 behind `reviewEnabled` would mean the archive queue never populates in the real vault at all today, defeating the purpose of fixing a gap that's currently live (the concept-glossary candidate, §0.1).

## 13. Data model / frontmatter summary

```yaml
# BaseFrontmatterSchema additions (Sub-project C):
archived_at: undefined       # ISO timestamp; set on archival, cleared on un-archival (G7)
archived_reason: undefined   # free text; set on archival, cleared on un-archival (G7)
```

**No changes to `NoteStatus`, `ReviewState`, or any type-specific schema's own status-like field** (`decision_status`, `project_status`, `ingest_status`, `resolution_state`) — this spec gives existing enum values and existing fields their first real automated producers; it does not add new enum values or new status-like fields. The one exception is the two new optional base fields above, which exist purely as archival metadata (when/why), not as additional state.

**Reconciliation queue (Sub-project A) and archive queue (this spec) are deliberately separate files/mechanisms**, not a merged or generalized "decision queue." They solve related-but-distinct problems (pairwise entity-merge candidates vs. single-note archive candidates), have different candidate shapes (`sourcePath`+`targetPath` vs. a single `path`), and different decision vocabularies (`merge`/`rename`/`skip`/`manual` vs. `archive`/`keep`/`supersede`/`skip`). Merging them into one generic queue was considered and rejected: the resulting union type and branching decision-application logic would be harder to reason about than two small, focused files, and the two mechanisms are resolved by two different mental models (identity resolution vs. relevance/staleness judgment).

## 14. Decision tables

**`source_summary` status lifecycle (G0/G2/G7):**

| Event | `status` before | `status` after |
|---|---|---|
| Note created (`ingest-raw-file`/`pipeline.ts`/`scanner.ts`) | — | `draft` |
| `ingest_status` reaches `linked` (`compile-entities.ts`, `link-concepts.ts`) | `draft` or `archived` | `active` |
| `ingest_status` reaches `linked`, status already `active` | `active` | `active` (no-op) |
| `ingest_status` reaches `linked`, status is `rejected` | `rejected` | `rejected` (never overridden) |
| Age ≥ `staleDraftReportDays`, still `draft` | `draft` | `draft` (reported in vault-health.md only, §5) |
| Age ≥ `staleDraftArchiveDays`, still `draft` | `draft` | `archived` (+ `archived_at`, `archived_reason`) |
| No action taken | unchanged | unchanged |

**Wiki-content archive-queue resolution (G3/G4):**

| Decision | Target note changes | Queue entry |
|---|---|---|
| `archive` | `status: archived`, `archived_at`, `archived_reason`; `project_status: archived` too if `type === 'project'` | `resolved`, `decision: archive` |
| `keep` | none | `resolved`, `decision: keep` |
| `supersede` | `status: archived`, `archived_at`, `archived_reason: 'superseded'`, `superseded_by` gains the replacement path | `resolved`, `decision: supersede`, `supersededByPath` set |
| `skip` | none | `skipped` |

**Review-item status wiring (G5):**

| CLI command | `review_state` after | `status` after |
|---|---|---|
| `karpathy review approve <path>` | `approved` | `active` (NEW) |
| `karpathy review reject <path>` | `rejected` (+ `resolution_state: dismissed`) | `rejected` (NEW) |

## 15. Edge cases and failure modes

- **The first `archive-stale-drafts` run against the real vault will archive a very large number of notes at once.** With `staleDraftArchiveDays: 30` and today's data (11,499 drafts, most 30-90+ days old), the first scheduled run after this ships will likely flip the large majority of `Curated/sources/` to `status: archived` in one pass. This is the **intended, correct** effect of closing the gap described in §0.1 — not a bug — but it is a large, visible, one-time change an operator should expect (surfaced via the `lifecycle:archive-stale-drafts` log-line's count, and via the fact that `vault-health.md`'s "Stale draft sources" table, populated by the *lower* `staleDraftReportDays` threshold, will have already shown this backlog for at least `staleDraftArchiveDays - staleDraftReportDays` = 16 days before the archival actually happens on any newly-created draft — existing drafts already older than 30 days at rollout time archive immediately on the first run, with no grace period, since the age check is absolute, not rollout-relative). Flagged explicitly to Tom in §16.
- **A `source_summary` archived by G2, then later manually re-ingested (e.g. via `karpathy touch` or a fresh drop of the same raw file) does not need any special unarchive step** — Component 1's `data.status !== 'active'` guard fires identically whether the prior status was `draft` or `archived`, so successful reprocessing always lands on `active`.
- **`karpathy reprocess-agent` interaction:** if an operator runs the existing `reprocess-agent` command against a source that G2 already archived, `agent-ingest`'s own completion path (`agent-ingest.ts:55`, `data.ingest_status = 'linked'`) needs the same one-line G0/G7 promotion guard added (a 4th call site, alongside the three named in §4) — included in the implementation scope of Component 1, not called out as its own component since it's the identical one-line change at a 4th, symmetric location.
- **Rot-scan's archive-queue feed re-detects a `keep`d or `skip`ped note every week — but the dedup-by-path check in `refreshArchiveQueue` silently absorbs it.** No re-notification, no log noise; matches reconciliation-queue's identical behavior for `skip`ped entity-merge candidates.
- **A project archived via the queue, then later un-archived manually** (direct frontmatter edit `status: archived → active`): this spec does **not** auto-sync `project_status` back to `active` in that manual-edit case (only the `archive`-decision code path in Component 6 writes both fields together). This is an accepted asymmetry — `indexes.ts`'s `renderProjectsCategory` already falls back `(e.data.project_status as string) ?? e.status`, so a manually-reactivated project with a stale `project_status: archived` would still render in the wrong index bucket until also hand-corrected. Noted, not fixed — fixing it generally would require a bidirectional-sync guard on every possible future writer of either field, which is unbounded scope for a narrow edge case; the one real producer this spec creates (Component 6's `archive` decision) already keeps both fields in lockstep at the moment of archival, which is the case that matters.
- **`supersede` decision where the chosen replacement path is itself later archived or deleted:** `superseded_by` entries are never validated for continued existence after being written (matching `derived_from`/`source_refs`'s existing no-validation precedent elsewhere in the codebase) — a dangling `superseded_by` reference is a cosmetic staleness issue, not a correctness or safety issue, since nothing currently *reads* `superseded_by` to make decisions (see next point).
- **`superseded_by` still has no reader after this spec ships**, only its first writer. No code currently displays "this note was superseded by X" anywhere in the UI/CLI/MCP surface (`get_note`, `search`, etc. don't special-case it). This spec closes the "give it a producer" half of the gap; wiring a consumer (e.g. a banner in `get_note`'s rendered output, or excluding superseded notes from default `search` ranking) is explicitly deferred (§16) as a follow-up once real `superseded_by` data exists to design a consumer against.
- **A `contradiction`/review-item note that was never approved or rejected** (still sitting at `review_state: unreviewed`) is unaffected by G5 — it stays `status: draft` exactly as it does today, correctly, since G5 only fires on an explicit approve/reject action.
- **Interaction with `maintenance.reviewEnabled: false` in the real vault:** since `detect-contradictions`/`detect-duplicates` never run automatically today, `Curated/review/` will remain empty regardless of this spec, and G5 will have zero real notes to act on until an operator either enables `reviewEnabled` or manually runs `karpathy review detect`. This mirrors B2c's identical, already-flagged finding about the same config value — not a new gap, just the same one showing up from a second angle.
- **`TransientLLMError` / retry interaction:** none of this spec's components make any LLM call (§1 non-goals) — every write is a deterministic frontmatter mutation. There is no new transient-failure surface; the existing per-job retry/quarantine machinery (spec §8.3) applies uninspected, exactly as it does for `rot-scan`/`decay-scan` today.
- **Concurrent archival and topic-refresh on the same note:** `topic-refresh`'s existing budget-reservation-then-write flow (spec §8.6/8.7) and Component 3's age-based archival scan both use `vault.atomicWrite`, so a race only affects which write lands last — no malformed frontmatter (matches the general atomic-write guarantee, spec §8.4). Worst case, an archived note gets un-archived one tick later by Component 8's un-archival guard if `topic-refresh` happened to run right after — a harmless, self-correcting outcome, not a bug.

## 16. Observability

- `vault-health.md` gains a fourth table ("Stale draft sources," §5) alongside the existing rot/thin-content/bare-identity tables — same rendering convention, own protected-region id, reporting-only.
- `archive-queue.md` (new file, `{layout.system}/archive-queue.md`) is the operator-visible surface for G3, readable directly in Obsidian exactly like `reconciliation-queue.md`.
- `log.md` gains one new entry kind: `lifecycle:archive-stale-drafts` (Component 3, one line per scheduled run, count of notes archived) — matches the existing `entity:dedupe`/`entity:automerge` log-line convention from Sub-project A.
- No new logging needed for Components 1/7/8/10 (draft→active promotion, un-archival) — these piggyback on the existing `log.info` calls already present in `link-concepts.ts`/`compile-entities.ts`/`topic-refresh.ts`/`re-enrich-note.ts`, with one additional structured field (`statusPromoted: boolean` or similar) rather than a new log line, matching the logging density already established in those files.

## 17. Testing plan

- `frontmatter.ts`: `archived_at`/`archived_reason` round-trip through `parseNote`/`serializeNote` as optional, absent-by-default fields; existing fixture notes without them still validate.
- `rot-scan.ts`: `scanStaleDraftSources` — a fixture vault with one `source_summary` at `status: draft`, `created_at` 20 days ago (above the 14-day report default) appears in `staleDraftCandidates`; one at 5 days old does not; one at `status: active` does not (regardless of age); `_index.md` is excluded. `refreshArchiveQueue` wiring — a fixture vault whose `runRotScan` produces one `RotEntry` results in exactly one new `archive-queue.md` entry when `archiveQueueEnabled: true`, and zero when `false` or omitted (regression: existing `rot-scan.test.ts` calls that don't pass the option see no behavior change). Existing rot/thin-content/bare-identity table tests unaffected (regression).
- `decay-scan.ts`: remove the (nonexistent) `archiveCandidates`/`archive_candidate` assertions — there are none today (§0.2), so this is confirmation-only; add one regression test asserting `archive_candidate` is never written to output frontmatter post-removal, to guard against reintroduction.
- `archive-queue.ts`: mirrors `reconciliation-queue.test.ts` structurally — round-trip read/write through the protected region; `refreshArchiveQueue` dedup-by-path (adding the same path twice only creates one entry, regardless of intervening status changes); `resolveArchiveEntry` for each of the four decisions sets the right `status`/`decision`/`supersededByPath`/`resolvedAt`; `pendingArchiveEntries` filters correctly.
- `archive-stale-drafts.ts` (job handler): a fixture `source_summary` at `status: draft`, 35 days old (above the 30-day archive default) gets `status: archived` + `archived_at` + `archived_reason` containing its `ingest_status`; one at 25 days old (above report, below archive) is untouched; one already `status: active` is untouched regardless of age; `staleDraftArchiveEnabled: false` disables the whole handler as a no-op; the `lifecycle:archive-stale-drafts` log line fires only when `archived > 0`.
- `link-concepts.ts`/`compile-entities.ts`/`agent-ingest.ts` (Component 1/7 promotion): a fixture source at `status: draft` reaching `ingest_status: linked` ends at `status: active`; one already `archived` also ends at `active` (recovery, G7); one at `status: rejected` stays `rejected` (never overridden) — this is the crux regression test proving the guard condition is exactly right. Existing tests for these three handlers' unrelated behavior (link resolution, entity compilation, agent linking) pass unmodified.
- `topic-refresh.ts`/`re-enrich-note.ts` (Component 8): a fixture note at `status: archived` that receives a successful non-no-op rewrite ends at `status: active` with `archived_at`/`archived_reason` cleared; `re-enrich-note`'s existing <50-char no-op path leaves `status: archived` untouched (regression, proves the no-op gate still short-circuits before the new un-archive check).
- `review-queue.ts`: `approveReviewItem` on a fixture `status: draft` review note ends at `status: active` alongside the existing `review_state: approved` assertion; `rejectReviewItem` ends at `status: rejected` alongside existing `review_state: rejected`/`resolution_state: dismissed` assertions. Regression: existing approve/reject tests' other field assertions (the `analysis` protected-region append, `updated_at` bump) pass unmodified.
- CLI (`karpathy archivist`): scripted-stdin test (matching whatever pattern `curatorCommand`'s own tests use, if any exist, or a fresh integration test under `test/bin/`) exercising all five keystrokes (`a`/`k`/`S`/`s`/`q`) against a fixture archive-queue with one pending entry each; asserts the right frontmatter mutation + queue resolution per keystroke; `q` leaves remaining entries `pending`.
- MCP (`resolve_archive_candidate`): added to `test/mcp/tools.test.ts` per CLAUDE.md's documented convention — no-args call returns pending entries (capped at 10); `{id, decision: 'archive'}` mutates the target note and resolves the entry; `{id, decision: 'supersede'}` without `supersededByPath` errors; `{id, decision: 'supersede', supersededByPath: <nonexistent>}` errors (path-existence guard, mirroring `reconcile_entities`'s existing merge/rename guard); unknown `id` errors on both entries points.
- `config/schema.ts`: `LifecycleConfigSchema` defaults (`enabled: true`, `staleDraftReportDays: 14`, `staleDraftArchiveEnabled: true`, `staleDraftArchiveDays: 30`, `archiveQueueEnabled: true`); the load-time warning fires when `staleDraftArchiveDays < staleDraftReportDays` and does not throw.

## 18. Explicitly deferred

- **Fixing why 93.7% of `source_summary` notes never advance past `ingest_status: 'detected'`, and re-enabling the orphaned `finalize-session` job.** Both are job-queue/scheduler throughput questions, not lifecycle-semantics questions — see §0.2/§0.3 and the urgent operator follow-up in §16. This is the single most consequential thing this investigation surfaced and is deliberately not fixed here.
- **A `superseded_by` consumer** (a banner in `get_note`, exclusion from default `search` ranking, etc.) — this spec gives the field its first writer (§9); designing a reader is follow-up work once real data exists to design against (§11).
- **Bidirectional `project_status` ↔ base `status` sync for manual (non-queue) edits** — §11's noted asymmetry; only the queue-driven `archive` decision keeps both fields in lockstep today.
- **Un-archival consumer wiring beyond topic-refresh/re-enrich-note/ingest-promotion** (e.g. should `search` results exclude `archived` notes by default, or surface them behind a flag?) — out of scope; this spec only defines the `status` value transitions, not how every read-side tool should treat `archived` notes. Worth a small follow-up once real archived-note volume exists to evaluate against.
- **A `karpathy archivist --auto` power-user flag** analogous to `karpathy merge --auto`'s existing explicit-opt-in bypass of the reconciliation queue — not requested by the audit, and auto-archiving wiki content without review is an explicit non-goal (§1); could be revisited if Tom later decides the review step is unnecessary friction for high-confidence rot candidates.
- **`session_summary` archival** — not scoped (§1); revisit if the vault's 5,809-and-growing session-summary count ever becomes a demonstrated problem the way `source_summary` was.

## 19. Open questions for Tom

- **`staleDraftArchiveDays: 30` (default) will archive the large majority of the 11,499 currently-draft source summaries on its very first scheduled run**, per §15's first edge case. This is the correct, intended behavior for closing the gap this spec describes — but it's a big, one-time, vault-wide change the moment it ships and the daily job first fires. Recommend reviewing the count via the new "Stale draft sources" vault-health table (which will show the same backlog with zero side effects) for at least one cycle before enabling `staleDraftArchiveEnabled` in the live config, if a gentler rollout is preferred. Not a design fork — the mechanism is the same either way, just a rollout-sequencing preference; noted here rather than decided unilaterally since it affects Tom's live vault content immediately upon deploy.

Everything else in this design was resolved directly from the specification, the existing code's established conventions (Sub-project A's queue pattern, B2b/B2c's report-table pattern), and the concrete vault evidence in §0 — no other product/scope call required a stop.

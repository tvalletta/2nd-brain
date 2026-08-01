# Design: Research Queue Redesign (Sub-project D)

**Status:** Approved for plan write-up (design conversation complete 2026-07-31, run in minimal-interaction mode per operator instruction; §14's `autoDrainEnabled` question defaulted to the safe/conservative choice — off — rather than deciding whether Tom should turn it on, mirroring how Sub-project C resolved its own mass-mutation rollout question. See §14.)

**Sub-project:** D. Standalone — not part of the three-way "Content Richness" split (B2a/B2b/B2c) or Sub-project C, though it reuses code-review lessons and one direct precedent from both (B2c's `fix(mcp,bin): thread layout through mergeEntities/rebuildAllIndexes call sites`; C's queue-file pattern and its "ship built, default risky flag off" resolution shape). No dependency on any of their code paths.

## 0. Context

Sub-project D had no prior brief beyond the one-line audit label "research queue redesign" — but unlike B2b/B2c/C, CLAUDE.md already documents the mechanism this sub-project touches in real detail (the "Research handshake": `research-propose.ts` gap detection, a Slack/queue-edit/MCP-tool three-way approval surface, and a tiered `research-execute.ts` executor). Per the operating instructions, this doc still starts from the same place every prior sub-project did: read `specs/specification.md`, read the real code, then read the real production vault for concrete, dated evidence before designing anything.

`specs/specification.md` §21a describes the mechanism normatively: *"Human-in-the-loop research handshake: gap detection writes a stack-ranked queue at `wiki/_system/research-queue.md`; the user picks depth (light / medium / heavy / skip) via Slack reply, queue edit, or the MCP `approve_research` tool; only then does `research-execute` fire."* §21a also states plainly: *"The research handshake explicitly forbids autonomous web research without user approval."* Both properties are honored by the code as written — human approval genuinely gates every research round; nothing here proposes weakening that. The problem this sub-project uncovers is not that the human-in-the-loop gate is too weak — it's that **two of the three approval surfaces the spec and CLAUDE.md promise are silently non-functional in the real, configured production vault**, that the third (manual file edit) has no downstream consumer, and that the candidate pool feeding the queue has drifted out of sync with a sibling sub-project's own redesign.

### 0.1 Concrete evidence — vault content

Config (`~/.karpathy/config.json`): `vaultPath = /Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes`, production `Curated/` layout (`layout.system = "Curated/_system"`), `notifications.slack.enabled: false`, `intelligence.research = { enabled: true, queueCap: 50, autoExpireDays: 14, search: { provider: "mcp", mcp: { command: "npx", args: ["-y", "@mzxrai/mcp-webresearch@latest"], toolName: "search_google" } } }`. Today's date in-session is 2026-07-31 (log timestamps run through 2026-08-01 early morning, i.e. "now").

**`Curated/_system/research-queue.md` holds 30 candidates. Every single one is `status: pending`, and every single one has an empty `Decision` column.** Verbatim excerpt:

```
| `executive-summary` | 0.55 | 1 mention in last 14d; in active project | medium |  | pending | 2026-05-18T15:42:18.521Z |  |
| `claude-code-session` | 0.50 | 1 mention in last 14d; in active project | medium |  | pending | 2026-05-18T15:42:18.521Z |  |
| `architectural-best-practices` | 0.35 | 16 mentions in last 14d | light |  | pending | 2026-05-18T15:42:18.521Z |  |
...
| `multi-provider-fallback` | 0.31 | 8 mentions in last 14d | light |  | pending | 2026-06-26T20:06:59.742Z |  |
```

The oldest entries were added **2026-05-18** — 74 days before today's session — and have sat completely unactioned since. `Curated/hotcache.md`'s live `%% begin:research-pending %%` block (visible to every session at session-start) confirms the same picture in miniature: *"5 candidates awaiting your call. Approve via `approve_research` MCP tool, `karpathy intel approve`, or by editing `Curated/_system/research-queue.md`."* — the top 5 of the 30, unchanged.

**`Curated/log.md` proves `research-propose` has run reliably, roughly daily, for the entire 2.5-month period** — this is not a stalled or broken producer:

```
2026-08-01T03:26:04.610Z research:propose — 24 scanned → 30 in queue (30 pending)
2026-06-14T20:31:58.555Z research:propose — 60 scanned → 18 in queue (18 pending)
2026-06-01T17:53:23.830Z research:propose — 60 scanned → 44 in queue (44 pending)
2026-05-18T15:42:18.521Z research:propose — 59 scanned → 43 in queue (43 pending)
2026-05-14T21:50:27.296Z research:propose — 0 scanned → 0 in queue (0 pending)
```

**But `research:execute` appears in `log.md` exactly zero times, ever**, across the entire log (grep for `research:execute` and for every `**...**` job-kind marker in the file returns only `digest:weekly`, `research:propose`, and `topic:refresh` — never `research:execute`). In 2.5 months of continuous daily proposal, **not one of the 30-and-growing candidates has ever actually been researched.** That is the central fact this sub-project investigates.

### 0.2 Concrete evidence — code (the mechanism, precisely)

**Finding 1 (headline) — the layout-path bug: two of the three documented approval surfaces silently operate on a path that doesn't exist in production, and always report/act on an empty queue.**

`src/maintenance/research-queue.ts` correctly supports layout-awareness — `readResearchQueue(vault, layout = DEFAULT_LAYOUT)` / `writeResearchQueue(vault, queue, layout = DEFAULT_LAYOUT)` both take an optional `layout` parameter, and `DEFAULT_LAYOUT.system = 'wiki/_system'` (`src/vault/paths.ts:107`) — a **legacy** path, completely different from the real vault's configured `layout.system = 'Curated/_system'`. The producer side gets this right: `src/intelligence/research-propose.ts:79-80` calls `layoutFromConfig(deps.config)` and threads it through every `readResearchQueue`/`writeResearchQueue` call — this is why the real queue file lives at, and is correctly maintained at, `Curated/_system/research-queue.md`.

But four consumer call sites never pass a `layout` argument at all, so they silently default to `wiki/_system/research-queue.md` — a file that has never existed anywhere in the real vault:

- **`src/mcp/tools/approve-research.ts:36,45`** — the MCP tool CLAUDE.md and the spec both name as *the* in-session approval path:
  ```typescript
  const queue = await readResearchQueue(ctx.vault);      // ← no layout arg
  const candidate = queue.candidates.find((c) => c.slug === input.slug);
  if (!candidate) {
    return { content: [{ type: 'text' as const, text: `Slug not in queue: ${input.slug}` }], isError: true };
  }
  candidate.decision = input.depth;
  await writeResearchQueue(ctx.vault, queue);             // ← no layout arg
  ```
  Because `readResearchQueue(ctx.vault)` reads `wiki/_system/research-queue.md` (nonexistent in the real vault → `vault.exists()` returns false → `{ candidates: [] }`), **`queue.candidates.find(...)` is always `undefined`, so this tool returns `"Slug not in queue"` for every real slug, unconditionally, every single time it has ever been called against the real vault.** Even in the hypothetical case where a match were somehow found, the `writeResearchQueue` call would create/overwrite a second, divergent queue file at the wrong path — never touching the real one.

- **`src/bin/intel-command.ts:218` (`karpathy intel queue`)**, **`:325,331` (`karpathy intel approve "<reply>"`)**, **`:383` (`karpathy intel status`)** — all four call `readResearchQueue(vault)` / `writeResearchQueue(vault, queue)` with **no layout argument**, identical bug, identical root cause. `karpathy intel queue` against the real vault always prints `"Research queue is empty."`; `karpathy intel approve "1 heavy, 2 medium"` always prints `"Queue is empty — nothing to approve. Run karpathy intel propose first."`; `karpathy intel status` always reports the research-queue section as `0 pending, 0 decided, 0 completed` — even though 30 real, live candidates sit one folder-name away.

- **`src/intelligence/health-check.ts:451`** (`checkResearchQueue`, backing `karpathy intel health [--json]`) — same bug: `readResearchQueue(vault)`, no layout. The CLI's own help text (`src/bin/intel-command.ts:58-59`) documents this JSON output as *"the canonical input for external control centers"* — meaning any external tooling polling `karpathy intel health --json` for research-queue depth is silently fed `{ pending: 0, approved: 0, completed: 0 }` today, permanently, regardless of the real queue's true state.

Contrast with the codebase's own established, correct pattern for exactly this situation — `src/mcp/tools/reconcile-entities.ts:57` (`const layout = layoutFromConfig(ctx.config);`) and Sub-project C's `src/mcp/tools/resolve-archive-candidate.ts:55` (identical line) — both thread `ctx.config`'s layout through every queue call. **This is not a new failure mode for this codebase**: `git log` shows B2c already fixed one instance of precisely this bug class (`fix(mcp,bin): thread layout through mergeEntities/rebuildAllIndexes call sites`). The research-queue module is a second, independent occurrence that nobody has caught since — because, per Finding 6 below, no test exercises these call sites against a non-default layout.

Of the three documented approval surfaces, this leaves exactly **one that actually works**: hand-editing `Curated/_system/research-queue.md`'s `Decision` column directly in Obsidian, which operates on the real file because Obsidian just edits bytes on disk — no karpathy code path is involved at all for that write. But:

**Finding 2 — even the one working approval surface has no downstream consumer.** `src/intelligence/scheduler.ts`'s `defaultSchedule()` (the daily/weekly cron table `karpathy intel tick` drains) schedules `research-propose` (daily) but **never schedules `research-execute`** at all — it isn't in the schedule array under any condition. The only way `research-execute` ever runs is the fully manual, one-slug-at-a-time `karpathy intel research <slug> <depth>` CLI subcommand (`intel-command.ts:195-214`) — which requires already knowing the exact slug and depth, typed by hand, once per candidate, with no batching and no "run everything that's been decided" mode. §0.1's log evidence (zero `research:execute` entries, ever) confirms this manual path has never once been exercised against the real vault either — unsurprising, since the two surfaces that would make setting a decision easy (MCP tool, CLI approve) have never worked, and the one that does work (direct file edit) still dead-ends at "now go run a separate CLI command by hand."

**Finding 3 — roughly two-thirds of the current queue are structurally orphaned by Sub-project B1's own concept-glossary consolidation, and approving one would silently resurrect deprecated architecture.** `research-propose.ts:28-30`'s `scanFolders()` still scans `${layout.wiki}/concepts` for individual `type: 'concept'` pages. But B1 (commit `7de5da9 feat(concepts): consolidate concept extraction into a single glossary file`, 2026-07-24) eliminated individual concept pages entirely — confirmed directly against the real vault: `Curated/wiki/concepts/` contains exactly two files, `_index.md` and `glossary.md` (both `type: index`), **zero** files of `type: concept`. This means:

  - The concept-folder half of `research-propose`'s gap detection is now **permanently dead** — it will never again find a single new concept-type candidate, silently, with no error.
  - Every **existing** queue row that originated from that now-defunct scan (added before 2026-07-24, still carried forward every cycle by the `for (const prior of existing.candidates) { if (candidates.find(...)) continue; ... }` fallback in `research-propose.ts:162-179`, since that carry-forward loop only checks score/age, never "does this still correspond to a real page") is now an orphan. Real, cross-referenced proof: the real `glossary.md` (regenerated 2026-07-24) contains sections for **`## OAuth`**, **`## efficiency`**, **`## maintainability`**, **`## modularity`**, **`## RCAs`**, **`## AI Observability Automation`** — and the real `research-queue.md`, *right now*, independently carries pending rows for `oauth` (added 2026-05-18), `efficiency`, `modularity`, `maintainability`, `rcas`, and `ai-observability-automation` (several added 2026-06-26) — all six pointing at a `${layout.wiki}/concepts/{slug}.md` target that has not existed since the B1 migration.
  - If any of these six (or the ~13 similarly-orphaned others — `spec-driven-context`, `project-hub`, `sprint-review`, `pending-enrichment`, `ingest-pipeline`, `claude-enterprise-account`, `llm-gateway`, `strategic-levers`, `architect-calibration`, `provider-selection-priority-hierarchy`, `trial-outcomes`, `multi-provider-fallback`, `executive-summary`) were ever approved and executed, `research-execute.ts`'s `writeConceptNote()` (`src/intelligence/research-execute.ts:275-297`) checks `await deps.vault.exists(args.notePath)` — finds `false` — and **silently creates a brand-new individual page** at `Curated/wiki/concepts/{slug}.md`, exactly reinstating the pre-B1 individual-concept-page pattern B1 was built to eliminate, alongside (and totally disconnected from) that same concept's real, consolidated entry in `glossary.md`. A split-brain representation of the identical concept, created by one sub-project's mechanism silently undoing another's, with no error or warning anywhere.

**Finding 4 — `research-execute` makes unbudgeted, non-tier-aware LLM calls, inconsistent with every sibling mechanism in the intelligence layer.** `src/jobs/handlers/research-execute.ts` calls `executeResearch({ vault: ctx.vault, llm: ctx.llm, config: ctx.config }, ...)` directly — no `BudgetTracker` reservation anywhere in the file, unlike `src/jobs/handlers/topic-refresh.ts:26-30` (`const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot); if (!budget.tryReserve('medium')) { ... return; }`). `executeResearch` also always uses the single, non-tier-specific `deps.llm` client for every round regardless of depth — `light`/`medium`/`heavy` differ only in round/framing count (`DEPTH_PROFILES`, `research-execute.ts:41-45`), never in which model answers. The sibling B2a work in this same repository just established the correct pattern for exactly this need: `src/review/generate-review-analysis.ts:64,76` constructs `createLLMFromConfig(config, stateDir, 'fast')` / `createLLMFromConfig(config, stateDir, 'medium')` on demand per confidence tier. `research-execute` predates that pattern and was never retrofitted to use it.

**Finding 5 — a small, real formula bug in the gap-score's confidence signal.** `research-propose.ts:112`:
```typescript
const confidenceGap = confidence === 'low' ? 1 : confidence === 'medium' ? 0.5 : confidence === 'high' ? 0 : 0.7;
```
A note whose `confidence` field is simply **unset** (the common case for many `topic` notes, `confidence === ''`) falls through to the final `: 0.7` branch — scoring **higher** research-urgency (0.7) than a note explicitly, deliberately marked `confidence: medium` (0.5). That's backwards: "nobody has judged this note's confidence yet" should not be treated as more urgent than "a human explicitly decided this is medium-confidence." This is a real, evidenced formula bug, not a design-taste question — it consistently over-weights every note that has simply never had its `confidence` field touched, which (per B1/B2 investigation precedent) is most of them.

**Finding 6 — the test suite's own blind spot is the direct enabler of Finding 1.** `test/intelligence/research.test.ts:39` constructs every fixture via `KarpathyConfigSchema.parse({ vaultPath: '/tmp' })` — the **default** layout, every time; `test/intelligence/hot-cache-injector.test.ts:103` only asserts the string `'approve_research'` appears somewhere in injected text, never exercises the tool itself; there is no `test/mcp/tools.test.ts` coverage of `approve-research` at all (confirmed by grep — zero hits), and no `test/intelligence/health-check.test.ts` coverage of `checkResearchQueue` against a non-default layout. Every fixture in the whole research-queue test surface uses `DEFAULT_LAYOUT` by construction, which is exactly why Finding 1's bug (which only manifests under a **non-default** layout — i.e., every real Curated/-style production vault) has shipped invisibly. This mirrors the user's own previously-captured lesson (`~/.claude/projects/.../memory/feedback_layout_aware_paths.md`): *"Always use `layoutFromConfig(config)`/`kindToFolder()`; hardcoded `'wiki/'` breaks Curated/wiki/ production layout."*

### 0.3 What's not broken / scope validation

- **`research-propose.ts`'s gap-detection producer side is correctly layout-aware and has run reliably for 2.5 months** (§0.1's `log.md` evidence) — this spec does not touch its layout plumbing, only two specific things inside it (Finding 3's dead concept-scan / orphan carry-forward, Finding 5's confidence-gap default).
- **The auto-expire mechanism does work for genuinely low-scoring candidates.** The real queue shrank from 44 pending (2026-06-01) to 18 pending (2026-06-07) — consistent with a batch of sub-0.3-score May candidates crossing the 14-day age threshold together. The mechanism is not dead; it simply has no effect on candidates whose score sits at or above `autoExpireBelowScore` (0.3 default) indefinitely — which is a *different*, narrower issue (frequently-mentioned generic vocabulary never drops below that floor) that this spec deliberately does not chase into a full re-scoring redesign (see §1 non-goals).
- **`hot-cache-injector.ts:142`'s read of the queue is correctly layout-aware** (`readResearchQueue(vault, layout)`, layout threaded from its caller) — this is why the hot-cache block Tom sees at every session start correctly shows the real 5 top candidates and the real, correct path (`Curated/_system/research-queue.md`) in its help text. Only the *write*/consumer side (approval) is broken, not the read-only surfacing.
- **The `karpathy intel research <slug> <depth>` CLI subcommand itself is correctly implemented** (`intel-command.ts:195-214`) — it enqueues a properly-typed `research-execute` job and drains it synchronously. It has just never been invoked against the real vault, because nothing has ever told the user which slug+depth to type (the broken surfaces never successfully record a decision) and there is no batch/auto mode.
- **The human-in-the-loop approval gate itself is sound and is not weakened by anything in this spec.** Every fix below either repairs a broken *read/write path* to the existing gate, or adds an *optional, off-by-default* auto-drain that still requires a prior explicit human decision recorded in the queue — never autonomous research initiation, matching spec §21a's explicit prohibition.
- **`significance-gate.ts` (D4) is unrelated to this investigation** — confirmed by inspection: it gates entity/concept *creation* time (heuristic/LLM keep-merge-drop verdicts on newly extracted entities), and is not called anywhere in `research-propose.ts`/`research-execute.ts`. The audit brief's hypothesis that it "likely feeds research candidates" does not hold up — research candidates are scored purely from existing `type: concept`/`type: topic` wiki pages and embedding-store mention frequency, with no significance-gate involvement. Noted and set aside, not chased further.

## 1. Goals / Non-goals

**Goals:**

- **G0 — Fix the layout-path bug at all four broken call sites** (`approve-research.ts`, `intel-command.ts` ×3, `health-check.ts`) so every research-queue read/write operates on the real, configured `VaultLayout` instead of silently defaulting to the legacy `wiki/_system/` path. Restores documented behavior; ships unconditionally, no config gate (a correctness fix, not a new mutation — matches how Sub-project C's `review-queue.ts` approve/reject fix shipped unconditionally once the underlying no-op bug was found).
- **G1 — Auto-drain**: once a queue candidate has a `decision` set (by any of the three approval surfaces, all now working per G0) and is still `status: pending`, automatically enqueue a `research-execute` job for it — closing Finding 2's gap without requiring a separate manual `karpathy intel research <slug> <depth>` invocation per candidate. Folded into the existing daily `research-propose` job (which already reads and rewrites the queue file every cycle) rather than a new scheduled job type. **Ships fully built, gated off by default** (`intelligence.research.autoDrainEnabled: false`) — see §14.
- **G2 — Budget-gate and tier-select `research-execute`'s LLM calls.** Reserve one call from the existing `BudgetTracker` (tier mapped from research depth: `light→fast`, `medium→medium`, `heavy→heavy`) before invoking `executeResearch`, matching `topic-refresh.ts`'s established pattern; and construct a depth-appropriate LLM client via `createLLMFromConfig(config, stateDir, tier)` per round instead of always using the single default-tier client, matching the pattern B2a's `generate-review-analysis.ts` just established in this same codebase. Ships enabled unconditionally — strictly protective (budget) and strictly cost/quality-improving (tier selection); necessary companion to G1, since auto-drain is what could first cause several `research-execute` jobs to fire in one day without a human individually typing each one.
- **G3 — Purge B1-orphaned candidates and guard against resurrecting deprecated architecture.** Remove `${layout.wiki}/concepts` from `research-propose.ts`'s per-note candidate scan (dead since the B1 migration — confirmed zero `type: concept` files remain there); validate every carried-forward (not-freshly-redetected) candidate against whether its backing page still exists at `${layout.wiki}/concepts/{slug}.md` or `${layout.wiki}/topics/{slug}.md` each cycle, dropping it immediately (regardless of score/age) if not; and add a defense-in-depth guard in `research-execute.ts`'s `writeConceptNote()` that refuses to create a new page inside a glossary-consolidated concepts folder. Ships enabled unconditionally — queue-row hygiene only, touches zero wiki content, fully regenerable from real evidence if a purge is ever wrong.
- **G4 — Fix the `confidenceGap` unset-value default** (0.7 → 0.5, aligning with the "medium" bucket) so an unjudged note doesn't outrank an explicitly medium-confidence one. Ships unconditionally — a one-line, low-blast-radius formula correction.
- **G5 — Observability**: log lines (matching the existing `kind:` convention in `log.md`) for (a) candidates dropped by the `queueCap` slice, (b) candidates dropped by G3's orphan-purge, and (c) G1's drain enqueuing or budget-skipping a `research-execute` job — closing the silent-shrinkage/silent-drain gap the same way Sub-project C added `lifecycle:archive-stale-drafts` logging.
- **G6 — Close the test blind spot that let G0 ship unnoticed.** Add fixture coverage for `approve_research`, `karpathy intel queue/approve/status`, and `checkResearchQueue` against a **non-default** (Curated-style) `VaultLayout`, so this bug class cannot silently recur a third time in this module.

**Non-goals:**

- **Redesigning the six-signal `gap_score` formula's weights or signals.** Finding 5 is a narrow, evidenced default-value bug (G4); the broader pattern that high-frequency common vocabulary (`oauth` 102 mentions, `feedback` 272 mentions, `prioritization` 120 mentions) saturates `frequencyScore` and can crowd out genuinely gap-y topics is real but is a *definitional* question ("what should 'needs research' mean?") that deserves its own follow-up rather than a silent scope-expansion bundled into a queue-hygiene sub-project. Flagged in §12.
- **Giving `research-execute` a "glossary section" target type.** Concepts already have their own LLM-synthesis enrichment path (`concept-glossary.ts`'s `glossarySynthesisThreshold`-gated rollup line) — a different mechanism, already shipped, already the right tool for enriching glossary entries. Layering the tiered websearch-research flow on top of glossary sections would require inventing a new "target" representation `research-execute` doesn't have today; out of scope. G3 instead scopes individual-page research back down to what still legitimately has individual pages (`topics/`).
- **Building or validating the `mcp`/`duckduckgo` websearch backends end-to-end against real network access and credentials.** `intelligence.research.search.provider: 'mcp'` (pointing at `npx -y @mzxrai/mcp-webresearch@latest`) has never been exercised even once against real traffic (§0.1's zero `research:execute` log lines). This spec fixes the handshake/plumbing that gets a request *to* `executeResearch`; it does not verify the search backend itself works. Flagged as an operator follow-up in §12.
- **Enabling `notifications.slack.enabled`.** Remains `false` in the real config; not this spec's call to make (would additionally require provisioning a real webhook URL/secret — squarely the `control-center`-skill "retrieving/hardcoding a secret" territory the user's own global config flags).
- **Turning on `autoDrainEnabled`.** Tom's call — see §14, resolved the same way Sub-project C resolved `staleDraftArchiveEnabled`.
- **Retuning `queueCap` / `autoExpireDays` / `autoExpireBelowScore` numeric defaults.** No evidence beyond G4's specific formula bug that these particular numbers are miscalibrated; revisit once G0-G6 ship and real approvals start flowing through a previously-nonfunctional pipeline.
- **Changing `DEPTH_PROFILES` (rounds/framings/topSources per depth).** Never been run against real data even once; no basis to tune against yet.
- **Weakening the human-in-the-loop gate itself.** No change here ever causes `research-execute` to fire without a prior, explicit `decision` value recorded by a human through one of the three approval surfaces. Matches spec §21a's explicit prohibition on autonomous research.

## 2. Architecture overview

```
src/mcp/tools/approve-research.ts (MODIFIED)
  Threads layoutFromConfig(ctx.config) through readResearchQueue/writeResearchQueue,
  matching reconcile-entities.ts's established pattern exactly (G0).

src/bin/intel-command.ts (MODIFIED)
  Four call sites (`queue`, `approve` ×2, `status`) gain `config.layout` as the
  layout argument to readResearchQueue/writeResearchQueue (G0).

src/intelligence/health-check.ts (MODIFIED)
  checkResearchQueue(config) threads layoutFromConfig(config) through
  readResearchQueue (G0).

src/intelligence/research-propose.ts (MODIFIED)
  - scanFolders() drops `${layout.wiki}/concepts` (dead post-B1) (G3).
  - Carry-forward loop validates each existing candidate's backing file still
    exists before re-adding it; drops orphans immediately + logs (G3, G5).
  - confidenceGap's unset-value branch: 0.7 → 0.5 (G4).
  - New optional `enqueue` dep; after writeResearchQueue, drains
    decision-set + still-pending candidates into `research-execute` jobs,
    gated on `config.intelligence.research.autoDrainEnabled` (G1).
  - Logs queueCap-slice drops (G5).

src/jobs/handlers/research-propose.ts (MODIFIED)
  Passes `enqueue: ctx.enqueue` into proposeResearch (G1).

src/jobs/handlers/research-execute.ts (MODIFIED)
  Reserves a BudgetTracker slot (tier mapped from depth) before calling
  executeResearch; constructs a tier-specific LLM client via
  createLLMFromConfig(config, stateDir, tier) instead of ctx.llm; on budget
  refusal, logs and returns without marking the candidate complete (G2, G5).

src/intelligence/research-execute.ts (MODIFIED)
  writeConceptNote() refuses to create a new page when the target folder is
  glossary-consolidated (only _index.md/glossary.md present, no existing
  individual page) — defense in depth for G3.

src/config/schema.ts (MODIFIED)
  intelligence.research gains `autoDrainEnabled: boolean` (default false).

test/mcp/tools.test.ts, test/bin/intel-command.test.ts (new or extended),
test/intelligence/health-check.test.ts (MODIFIED/NEW)
  Non-default-layout fixture coverage for approve_research, karpathy intel
  queue/approve/status, checkResearchQueue (G6).

test/intelligence/research.test.ts (MODIFIED)
  New cases for G1 (drain), G2 (budget/tier), G3 (orphan purge + write guard),
  G4 (confidenceGap), G5 (log lines).
```

No new queue file, no new frontmatter fields, no new note type. This spec deliberately does not introduce a fourth queue-file pattern (reconciliation-queue / archive-queue / research-queue already exist) — it repairs and completes the existing research-queue's plumbing in place.

## 3. Component 0 — Layout-path fix (G0)

**File:** `src/mcp/tools/approve-research.ts`

```typescript
import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readResearchQueue,
  writeResearchQueue,
} from '../../maintenance/research-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';   // NEW

// ...

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const layout = layoutFromConfig(ctx.config);              // NEW
  const queue = await readResearchQueue(ctx.vault, layout);  // FIXED
  const candidate = queue.candidates.find((c) => c.slug === input.slug);
  if (!candidate) {
    return {
      content: [{ type: 'text' as const, text: `Slug not in queue: ${input.slug}` }],
      isError: true,
    };
  }
  candidate.decision = input.depth;
  await writeResearchQueue(ctx.vault, queue, layout);        // FIXED
  // ...unchanged below...
}
```

Identical shape to `reconcile-entities.ts:57` and `resolve-archive-candidate.ts:55` — this is a one-line-per-call-site fix, not a redesign.

**File:** `src/bin/intel-command.ts` — four call sites, each already has `config` in scope:

```typescript
// case 'queue':
const queue = await readResearchQueue(vault, config.layout);   // FIXED (was: readResearchQueue(vault))

// case 'approve':
const queue = await readResearchQueue(vault, config.layout);   // FIXED
// ...
await writeResearchQueue(vault, queue, config.layout);         // FIXED

// case 'status':
const queue = await readResearchQueue(vault, config.layout);   // FIXED
```

(`config.layout` is used directly rather than importing `layoutFromConfig` — this file already uses `config.layout` directly at line 237-238 for `rebuildVaultIndex`; matching that established local convention rather than introducing a second style in the same file.)

**File:** `src/intelligence/health-check.ts`

```typescript
import { layoutFromConfig } from '../vault/paths.js';   // NEW

async function checkResearchQueue(
  config: KarpathyConfig | null,
): Promise<{ check: CheckResult; counts: { pending: number; approved: number; completed: number } }> {
  if (!config || !existsSync(config.vaultPath)) {
    return {
      check: { id: 'research-queue', level: 'info', message: 'vault not reachable' },
      counts: { pending: 0, approved: 0, completed: 0 },
    };
  }
  const vault = createFsAdapter(config.vaultPath);
  const queue = await readResearchQueue(vault, layoutFromConfig(config));  // FIXED
  // ...unchanged below...
}
```

This one fix alone restores all three documented approval surfaces to actual working order in the real, `Curated/`-layout production vault, and makes `karpathy intel health --json`'s research-queue counters (documented as "canonical input for external control centers") accurate for the first time.

## 4. Component 1 — Auto-drain (G1)

**File:** `src/intelligence/research-propose.ts`

`ProposeDeps` gains an optional `enqueue` function (mirroring `decay-scan.ts`'s existing `enqueue` dependency, threaded from `JobContext.enqueue`):

```typescript
export interface ProposeDeps {
  vault: VaultAdapter;
  config: KarpathyConfig;
  store: EmbeddingStore;
  /** Optional — when provided and `intelligence.research.autoDrainEnabled` is
   *  true, decided-but-unexecuted candidates are auto-enqueued as
   *  research-execute jobs (G1). Omitted in tests that don't care about drain. */
  enqueue?: (partial: { type: 'research-execute'; payload: Record<string, unknown>; priority?: number; trigger?: string; dedupeKey?: string }) => Promise<unknown>;
}
```

After `writeResearchQueue(deps.vault, { candidates: trimmed }, layout)` and before the existing `appendLogEntry` call:

```typescript
// G1: auto-drain decided-but-unexecuted candidates into research-execute jobs.
let drained = 0;
let budgetSkipped = 0;
if (deps.config.intelligence.research.autoDrainEnabled && deps.enqueue) {
  for (const c of trimmed) {
    if (c.status !== 'pending' || !c.decision || c.decision === 'skip') continue;
    try {
      await deps.enqueue({
        type: 'research-execute',
        payload: { slug: c.slug, depth: c.decision },
        priority: 80,
        trigger: 'research-drain',
        dedupeKey: `research-execute:${c.slug}`,
      });
      drained++;
    } catch (err) {
      log.warn('research-drain: enqueue failed', { slug: c.slug, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
```

(`budgetSkipped` is surfaced by the job handler's own log line, not here — see Component 2/G5; `research-propose` only knows it *enqueued* a job, not whether the budget later allowed it to run.)

**Idempotency:** `dedupeKey: research-execute:${slug}` reuses exactly the same dedup key `karpathy intel research <slug> <depth>` already uses (`intel-command.ts:209`) — the job queue's existing dedup machinery (spec §8.3) guarantees a second daily `research-propose` run re-detecting the same still-pending, still-decided candidate does not stack a duplicate `research-execute` job while one is already queued or running. Once `research-execute` completes, `upsertCandidate` flips `status` to `'completed'` (`research-execute.ts:172-190`), so the drain condition (`status !== 'pending'`) naturally stops re-enqueueing it on the next cycle — no separate "already drained" bookkeeping needed.

**Self-healing on budget refusal:** if Component 2's budget gate refuses the reservation, the job handler returns without calling `executeResearch` and without touching the queue row — so `status` stays `'pending'` with `decision` still set. The next day's `research-propose` drain pass will simply re-enqueue it. This mirrors `topic-refresh`'s existing budget-refusal behavior (spec: *"the job exits without modifying the note; the pending queue is preserved"*) — no new retry logic required, just the existing daily cadence acting as the retry.

**File:** `src/jobs/handlers/research-propose.ts`

```typescript
export const researchProposeHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.research.enabled) return;
    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      const result = await proposeResearch({
        vault: ctx.vault,
        config: ctx.config,
        store,
        enqueue: ctx.enqueue,   // NEW (G1)
      });
      // ...unchanged Slack block below...
    } finally {
      store.close();
    }
  },
};
```

## 5. Component 2 — Budget gate + tier-aware execution (G2)

**File:** `src/jobs/handlers/research-execute.ts`

```typescript
import { z } from 'zod';
import type { JobHandler } from '../types.js';
import { executeResearch } from '../../intelligence/research-execute.js';
import { createWebSearchFromConfig } from '../../intelligence/web-search.js';
import { createBudgetTrackerFromConfig, type BudgetTier } from '../../shared/budget.js';
import { createLLMFromConfig } from '../../enrichment/llm-factory.js';
import { resolveStateDir } from '../../config/defaults.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:research-execute');

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
    const stateDir = resolveStateDir(ctx.config);
    const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot);
    if (!budget.tryReserve(tier)) {
      log.info('research-execute skipped: daily budget exhausted', {
        slug: payload.slug,
        depth: payload.depth,
        tier,
        remaining: budget.remaining(tier),
      });
      return; // queue row stays pending+decided; next drain cycle retries (§4)
    }

    // G2: tier-appropriate model instead of the single default client.
    const llm = createLLMFromConfig(ctx.config, stateDir, tier);

    await executeResearch(
      { vault: ctx.vault, llm, config: ctx.config },
      payload.slug,
      { depth: payload.depth, notePath: payload.notePath, search: createWebSearchFromConfig(ctx.config) },
    );
  },
};
```

`DEPTH_TO_TIER` maps `light → fast` (1 round, cheapest model — appropriate for a single-pass definitional lookup), `medium → medium` (2 rounds, the general-purpose default model), `heavy → heavy` (3 rounds, the most capable configured model — previously `heavy`-depth research was, absurdly, using the *same* model as `light`-depth). This mirrors `generate-review-analysis.ts:64,76`'s `createLLMFromConfig(config, stateDir, tier)` construction pattern exactly.

Budget reservation happens **once per job**, not once per round — `executeResearch`'s internal round loop (1-3 rounds depending on depth) is treated as a single logical "research call" for budget-accounting purposes, consistent with how `topic-refresh` reserves once per note-refresh regardless of how many protected regions it touches in that pass.

## 6. Component 3 — Orphan purge + write guard (G3)

**File:** `src/intelligence/research-propose.ts`

```typescript
function scanFolders(layout: ReturnType<typeof layoutFromConfig>): string[] {
  // NOTE (G3): `${layout.wiki}/concepts` intentionally excluded. Since B1's
  // concept-glossary consolidation (2026-07-24), that folder contains only
  // `_index.md`/`glossary.md` (type: index) — never `type: concept` — so
  // scanning it for research candidates is permanently a no-op. Concepts get
  // their own LLM-synthesis enrichment via concept-glossary.ts's rollup-line
  // mechanism; individual-page tiered research remains valid only for topics.
  return [`${layout.wiki}/topics`];
}
```

Carry-forward validation, replacing the existing unconditional re-add loop:

```typescript
// Auto-expire low-score stale entries from the prior queue, AND (G3) drop
// any entry whose backing page no longer exists — orphaned by a folder
// migration (e.g. B1's concept-glossary consolidation) or manual deletion.
let orphansPurged = 0;
for (const prior of existing.candidates) {
  if (candidates.find((c) => c.slug === prior.slug)) continue; // re-proposed → keep, handled above

  if (prior.status !== 'completed') {
    const stillBacked =
      (await deps.vault.exists(`${layout.wiki}/concepts/${prior.slug}.md`)) ||
      (await deps.vault.exists(`${layout.wiki}/topics/${prior.slug}.md`));
    if (!stillBacked) {
      orphansPurged++;
      continue; // drop — no backing page in either folder
    }
  }

  if (prior.status === 'completed') {
    if (prior.completedAt && nowMs - new Date(prior.completedAt).getTime() > 7 * 86400_000) continue;
    candidates.push(prior);
    continue;
  }
  const ageDays = (nowMs - new Date(prior.addedAt).getTime()) / 86400_000;
  if (ageDays > expireDays && prior.score < expireBelow) continue; // expire
  candidates.push({ ...prior, status: prior.status });
}
```

(Completed candidates are exempted from the backing-file check — a completed research result may legitimately reference a page that's since been archived by Sub-project C's lifecycle mechanism; that's a different, valid lifecycle state, not an orphan.)

Given the real vault's current data, this purges the ~19 pre-B1-migration entries identified in §0.2 Finding 3 (`oauth`, `spec-driven-context`, `efficiency`, `project-hub`, `sprint-review`, `pending-enrichment`, `ingest-pipeline`, `modularity`, `maintainability`, `claude-enterprise-account`, `llm-gateway`, `ai-observability-automation`, `strategic-levers`, `architect-calibration`, `provider-selection-priority-hierarchy`, `rcas`, `trial-outcomes`, `multi-provider-fallback`, `executive-summary`) on the very first `research-propose` run after this ships — a real, visible drop from 30 pending candidates to roughly 11 (the ones genuinely backed by a real `topics/*.md` file: `claude-code-session`, `architectural-best-practices`, `code-audit`, `ai-initiatives`, `po-approval-for-proof-apps`, `provider-selection`, `05-14-weekly-meeting`, `azure-deployment-inquiry`, `weekly-meeting`, `feedback`, `prioritization`). This is the **intended, correct** effect of removing structurally-invalid candidates, not a bug — but it is a real, visible, one-time queue shrinkage worth calling out explicitly (§9 edge cases), the same way Sub-project C called out its own first-run mass-archival effect.

**File:** `src/intelligence/research-execute.ts` — defense in depth in `writeConceptNote()`:

```typescript
async function writeConceptNote(deps: ResearchExecuteDeps, args: WriteArgs): Promise<void> {
  await deps.vault.ensureFolder(args.conceptsFolder);
  const exists = await deps.vault.exists(args.notePath);

  // G3: refuse to (re)create an individual concept page inside a
  // glossary-consolidated folder. If the target doesn't exist AND the
  // concepts folder already has a glossary.md, the concept has been
  // consolidated (B1) — writing a new individual page here would silently
  // fork a duplicate, disconnected representation of the same concept.
  if (!exists && args.conceptsFolder.endsWith('/concepts')) {
    const glossaryPath = `${args.conceptsFolder}/glossary.md`;
    if (await deps.vault.exists(glossaryPath)) {
      throw new Error(
        `Refusing to create ${args.notePath}: ${args.conceptsFolder} is glossary-consolidated ` +
          `(${glossaryPath} exists). This concept should be researched as a topic, or its ` +
          `glossary entry enriched via concept-glossary synthesis, not given a new individual page.`,
      );
    }
  }

  // ...unchanged below...
}
```

This throws rather than silently no-oping, so a job failure is visible in the job queue's own retry/quarantine machinery (spec §8.3) rather than a silent success that did the wrong thing. Combined with the propose-side purge, this candidate class should never reach execution in practice — this guard exists purely as a second, independent line of defense in case a stale decision was recorded before the purge ran, or a future candidate source reintroduces the same shape of bug.

## 7. Component 4 — `confidenceGap` default fix (G4)

**File:** `src/intelligence/research-propose.ts:112`

```typescript
// BEFORE:
const confidenceGap = confidence === 'low' ? 1 : confidence === 'medium' ? 0.5 : confidence === 'high' ? 0 : 0.7;

// AFTER (G4):
const confidenceGap = confidence === 'low' ? 1 : confidence === 'medium' ? 0.5 : confidence === 'high' ? 0 : 0.5;
```

An unset `confidence` field now contributes the same `0.5` as an explicit `medium` mark — neutral, not artificially elevated above a human's own explicit medium judgment. This shifts every candidate lacking an explicit confidence tag down by `0.15 × (0.7 − 0.5) = 0.03` in total score — a small, real correction, not a re-weighting of the formula's signals.

## 8. Component 5 — Observability (G5)

Three new structured log lines, all via the existing `appendLogEntry(vault, { kind, message }, layout)` convention already used by `research:propose`/`research:execute`/`digest:weekly`/`topic:refresh`:

- **`research:queue-capped`** — emitted from `research-propose.ts` when `candidates.length > cap` before the `.slice(0, cap)` truncation, e.g. `"3 candidate(s) dropped by queueCap (50): fizzbuzz-thing, another-slug, third-slug"` (slugs capped to first 10 in the message to keep log lines bounded; full list is reconstructable by re-running propose and diffing). Only fires when something was actually dropped — silent otherwise, matching the existing convention of `research:propose`'s own line only appending once per run regardless.
- **`research:orphans-purged`** — emitted alongside the existing `research:propose` line when `orphansPurged > 0`, e.g. `"6 orphaned candidate(s) purged (no backing page): oauth, efficiency, maintainability, modularity, rcas, ai-observability-automation"`.
- **`research:drain`** — emitted from `research-propose.ts` when `drained > 0` (or when `autoDrainEnabled` is on but nothing was drained, skipped silently — matching the "only log when something happened" convention), e.g. `"2 decided candidate(s) drained to research-execute: architectural-best-practices (light), feedback (medium)"`.
- **Budget-skip visibility** — `research-execute`'s own handler already logs (`log.info('research-execute skipped: daily budget exhausted', ...)`, Component 2) via the existing per-handler logger, not `appendLogEntry` — matching `topic-refresh.ts`'s identical choice to use its structured logger rather than the vault log for budget-skip events (these are operational/debugging signal, not vault history).

## 9. Config schema changes

**File:** `src/config/schema.ts`, inside the existing `research` sub-schema (`IntelligenceConfigSchema.research`):

```typescript
research: z
  .object({
    enabled: z.boolean().default(true),
    queueCap: z.number().int().positive().default(50),
    autoExpireDays: z.number().int().positive().default(14),
    autoExpireBelowScore: z.number().min(0).max(1).default(0.3),
    /** G1: when true, a decided-but-unexecuted candidate is automatically
     *  enqueued as a research-execute job by the next research-propose run,
     *  instead of requiring `karpathy intel research <slug> <depth>` by hand.
     *  Defaults to false: research-execute makes real LLM calls (budget-gated
     *  per G2, but still real cost) and — depending on `search.provider` —
     *  spawns an external websearch MCP subprocess that has never been
     *  exercised against real traffic in this vault (§0.2 Finding 2). Ship
     *  built and one flip away; see §14. */
    autoDrainEnabled: z.boolean().default(false),
    depths: z.object({ /* ...unchanged... */ }).default({}),
    search: z.object({ /* ...unchanged... */ }).default({}),
  })
  .default({}),
```

No other config additions. G0/G3/G4/G5 are unconditional bug fixes; G2 reuses the existing `intelligence.budget` schema (no new fields) and a hardcoded, non-configurable `DEPTH_TO_TIER` map (matching how `DEPTH_PROFILES` itself is already a hardcoded, non-configurable const in `research-execute.ts` — consistent style, no need for a fourth layer of tier-mapping config).

## 10. Data model / frontmatter summary

**No frontmatter or `ResearchCandidate`/`ResearchQueue` shape changes.** This spec is entirely about read/write plumbing correctness (G0), producer-side hygiene (G3/G4), and execution-side safety (G1/G2) — it does not add fields to the queue row shape or to any note's frontmatter. `ResearchCandidate`'s existing `slug` / `score` / `reason` / `suggested` / `decision` / `status` / `addedAt` / `completedAt` / `completedDepth` fields are untouched.

## 11. Decision tables

**Research-queue row lifecycle (unchanged states, now-correct transitions):**

| Event | `status` before | `decision` before | After |
|---|---|---|---|
| New candidate detected | — | — | `pending`, no decision |
| Human sets decision (any of 3 surfaces, all fixed by G0) | `pending` | unset | `pending`, `decision` set |
| `autoDrainEnabled: true`, next `research-propose` run | `pending` | set (≠ skip) | `research-execute` job enqueued (G1) |
| `research-execute` runs, budget available | `pending` | set | `completed`, `completedAt`/`completedDepth` set |
| `research-execute` runs, budget exhausted | `pending` | set | unchanged — row stays pending+decided, retried next drain cycle |
| Candidate not re-detected, backing page still exists, not expired | `pending`/`completed` | any | carried forward unchanged |
| Candidate not re-detected, backing page gone (G3) | `pending` | any | purged (dropped from queue entirely) |
| Candidate not re-detected, age > `autoExpireDays` AND score < `autoExpireBelowScore` | `pending` | any | expired (dropped) |
| Queue exceeds `queueCap` after sort | any | any | lowest-scoring entries dropped (now logged, G5) |

**Approval-surface status, before vs. after this spec:**

| Surface | Before (real production vault) | After (G0) |
|---|---|---|
| `approve_research` MCP tool | Always `"Slug not in queue"` — reads/writes `wiki/_system/` (nonexistent) | Reads/writes `Curated/_system/research-queue.md` correctly |
| `karpathy intel queue` | Always `"Research queue is empty."` | Prints the real 30 (or fewer, post-G3) candidates |
| `karpathy intel approve "<reply>"` | Always `"Queue is empty — nothing to approve."` | Applies decisions to the real queue |
| `karpathy intel status` | Always `0 pending, 0 decided, 0 completed` | Reports real counts |
| `karpathy intel health --json` (`research-queue` check) | Always `{pending:0, approved:0, completed:0}` | Reports real counts |
| Direct file edit (Obsidian) | Works (writes real bytes), but no consumer ever drains it | Works, and — once `autoDrainEnabled: true` — is auto-drained (G1) |

## 12. Edge cases and failure modes

- **First `research-propose` run after this ships purges ~19 of 30 real pending candidates in one pass** (§6) — intended, correct effect of removing structurally-invalid B1-orphaned rows; surfaced via the new `research:orphans-purged` log line (G5), not silent. Unlike Sub-project C's mass-archival concern, this touches only ephemeral, regenerable queue *rows* — no wiki content, no source evidence, nothing that can't be reconstructed from real, current vault state if a purge is ever later judged wrong.
- **A legitimately-still-relevant topic that happens to share a slug with something purged is unaffected** — the purge check is keyed on `${layout.wiki}/topics/{slug}.md` existing, independent of whether a `concepts/{slug}.md` used to exist; a real topic page survives regardless of the concept-side migration.
- **`autoDrainEnabled: true` combined with a user approving many candidates in one editing session** — bounded by G2's daily budget ceiling (`intelligence.budget.llmCallsPerDay`, existing config, defaults `fast: 200, medium: 50, heavy: 10`); excess approvals beyond the day's remaining budget simply retry the next day via the self-healing mechanism in §4, never silently dropped.
- **`research-execute`'s websearch backend (`search.provider: 'mcp'`) has never been exercised against real traffic.** This spec fixes the handshake around triggering execution; it does not validate that `npx -y @mzxrai/mcp-webresearch@latest` actually spawns/authenticates/responds correctly. The first real `research-execute` run (whether via manual CLI or, once enabled, G1's drain) will be the first live test of that integration. Per-query failures are already tolerated (`research-execute.ts:131-139`, wrapped in try/catch, falls back to "use your own knowledge"), so a fully-broken search backend degrades to LLM-only synthesis rather than failing the job outright — but this has not been verified against the real configured command. Flagged as an operator follow-up, not fixed here (§1 non-goals).
- **A candidate purged by G3, then later genuinely re-mentioned enough to re-cross the entry threshold** (`score ≥ 0.2` or `stats.count > 0`, `research-propose.ts:134`) as a real `type: topic` page — re-enters the queue fresh on the next cycle that finds it, exactly as any new candidate would. No special-casing needed; purge is not a permanent ban, just a "not currently backed by anything real" removal.
- **Interaction with Sub-project C's archive-queue/lifecycle mechanism**: a `topic` page that gets `status: archived` via Sub-project C's rot-scan → archive-queue path is not automatically removed from the research queue by this spec — `research-propose.ts`'s existence check (G3) only verifies the *file* exists, not its `status`. A future refinement could exclude `status: archived` topics from re-proposal; not addressed here (would require reading and interpreting `status` inside `research-propose.ts`'s scan loop, a small addition but not evidenced as a real problem today — zero real topic pages are currently archived).
- **Concurrent `research-propose` and `research-execute` runs**: `research-propose` rewrites the whole queue file via `atomicWrite`; `research-execute`'s completion write (`upsertCandidate`) does a read-modify-write of the same file. A race only affects which write lands last (matches the general atomic-write guarantee, spec §8.4) — worst case, a completion's `status: 'completed'` update is briefly overwritten by a same-tick `research-propose` re-detecting the candidate as still-pending from stale in-memory state, self-correcting on the next cycle once the file's actual on-disk `completed` status is re-read. This is an existing property of the queue file's design, not newly introduced by this spec.
- **`TransientLLMError` / retry interaction**: `research-execute`'s LLM call (`synthesize()`) can throw `TransientLLMError` like any other LLM-calling job handler; the existing per-job retry/quarantine machinery (spec §8.3) applies uninspected — no change from this spec.

## 13. Testing plan

- **`research-propose.ts` (G0-side unaffected; G1/G3/G4 new coverage):**
  - `scanFolders` no longer includes `${layout.wiki}/concepts` — a fixture concept-type page under `wiki/concepts/` is never proposed, even if `type: 'concept'` (regression proving the dead scan is truly removed, not just empty by coincidence).
  - Orphan purge: a fixture existing candidate whose slug has no backing file in either `wiki/concepts/` or `wiki/topics/` is dropped on the next `proposeResearch` call, regardless of score/age; one with a real backing `wiki/topics/{slug}.md` file survives; one with `status: 'completed'` survives regardless of backing-file existence.
  - `confidenceGap`: a fixture topic note with no `confidence` field set scores identically to one with `confidence: 'medium'` (both `0.5` contribution) — regression proving the default no longer exceeds the explicit-medium case.
  - Drain (G1): with `autoDrainEnabled: true` and a fixture `enqueue` spy, a candidate with `decision: 'medium'`, `status: 'pending'` triggers exactly one `enqueue` call with `{ type: 'research-execute', payload: { slug, depth: 'medium' }, dedupeKey: 'research-execute:{slug}' }`; a candidate with `decision: 'skip'` or no decision triggers none; with `autoDrainEnabled: false` (or `enqueue` omitted), nothing is ever enqueued regardless of decisions present (regression, proves the default-off gate holds).
  - `queueCap`/orphan/drain log lines (G5): `appendLogEntry` spy or `log.md` read-back asserts `research:queue-capped`/`research:orphans-purged`/`research:drain` only appear when something was actually dropped/drained, never on a no-op cycle.
- **`research-execute.ts` (G3 write-guard):** a fixture vault with `wiki/concepts/glossary.md` present and no `wiki/concepts/{slug}.md` — calling `executeResearch` for that slug throws the new "glossary-consolidated" error rather than creating a page; a fixture vault with no `glossary.md` (default layout, pre-B1-style) — unaffected, existing "creates a new concept page" behavior/tests pass unmodified.
- **`src/jobs/handlers/research-execute.ts` (G2):** a fixture with `intelligence.budget.llmCallsPerDay.medium: 0` — the handler returns without calling `executeResearch` and logs the budget-skip; a fixture with budget available — asserts `createLLMFromConfig` was invoked with the correct tier per depth (`light→fast`, `medium→medium`, `heavy→heavy`) via a spy/mock on the factory.
- **`src/mcp/tools/approve-research.ts` (G0/G6):** existing test coverage (none today — confirmed gap) gains a **non-default-layout** fixture (e.g. `layout: { system: 'Curated/_system', wiki: 'Curated/wiki', ... }`) with a queue file written at the *custom* path; `approve_research({slug, depth})` correctly finds and updates the candidate; a **default-layout** fixture continues to pass unmodified (regression).
- **`src/bin/intel-command.ts` (G0/G6):** new or extended `test/bin/intel-command.test.ts` cases for `queue`/`approve`/`status` subcommands against a non-default-layout fixture config, asserting real candidates are found/reported (not "queue is empty"/all-zero); default-layout cases (if any exist today) pass unmodified.
- **`src/intelligence/health-check.ts` (G0/G6):** `checkResearchQueue` against a non-default-layout fixture reports non-zero counts matching a fixture queue file written at the custom path; default-layout case unaffected.
- **`config/schema.ts`:** `autoDrainEnabled` defaults to `false`; explicit `true` parses correctly.

## 14. Explicitly deferred

- **Redesigning the `gap_score` formula's six signals/weights** to structurally de-emphasize high-frequency common vocabulary (the `oauth`/`feedback`/`prioritization` pattern, §0.2 Finding 5's broader context) — G4 fixes one specific, evidenced default-value bug in the confidence signal; a wholesale re-derivation of what "gap" should mean is separate epistemic work, not queue hygiene.
- **A "glossary section" research target** allowing `research-execute` to enrich a `glossary.md` entry in place rather than only individual `topics/*.md` pages — concepts already have a working, separate enrichment path (`concept-glossary.ts`'s synthesis rollup); inventing a second one here is out of scope.
- **Validating the `mcp`/`duckduckgo` websearch backends against real network/credentials** — flagged as an operator follow-up in §12, not exercised by this spec.
- **Excluding `status: archived` topic pages from re-proposal** (interaction noted in §12) — no evidenced real occurrence yet; revisit once Sub-project C's lifecycle mechanism has archived real topic pages to test against.
- **Retuning `queueCap`/`autoExpireDays`/`autoExpireBelowScore`/`DEPTH_PROFILES`** — no evidence beyond G4's specific fix that current numbers are wrong; revisit with real post-G0-through-G6 usage data.
- **Enabling Slack notifications** — remains an operator decision outside this spec (§1 non-goals).

## 15. Decision (resolved 2026-07-31, operating in minimal-interaction mode)

- **`autoDrainEnabled` defaults to `false` (decided, see §9).** Once G0 ships, all three approval surfaces work correctly for the first time — a human can, today, record a real decision on a real candidate. But `research-execute` itself has **never run once** against this production vault (§0.1's log evidence), makes real, costed LLM calls, and — depending on `search.provider` — spawns an external `npx`-fetched MCP subprocess (`@mzxrai/mcp-webresearch@latest`) that has likewise never been exercised. Turning on automatic enqueueing the moment a decision is recorded means the very first time this whole execution path runs for real could be triggered without a human directly watching it happen and without a chance to sanity-check the first result before more follow automatically. This is squarely the same shape of call Sub-project C flagged rather than resolved unilaterally (`staleDraftArchiveEnabled`) — a switch that changes what happens automatically to Tom's real environment (LLM spend, subprocess execution) the moment it's flipped, versus every other fix in this spec (G0/G3/G4/G5, and G2's protective/corrective changes), which are safe to ship enabled by default because they only repair or harden existing, already-gated behavior. Resolution: ship G0 (the headline fix — all three approval surfaces become genuinely usable), G2 (budget+tier safety net), G3/G4/G5 (hygiene/observability) fully enabled by default; ship G1's auto-drain mechanism fully built and tested, gated behind `autoDrainEnabled: false`, so Tom can run `karpathy intel research <slug> <depth>` by hand for a candidate or two first — now that the approval surfaces actually work — and flip the flag once he's seen a real result land correctly.

## Open questions for Tom

- Do you want `notifications.slack.enabled` turned on for this queue at all, now that the underlying mechanism will actually work? (Would require provisioning a real webhook URL — a `control-center`/secrets question, not decided here.)
- Once you've watched a manual `karpathy intel research <slug> <depth>` run succeed against a real candidate (now possible for the first time via G0), do you want `autoDrainEnabled: true`? (See §15.)

Everything else in this design was resolved directly from the specification, the real code's established conventions (B2c's identical layout-threading fix, Sub-project C's queue-file and disclosure precedents, B2a's tier-aware LLM-client pattern), and the concrete vault/log evidence in §0 — no other product/scope call required a stop.

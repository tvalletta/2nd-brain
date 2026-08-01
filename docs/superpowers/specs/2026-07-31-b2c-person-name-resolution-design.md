# Design: Person Name Resolution (Sub-project B2c)

**Status:** Approved for plan write-up (design conversation complete 2026-07-31, run in minimal-interaction mode per operator instruction; open items in §17 are genuine product calls flagged for Tom, none block plan write-up)
**Sub-project:** B2c of Sub-project B (Content Richness). B2a (review-analysis, merged) and B2b (wiki content richness, merged) are separate, not covered here.
**Soft dependency:** Reuses infrastructure introduced by Sub-project A (the `{layout.system}/reconciliation-queue.md` reconciliation workflow — `detectMergeCandidates`, `refreshQueue`, `karpathy curator`, `reconcile_entities` — spec §22) and by B2a (`generateReviewAnalysis`/`createReviewItem`, used unchanged here, not extended). No new runtime dependency.

## 0. Context

B2c had no prior brief beyond a one-line label ("person name resolution"), explicitly deferred by both B2a's and B2b's design docs as "separate spec." This doc starts from scratch: read the specification's identity rules (§10.2 — "Every canonical entity... page MUST have a stable `id`... Aliases MUST map to a canonical page id... Duplicate pages MUST NOT be silently merged without review"), then read the real vault (`~/.karpathy/config.json` → `defaults.vaultPath` = `/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes`, layout = the `Curated/wiki` production layout) to find the actual problem, and read the existing resolution/merge machinery (`src/ingest/entity-resolver.ts`, `src/compilation/entity-merger.ts`) to understand exactly where it holds up and where it doesn't.

### 0.1 Concrete evidence — vault content

`Curated/wiki/entities/` holds 21 person pages (22 files minus `_index.md`). Sampling all 21 in full:

**12 of 21 (57%) are bare first names or literal Slack handles, with `aliases: []` on every one of them.** Two distinct sub-patterns:

- **9 bare first-name pages**, all sourced from a single document (`Curated/sources/calibration.md`): `arevik.md`, `chinna.md`, `gagik.md`, `grig.md`, `hayk.md`, `hovhannes.md`, `irek.md`, `sargis.md`, `sebouh.md`, `wade.md`. Each has `canonical_name: <BareFirstName>` verbatim, e.g. `arevik.md`:
  ```yaml
  canonical_name: Arevik
  aliases: []
  ```
- **3 literal Slack-handle pages**, sourced from `Curated/sources/directors-squad-offsite-jan-2025.md`: `brownf.md`, `mewing.md`, `pvaughn.md`. `canonical_name` is the raw handle string, e.g. `pvaughn.md`:
  ```yaml
  title: pvaughn
  canonical_name: pvaughn
  aliases: []
  ```

**A fresh mention of the bare first name behind an already-merged full name would silently create a duplicate page today — proven, not hypothetical.** `Bryan Pino.md` (`canonical_name: Bryan Pino`, `aliases: [pino]`) is the vault's one clear evidence trail of a real merge:

- `calibration.md`'s own frontmatter `links:` array still references `Curated/wiki/entities/bryan.md` — a page that no longer exists on disk. That's the fingerprint of a completed merge: a page literally named "Bryan" (extracted from calibration.md's own entity list — *"**Bryan** — Senior Leader/Evaluator — Referenced as having a perspective on calibration. Evaluated Matt Newman's tendency to lean into future and strategy."*) was merged into what's now `Bryan Pino.md`.
- But `Bryan Pino.md`'s `aliases` array contains only `pino` — **not** `bryan`, the original first-name form. `mergeEntities()` in `src/compilation/entity-merger.ts` *would* have added the source page's `canonical_name` as an alias on the target (confirmed by reading the function: `if (sourceCanonical && sourceCanonical.toLowerCase() !== targetCanonical.toLowerCase() && !targetAliases.has(...)) aliasesAdded.push(sourceCanonical)`). The fact that `bryan` is absent from `aliases` means **this merge did not go through `mergeEntities()` at all** — it was done by hand (consistent with the duplicate `### From Wiki` backlink block on this exact file, already flagged in B2b §16 as a backlinks-scanner artifact — a hand copy-paste-merge produces exactly that shape of duplication; a code-driven `mergeEntities()` call would not).
- Concretely: `resolveEntity({ name: 'Bryan', kind: 'person' })` against today's index would **not** find `Bryan Pino.md`. Slug match: `slugify('Bryan')` = `bryan` ≠ `bryan-pino`. Canonical-name match: `normalizeName('Bryan')` = `bryan` ≠ `bryan pino`. Alias match: `bryan` is not in `[pino]`. Fuzzy match (`findFuzzyMatches`): Levenshtein(`bryan`, `bryan pino`) = 5 (inserting " pino"), and `normalized.length` (5) is ≤10 so `maxDist = 2` — 5 > 2, no match. **Result: a fresh source mentioning bare "Bryan" today would resolve as `status: 'new'` and auto-create `bryan.md` as a brand-new, unlinked duplicate**, because `autoCreateEntities` defaults to `true`.
- The periodic backstop doesn't catch it either: `detectMergeCandidates()` (used by the scheduled `detect-entity-dupes` job) requires *either* Levenshtein ≤2 + shared `source_refs`, *or* substring-of-each-other + shared `source_refs`, *or* an exact alias match. A brand-new `bryan.md` sourced from a document other than `calibration.md`/`directors-squad-offsite-jan-2025.md` would share zero `source_refs` with `Bryan Pino.md`, so even the substring tier (which *would* otherwise catch `"bryan".includes` / `"bryan pino".includes("bryan")`) never fires, because the overlap gate blocks it first.

This is the single clearest, most concrete finding in this investigation: **both of the system's two existing duplicate-detection mechanisms (ingest-time `resolveEntity`, periodic `detectMergeCandidates`) share the identical blind spot** — a name-variant mention in a *different, unrelated source document* is invisible to both, because both require either near-identical text or shared provenance. The Bryan/Pino page is living proof this already happened once and required a human to route around the tooling entirely.

**Slack user IDs — a free, stable, already-present identity key — are discarded before extraction ever runs.** The raw source (`raw/2026-05-15/Directors Squad Offsite - Jan 2025.md`, read via its source summary) contains:

```
* [@pino](https://adobe.enterprise.slack.com/team/U01FZCB8X29)
Ownership: PM, PMM ([@pvaughn](https://adobe.enterprise.slack.com/team/U08C58CF45A))
Ownership: Eng, UX ([@brownf](https://adobe.enterprise.slack.com/team/U01MCKEDYAH))
Ownership: PgM ([@mewing](https://adobe.enterprise.slack.com/team/W5S3UAN8M))
```

Four distinct, stable, globally-unique Slack user IDs, right there in the markdown the pipeline already reads in full. `extractEntitiesRichPrompt`/`extractEntitiesRichChunkPrompt` (`src/enrichment/prompts.ts`) ask the LLM only for `{name, role, context, confidence, relationships}` — no field for an external identifier. `EntitySchema` (`src/vault/frontmatter.ts`) has no field to store one either. The single most reliable cross-document identity signal available in this vault's own raw text is thrown away before entity resolution ever sees it. If "Frank Brown" is ever mentioned in a future document instead of the handle `brownf`, but that mention isn't accompanied by the same Slack link, there is **no way**, today or after this spec's algorithmic improvements, to connect the two — short of a human recognizing it (as happened with Bryan/Pino).

**The matching algorithm does *not* over-merge distinct people who happen to be discussed together** — an important negative check, given the instruction to verify rather than manufacture a problem. `Grig`, `Gagik`, and `Kevin Bement` are three separate, correctly-separate pages despite being compared to each other in the same sentences repeatedly ("Kevin Bement... compared to Grig, Gagik"); `Arevik` and `Chinna` are likewise correctly kept distinct despite being directly juxtaposed ("Chinna is more visible than Arevik"). Levenshtein distances between these short names are large enough (`grig` vs `gagik` = 4, `grig` vs `kevin bement` = huge) that no false merge occurs. This confirms the *existing* matching logic is appropriately conservative where it does apply — the gap is entirely about mentions in **different documents** using **different name forms** for the **same person**, which the existing mechanism structurally cannot see, not about over-eager merging.

**A secondary, concrete wikilink-hygiene defect** was found while reading `Matt Newman.md`: its Timeline region reads *"Matt Newman was evaluated by [[Curated/wiki/entities/Bryan Pino]]..."* — a full vault path used as the wikilink target, inconsistent with every other cross-reference in the vault (which uses bare-name form, e.g. `[[Bryan Pino]]`). `entity-merger.ts`'s `rewriteWikilinks()` rewrites links via a regex anchored on the bare slug (`\[\[${escapeRegex(sourceSlug)}...\]\]`, where `sourceSlug` is only the file's trailing path segment) — it would **not** match this full-path form. If "Bryan Pino" is ever merged/renamed again, this specific reference on `Matt Newman.md` would silently go stale, undetected. Small, mechanical, but directly relevant to merge robustness, which is core to this spec's concerns — fixed in §8.

### 0.2 Concrete evidence — code (the mechanism, precisely)

Reading `src/ingest/entity-resolver.ts` (`resolveEntity`) and `src/compilation/entity-merger.ts` (`detectMergeCandidates`) end to end confirms the exact shape of the gap:

- `resolveEntity`'s six tiers, in order: exact slug → exact canonical name → exact alias → cross-folder lenient (still exact slug/name/alias) → fuzzy (Levenshtein ≤2/3, or word-order-independent set equality for full "First Last" swaps) → new. **No honorific stripping. No nickname table. No initials matching** (e.g. "J. Smith" vs "John Smith"). None of these were needed to explain today's vault content (no "Dr. X" example appears), but the code inspection confirms the gap is real and exactly matches what the task brief asked to check for — a latent gap, not yet triggered, in the same spirit as B2b's "Bug 3 (latent, not yet triggered, but reproducible by inspection)".
- `detectMergeCandidates`'s three tiers: Levenshtein ≤2 **+ shared `source_refs`**; substring-of-each-other **+ shared `source_refs`**; exact alias match. The `source_refs` overlap gate (`checkSourceOverlap`) exists to hold down false positives (e.g. two unrelated concepts that happen to share a short substring) — reasonable for concepts/projects/tools, but it is exactly what makes cross-document person-name-variant detection impossible.
- `link-concepts.ts`'s `resolution.status === 'ambiguous'` branch already writes a real review artifact via B2a's `generateReviewAnalysis` + `createReviewItem` (a `type: contradiction` note with `conflict_type: 'ambiguous_entity'`, surfaced by `get_review_queue`). This only fires when `findFuzzyMatches` returns **more than one** candidate — for a genuinely single-candidate case like "Bryan" → "Bryan Pino", the code path never reaches `ambiguous`; it resolves straight to `new` and silently creates a duplicate. This review mechanism is solid infrastructure, but it isn't wired to the failure mode this spec is about.
- Sub-project A's reconciliation queue (spec §22, `src/maintenance/reconciliation-queue.ts`, `detect-entity-dupes` job) is exactly the right *shape* of workflow for "these two person pages/name-forms might be the same identity — merge, rename, skip, or manual" — but it is fed exclusively by `detectMergeCandidates()`, which has the same overlap-gated blind spot described above.
- **Operational finding:** the real vault's config has `"maintenance": { "reviewEnabled": false }`. Per CLAUDE.md, `reviewEnabled: true` is what schedules `detect-entity-dupes` (among other jobs) to run daily; today it is off, so the periodic half of the existing dedup mechanism never runs automatically in this vault at all — the only paths that have ever populated or acted on the reconciliation queue are manual (`karpathy curator`, `karpathy maintenance`, direct `karpathy merge`). This is called out explicitly in §17 as an operator action this design assumes but does not perform.

### 0.3 What's not broken / scope validation

Person entity pages *with* a real full name are genuinely well-formed: `Craig Mathis`, `Matt Newman`, `Ryan Orth`, `Steve Allred`, `Kevin Bement`, `Jug Jacklin` all have multi-paragraph, cross-linked, well-cited summaries (confirming B2b's finding that `compileEntityPage`'s person prompt produces good content once it has a name to work with). The extraction/summarization step itself already does a good job of **within-document** coreference: `calibration.md`'s own "Extracted Entities" list shows bare mentions like "Craig feedback" (Nov 2025) and "Ryan feedback" (Nov 2025) already consolidated into the single canonical "Craig Mathis" / "Ryan Orth" entries alongside their May-2024 full-name mentions — this happens inside the LLM's own chain-of-density summarization of the *one* source document, before entity resolution ever runs, and it worked correctly here. The problem this spec addresses is specifically **cross-document**: the same real person named differently in two *separate* ingest events, which nothing in the pipeline was ever positioned to catch. B2c's job is to close that specific, evidenced gap — not to rebuild extraction-time coreference, which already works.

## 1. Goals / Non-Goals

**Goals:**

- **G0 — Capture stable external identifiers at extraction time.** When raw source text embeds a stable per-person identifier (Slack user ID today, in `[@handle](https://*.slack.com/team/ID)` form), capture it deterministically (no LLM) and store it on the resolved/created person page as `external_ids`. Wire it into `resolveEntity` as the single highest-confidence match tier — an exact external-ID match is definitionally the same identity, no fuzziness involved.
- **G1 — Extend `resolveEntity`'s matching algorithm** with honorific stripping (`Dr. Sarah Chen` → `Sarah Chen`), a curated nickname-equivalence table (`Matt`/`Matthew`, `Bryan`/`Brian`, etc. — chosen to include exactly the spelling-variant risk visible on this vault's own `Matt Newman` page), and initials matching (`J. Smith` vs `John Smith`), scoped to `entity_kind: person` only. These extend the *existing* fuzzy-match tier (which already silently auto-matches on a single candidate) — same risk profile as today, more coverage.
- **G2 — Add a person-scoped "possible name variant" detection tier**, with no shared-source-reference requirement, feeding the *existing* Sub-project A reconciliation queue (never auto-merged — always below `AUTO_MERGE_THRESHOLD`). This is the fix for the proven Bryan/Pino-shaped blind spot: a bare name or handle in one document and a fuller name in another, with no other corroborating link between them.
- **G3 — Run that detection tier immediately when a new person page is created** (both the rich `compileFromSource` path and the simple `link-concepts` path), not only on the next scheduled `detect-entity-dupes` sweep — so a same-day mention creating `bryan.md` gets a same-day reconciliation-queue entry rather than waiting on a cron that (per §0.2) is currently disabled anyway.
- **G4 — Fix the wikilink-hygiene defect** (full-vault-path wikilinks in LLM-authored content instead of bare-slug wikilinks) so `rewriteWikilinks()` doesn't silently miss legitimate future merges.
- **G5 — Make "this page's identity is unresolved" a cheap, greppable, reportable signal** (`identity_uncertain: true` frontmatter, plus a rot-scan reporting table), so an operator can proactively find and fix bare-identity pages without waiting for a future mention to trigger detection — directly supporting the kind of manual cleanup Tom already performed once for Bryan/Pino, but making it discoverable instead of accidental.

**Non-goals:**

- **Concept/project/tool/organization name resolution.** Every finding in this investigation is about `entity_kind: person`. The new detection tier and algorithmic heuristics are explicitly scoped to persons; `detectMergeCandidates()`'s existing three tiers (which already serve other kinds adequately) are untouched for non-person pairs.
- **General-purpose coreference NLP.** This spec closes specific, evidenced gaps (external-ID capture, nickname/honorific/initials matching, overlap-free person substring detection) — it does not introduce a coreference-resolution model or rewrite extraction-time entity merging, which §0.3 shows already works within a single document.
- **Auto-merging any candidate from the new detection tier.** Every candidate this spec's new logic produces lands in the human-reviewed reconciliation queue, by construction always below `AUTO_MERGE_THRESHOLD` (0.85) — see §5. Spec FR-6 requires human review for "merges of suspected duplicate canonical pages"; this spec does not touch that rule.
- **Non-Slack external-identity providers** (email addresses, GitHub handles, Jira account IDs, etc.). `external_ids` is designed as a generalized `provider:id` array so future providers are additive, but only a Slack extractor ships in this spec.
- **Retroactive backfill of `external_ids` for the 12 existing bare-name/handle pages.** The Slack IDs are still recoverable from the original `raw/2026-05-15/...` files, so a future re-ingest or dedicated backfill job is possible, but re-enrich-note (spec §23.2) explicitly works off human-added *wiki* content, not `raw/`, and is not extended here to do so. Flagged as follow-up in §16.
- **Enabling `maintenance.reviewEnabled` in the real vault's config.** An operator action (one line in `~/.karpathy/config.json`), not a code change — flagged in §17, not performed by this spec.
- **The duplicate `### From Wiki` backlink block** on `Bryan Pino.md` — already correctly attributed to B2b's deferred backlinks-scanner bug (§16 of that spec); unrelated to name resolution, not re-scoped here.

## 2. Architecture Overview

```
src/ingest/name-variants.ts (NEW)
  Pure, dependency-free string heuristics: stripHonorifics(), nickname-equivalence
  table + firstNamesEquivalent(), initialsMatch(), looksLikeBareHandleOrFirstName().

src/ingest/external-id-extractor.ts (NEW)
  extractSlackHandleIds(rawText): Map<handleLower, "slack:<ID>">. Deterministic
  regex over raw source text — no LLM, deterministic-lane cost.

src/ingest/entity-resolver.ts (MODIFIED)
  EntityIndex gains byExternalId: Map<string, string>, populated by buildEntityIndex
  from person pages' `external_ids` frontmatter.
  resolveEntity() gains:
    - Tier 0 (new, highest priority): exact external-ID match → status: 'matched',
      confidence 1.0.
    - Honorific stripping applied to the incoming name before every existing tier,
      when kind === 'person'.
  findFuzzyMatches() gains a token-level nickname/initials-plus-same-surname check,
  contributing to the SAME status:'matched'/'ambiguous' behavior fuzzy matches
  already produce today (no new risk class — extends an existing accepted pattern).

src/compilation/person-name-variants.ts (NEW)
  personNameVariantScore(nameA, aliasesA, nameB, aliasesB): pure function, no vault
  I/O. Substring-containment tier (no corroboration required) + token-level
  nickname/surname tier, confidence always < AUTO_MERGE_THRESHOLD.
  findNameVariantCandidatesForNewPage(index, newEntry): person-scoped, O(n) against
  a pre-built EntityIndex — used at ingest time for a single freshly-created page.

src/compilation/entity-merger.ts (MODIFIED)
  detectMergeCandidates() gains a 4th pairwise tier, scoped to person-to-person
  pairs only, using personNameVariantScore — no source_refs overlap requirement.
  (detect-entity-dupes job handler is UNCHANGED — it already calls
  detectMergeCandidates + refreshQueue; it benefits automatically.)

src/compilation/compiler.ts (MODIFIED)
  compileFromSource(): after creating a new person page, or after merging
  external_ids into a matched page's frontmatter, calls
  findNameVariantCandidatesForNewPage + refreshQueue for person-kind entities.

src/jobs/handlers/link-concepts.ts (MODIFIED)
  Same hookup for the simple ingest path's 'new' branch.

src/jobs/handlers/extract-entities.ts (MODIFIED)
  Both extractEntitiesHandler and extractEntitiesRichHandler call
  extractSlackHandleIds(rawContent) and attach externalIds onto each serialized
  person entity in the job-2 payload.

src/ingest/entity-writer.ts (MODIFIED)
  ExtractedEntityInfo gains externalIds?: string[]. buildFrontmatter (person case)
  writes external_ids + identity_uncertain. mergeEntityPage merges new
  external_ids (deduped) and clears identity_uncertain when the merged name is
  no longer bare.

src/vault/frontmatter.ts (MODIFIED)
  EntitySchema gains external_ids: string[] (default []) and
  identity_uncertain: boolean (default false).

src/config/schema.ts (MODIFIED)
  New enrichment.personResolution sub-schema (see §9).

src/intelligence/rot-scan.ts (MODIFIED)
  Adds a "Bare-identity person pages" reporting table (visibility only, no side
  effects), mirroring the existing thin-content table B2b added.

src/compilation/entity-compiler.ts, src/enrichment/prompts.ts (MODIFIED, minor)
  Wikilink-hygiene fix: relatedEntities passed to compileEntityPrompt as bare
  canonical names (never paths); a small post-process normalizes any
  `[[folder/path/Name]]` the LLM still emits down to `[[Name]]` before the
  synthesized content is written into a protected region.
```

## 3. Component 0 — `name-variants.ts`: honorifics, nicknames, initials

**File:** `src/ingest/name-variants.ts` (new)

```typescript
const HONORIFIC_RE = /^(dr|mr|mrs|ms|miss|prof|sir|rev)\.?\s+|\s+(jr|sr|phd|md|esq)\.?$/gi;

export function stripHonorifics(name: string): string {
  return name.replace(HONORIFIC_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Equivalence classes of common English first-name nicknames/spelling variants.
 * Deliberately small and curated — false equivalences are worse than missed ones,
 * since this feeds a matching tier that can auto-resolve a single candidate.
 * Seeded with the spelling-variant risk directly visible on this vault's own
 * "Matt Newman" page (Matt/Matthew) and the "Bryan"/"Brian" confusion class
 * that made the Bryan-Pino merge non-trivial in the first place.
 */
export const NICKNAME_GROUPS: string[][] = [
  ['matthew', 'matt', 'matty'],
  ['robert', 'rob', 'bob', 'bobby'],
  ['william', 'will', 'bill', 'billy'],
  ['richard', 'rick', 'dick', 'ricky'],
  ['michael', 'mike', 'mikey'],
  ['elizabeth', 'liz', 'beth', 'eliza', 'betty'],
  ['katherine', 'kate', 'katie', 'kathy', 'kat'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny'],
  ['joseph', 'joe', 'joey'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['christopher', 'chris'],
  ['daniel', 'dan', 'danny'],
  ['bryan', 'brian'], // spelling variant, not a true nickname — same confusion class
  ['thomas', 'tom', 'tommy'],
  ['anthony', 'tony'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['steven', 'steve', 'stephen'],
];

const NICKNAME_INDEX: Map<string, number> = new Map();
NICKNAME_GROUPS.forEach((group, i) => group.forEach((n) => NICKNAME_INDEX.set(n, i)));

export function firstNamesEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = NICKNAME_INDEX.get(a);
  const gb = NICKNAME_INDEX.get(b);
  return ga !== undefined && ga === gb;
}

/** True if `shortToken` is a single-letter initial matching `longToken`'s first letter. */
export function initialsMatch(shortToken: string, longToken: string): boolean {
  const s = shortToken.replace(/\.$/, '');
  return s.length === 1 && longToken.length > 1 && longToken[0] === s;
}

/**
 * True if `name` is shaped like a bare first name or a raw handle rather than a
 * "First Last" full name — i.e. exactly one whitespace-delimited token. Used to
 * decide whether a newly-created person page deserves an immediate name-variant
 * candidate check and the `identity_uncertain` frontmatter flag.
 */
export function looksLikeBareHandleOrFirstName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).length === 1;
}
```

`NICKNAME_GROUPS` is exported (not just used internally) so `enrichment.personResolution.extraNicknameGroups` (§9) can be validated/appended by config without duplicating the merge logic.

## 4. Component 1 — External identifier capture

**File:** `src/ingest/external-id-extractor.ts` (new)

```typescript
const SLACK_LINK_RE = /\[@([\w.\-]+)\]\(https?:\/\/[\w.\-]+\.slack\.com\/team\/([A-Z0-9]{6,})\)/g;

/**
 * Deterministically scans raw source text for Slack profile-link markdown
 * (`[@handle](https://workspace.slack.com/team/USERID)`) and returns a map of
 * lowercased handle -> "slack:<ID>". No LLM call — runs in the deterministic
 * lane (spec §7.1), same cost class as chunking.
 */
export function extractSlackHandleIds(rawText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of rawText.matchAll(SLACK_LINK_RE)) {
    const handle = match[1].toLowerCase();
    const slackId = match[2];
    if (!map.has(handle)) map.set(handle, `slack:${slackId}`);
  }
  return map;
}
```

**Wiring — `src/jobs/handlers/extract-entities.ts` (modified), both handlers:**

```typescript
// extractEntitiesRichHandler, right after `rawContent` is read:
const handleIdMap = extractSlackHandleIds(rawContent);
...
function serializeRichEntitiesForPayload(entities: RichExtractedEntities, handleIdMap: Map<string, string>) {
  return {
    people: entities.people.map((p) => ({
      name: p.name, role: p.role, context: p.context,
      relationships: p.relationships, chunkRefs: p.chunkRefs,
      externalIds: handleIdMap.has(p.name.toLowerCase()) ? [handleIdMap.get(p.name.toLowerCase())!] : [],
    })),
    // ...unchanged for other kinds
  };
}
```

The same treatment applies to `extractEntitiesHandler`/`serializeEntitiesForPayload` (the simple, non-rich path) for consistency — both handlers already have `rawContent` in scope, so this is a one-line addition to each, not a new read.

**Frontmatter — `src/vault/frontmatter.ts` (modified):**

```typescript
export const EntitySchema = BaseFrontmatterSchema.extend({
  type: z.literal('entity'),
  entity_kind: z.string(),
  canonical_name: z.string(),
  /** Stable external identifiers, "provider:id" form, e.g. "slack:U01FZCB8X29". */
  external_ids: z.array(z.string()).default([]),
  /** True when canonical_name is a bare first name or raw handle — cleared on merge/rename. */
  identity_uncertain: z.boolean().default(false),
});
```

**Propagation — `src/ingest/entity-writer.ts` (modified):**

```typescript
export interface ExtractedEntityInfo {
  name: string;
  kind: EntityKind;
  role?: string;
  context?: string;
  definition?: string;
  status?: string;
  chunkRefs: string[];
  externalIds?: string[]; // NEW
}
```

`buildFrontmatter`'s `case 'person'` branch:

```typescript
case 'person': {
  const bareIdentity = looksLikeBareHandleOrFirstName(info.name);
  return {
    ...base,
    type: 'entity',
    entity_kind: 'person',
    canonical_name: info.name,
    external_ids: info.externalIds ?? [],
    identity_uncertain: bareIdentity,
    protected_regions: ['summary', 'projects', 'topics', 'timeline', 'sources', 'backlinks'],
  };
}
```

`mergeEntityPage` (used by `link-concepts.ts`'s matched+`autoMergeEntities` branch) gains, alongside its existing `aliases` merge logic:

```typescript
if (info.externalIds?.length) {
  const existingIds = new Set((data.external_ids as string[]) ?? []);
  const before = existingIds.size;
  for (const id of info.externalIds) existingIds.add(id);
  if (existingIds.size !== before) {
    data.external_ids = [...existingIds];
    fieldsUpdated.push('external_ids');
  }
}
```

`mergeEntities` (`entity-merger.ts`, the full page-merge used by `karpathy curator`/`reconcile_entities`/auto-merge) is extended identically: union the two pages' `external_ids` arrays (deduped) onto the target, and set `data.identity_uncertain = false` on the target unconditionally — a merge, by definition, means the identity is now better-established than either page alone, regardless of which name form the target's `canonical_name` ends up as.

**Resolution — `src/ingest/entity-resolver.ts` (modified):**

```typescript
export interface EntityIndex {
  bySlug: Map<string, string>;
  byCanonicalName: Map<string, string>;
  byAlias: Map<string, string>;
  byExternalId: Map<string, string>; // NEW
  allEntries: EntityIndexEntry[];
}
```

`buildEntityIndex` populates `byExternalId` from each entity's `external_ids` frontmatter array (only meaningful for `person`, but harmless to build generically). `resolveEntity` gains an optional parameter:

```typescript
export function resolveEntity(
  entity: { name: string; kind: EntityKind; externalIds?: string[] }, // externalIds NEW
  index: EntityIndex,
  layout: VaultLayout = DEFAULT_LAYOUT,
): EntityResolution {
  // Tier 0 (NEW, checked first): exact external-ID match.
  for (const id of entity.externalIds ?? []) {
    const match = index.byExternalId.get(id);
    if (match) {
      return { entityName: entity.name, entityKind: entity.kind, status: 'matched', matchedPath: match, confidence: 1.0 };
    }
  }

  const { name, kind } = entity;
  const normalizedInput = kind === 'person' ? stripHonorifics(name) : name;
  const normalized = normalizeName(normalizedInput);
  const slug = slugify(normalizedInput);
  // ...tiers 1-6 unchanged below this point, operating on `normalizedInput`/`normalized`/`slug`
  // instead of the raw `name`.
}
```

An external-ID match is definitionally certain — no fuzziness, no review needed, same trust level as today's exact-slug tier. This is the mechanism that would have let a hypothetical later mention of "Frank Brown" resolve straight to `brownf.md` *if* that later mention also carried the same Slack link (the residual case where it doesn't — a plain-text name with no accompanying Slack link — is not solvable by this tier and is addressed by §5 instead; see §11 edge cases).

`findFuzzyMatches` gains one new check, inserted after the existing Levenshtein check, before the alias-Levenshtein check:

```typescript
// Token-level: same/near-identical surname + nickname-equivalent or initials-equivalent first name.
const entryTokens = entryNormalized.split(/\s+/);
const nameTokens = normalized.split(/\s+/);
if (nameTokens.length >= 2 && entryTokens.length >= 2) {
  const lastName = nameTokens[nameTokens.length - 1];
  const lastEntry = entryTokens[entryTokens.length - 1];
  if (lastName === lastEntry || levenshtein(lastName, lastEntry) <= 1) {
    const firstName = nameTokens[0];
    const firstEntry = entryTokens[0];
    if (
      firstNamesEquivalent(firstName, firstEntry) ||
      initialsMatch(firstName, firstEntry) ||
      initialsMatch(firstEntry, firstName)
    ) {
      results.push({ path: entry.path, confidence: 0.8 });
      continue;
    }
  }
}
```

This extends the *same* `status: 'matched'` (single candidate) / `'ambiguous'` (multiple candidates) behavior the existing Levenshtein/word-order tiers already produce — no new risk class is introduced; a nickname-based single match auto-resolves exactly as a misspelling-based single match already does today.

## 5. Component 2 — Person-scoped name-variant detection (the core fix)

**File:** `src/compilation/person-name-variants.ts` (new)

This is the fix for the proven Bryan/Pino blind spot: a bare name or handle in one document, a fuller name in a different, unrelated document, with **no shared source and no exact alias** connecting them. Unlike Component 1 (which extends an *existing* auto-resolving tier), this component's output always requires human confirmation — the signal is too weak to trust unsupervised (see §11 for why: "Chris" would also flag against "Chris Anderson" even if they're different people).

```typescript
import { normalizeName, levenshtein } from '../ingest/entity-resolver.js';
import { stripHonorifics, firstNamesEquivalent, initialsMatch } from '../ingest/name-variants.js';

export interface NameVariantMatch {
  confidence: number;
  reason: string;
}

/**
 * Pure, vault-I/O-free scoring function. No shared-source-reference requirement
 * (that's the entire point — see §0.1's Bryan/Pino evidence). Always returns a
 * confidence well below AUTO_MERGE_THRESHOLD (0.85); every result of this
 * function is destined for the human-reviewed reconciliation queue, never an
 * automatic merge.
 */
export function personNameVariantScore(
  nameA: string, aliasesA: string[],
  nameB: string, aliasesB: string[],
): NameVariantMatch | null {
  const candidatesA = [nameA, ...aliasesA].map((n) => normalizeName(stripHonorifics(n)));
  const candidatesB = [nameB, ...aliasesB].map((n) => normalizeName(stripHonorifics(n)));

  for (const a of candidatesA) {
    for (const b of candidatesB) {
      if (a === b) continue; // exact matches are handled upstream by resolveEntity already
      if (a.length < 3 || b.length < 3) continue; // avoid single-letter/initial noise

      // Tier A: one name fully contained in the other ("Bryan" inside "Bryan Pino").
      if (a.includes(b) || b.includes(a)) {
        return { confidence: 0.5, reason: `"${a}" and "${b}" — one name is fully contained in the other` };
      }

      // Tier B: same (or near-identical) surname + nickname/initials-equivalent first name.
      const ta = a.split(' ');
      const tb = b.split(' ');
      if (ta.length >= 2 && tb.length >= 2) {
        const lastA = ta[ta.length - 1];
        const lastB = tb[tb.length - 1];
        if (lastA === lastB || levenshtein(lastA, lastB) <= 1) {
          const firstA = ta[0];
          const firstB = tb[0];
          if (firstNamesEquivalent(firstA, firstB) || initialsMatch(firstA, firstB) || initialsMatch(firstB, firstA)) {
            return { confidence: 0.65, reason: `"${nameA}" and "${nameB}" — same surname, equivalent first name/initial` };
          }
        }
      }
    }
  }
  return null;
}
```

**File:** `src/compilation/entity-merger.ts` (modified) — `detectMergeCandidates()` gains a 4th pairwise tier, inside the existing double loop, scoped to person-to-person pairs and run **without** the `checkSourceOverlap` gate the other three tiers require:

```typescript
// NEW tier (person-only, no source-overlap requirement — see B2c design §5).
if (a.path.startsWith(kindToFolder(layout, 'person')) && b.path.startsWith(kindToFolder(layout, 'person'))) {
  const scored = personNameVariantScore(a.name, a.aliases, b.name, b.aliases);
  if (scored && !seen.has(pairKey)) {
    seen.add(pairKey);
    const [source, target] = a.name.length >= b.name.length ? [b, a] : [a, b];
    candidates.push({
      sourcePath: source.path,
      targetPath: target.path,
      sourceName: source.name,
      targetName: target.name,
      reason: scored.reason,
      confidence: scored.confidence,
    });
  }
}
```

`detectMergeCandidates()`'s confidence is capped by `personNameVariantScore` at 0.65 — below `AUTO_MERGE_THRESHOLD` (0.85) — so every candidate this tier produces lands in `queueCandidates`, never `autoCandidates`, in the existing `detect-entity-dupes` handler split (`src/jobs/handlers/detect-entity-dupes.ts`, **unchanged** — it already does exactly the right thing with whatever `detectMergeCandidates` returns).

**Running this once against today's vault** (mentally, since Bryan/Pino is already merged) would find zero *currently pending* person-page pairs — confirming §0.3's honesty check: there is no unresolved duplicate sitting in the vault today. What this component demonstrably *does* find, the moment any of the 12 bare-name/handle pages gets a second, fuller-name mention in a new document, is exactly the class of pair that previously required a human to notice and manually merge around the tooling.

## 6. Component 3 — Immediate detection on new person-page creation

**File:** `src/compilation/person-name-variants.ts` (same file, additional export)

```typescript
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { kindToFolder, type VaultLayout } from '../vault/paths.js';
import type { MergeCandidate } from './entity-merger.js';

/**
 * O(n) check of a single freshly-created person page against every existing
 * person page already in a pre-built EntityIndex. Used at ingest time so a
 * same-day bare-name mention gets a same-day reconciliation-queue entry,
 * rather than waiting for the next scheduled detect-entity-dupes sweep
 * (which, per §0.2, is not even currently scheduled in the real vault).
 */
export function findNameVariantCandidatesForNewPage(
  index: EntityIndex,
  layout: VaultLayout,
  newEntry: { name: string; path: string; aliases: string[] },
): MergeCandidate[] {
  const personFolder = kindToFolder(layout, 'person');
  const candidates: MergeCandidate[] = [];

  for (const existing of index.allEntries) {
    if (existing.path === newEntry.path) continue;
    if (!existing.path.startsWith(personFolder)) continue;

    const scored = personNameVariantScore(newEntry.name, newEntry.aliases, existing.name, existing.aliases);
    if (scored) {
      const [source, target] = newEntry.name.length >= existing.name.length
        ? [{ path: existing.path, name: existing.name }, { path: newEntry.path, name: newEntry.name }]
        : [{ path: newEntry.path, name: newEntry.name }, { path: existing.path, name: existing.name }];
      candidates.push({
        sourcePath: source.path, targetPath: target.path,
        sourceName: source.name, targetName: target.name,
        reason: scored.reason, confidence: scored.confidence,
      });
    }
  }
  return candidates;
}
```

**Wiring — `src/compilation/compiler.ts` (modified), `compileFromSource`**, right after a new person page is created (existing `createdPath` variable, existing `entityIndex` variable already updated with the new page per the existing "Update the index so subsequent entities can find this page" comment):

```typescript
if (
  entity.kind === 'person' &&
  context.config.enrichment.personResolution.enabled
) {
  try {
    const candidates = findNameVariantCandidatesForNewPage(entityIndex, layout, {
      name: entity.name, path: createdPath, aliases: [],
    });
    if (candidates.length > 0) {
      await refreshQueue(vault, candidates, layout);
      log.info('Queued person name-variant candidates', { path: createdPath, count: candidates.length });
    }
  } catch (err) {
    log.warn('Name-variant check failed; page created without a candidate check', {
      path: createdPath, error: (err as Error).message,
    });
  }
}
```

Wrapped in try/catch and logged-not-thrown deliberately: a failure here must never block or roll back a page that was already successfully created — matching the existing pattern immediately above it in the same function (the `flaggedForReview` review-item write is similarly best-effort).

**Wiring — `src/jobs/handlers/link-concepts.ts` (modified)**, identical hookup inside the existing `resolution.status === 'new' && context.config.enrichment.autoCreateEntities` branch, right after `linkedPaths.push(path)`.

This component does **not** run for the `matched` branch — an existing page gaining a new mention isn't a "new identity" event, so there's nothing new to check against the rest of the index.

## 7. Component 4 — Bare-identity signal (`identity_uncertain`) and reporting

Already specified in full in §4 (frontmatter field) — this section covers the reporting surface.

**File:** `src/intelligence/rot-scan.ts` (modified)

```typescript
export interface BareIdentityEntry {
  path: string;
  title: string;
}

export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  bareIdentityCandidates: BareIdentityEntry[]; // NEW
  reportPath: string;
}
```

Inside the existing per-file loop in `runRotScan`, alongside the existing thin-content check:

```typescript
if (asString(fm.entity_kind) === 'person' && fm.identity_uncertain === true) {
  bareIdentityCandidates.push({ path, title: asString(fm.title) || path });
}
```

`renderReport()` gains a third table, "Bare-identity person pages (canonical name is a bare first name or handle)", following the same markdown-table convention as the existing rot and thin-content tables — purely reporting, `rot-scan` never enqueues anything, consistent with its existing role (per B2b's Component 4 precedent).

`identity_uncertain` is cleared to `false` by `mergeEntities`/`mergeEntityPage` on any merge (§4) and, separately, by a manual `karpathy curator` `rename` decision (the existing rename path in `src/vault/paths.ts`/curator CLI already updates `canonical_name`; this spec adds one line to also clear `identity_uncertain` whenever the CLI rename handler runs, since a human-confirmed rename is exactly the resolution this flag exists to prompt).

## 8. Component 5 — Wikilink-hygiene fix (G4)

**File:** `src/compilation/entity-compiler.ts` (modified)

The `relatedEntities` block passed into `compileEntityPrompt` (line ~90-94 today) already maps `r.target` (a plain name string from the LLM's own `relationships` extraction) directly — this is not the source of the bad link. The defect is that nothing normalizes the LLM's own **generated prose** in the SUMMARY/PROJECTS/TOPICS/TIMELINE sections after the fact; if the model ever echoes a fuller-looking reference (as it did once, on `Matt Newman.md`), it passes through unchanged.

Add a small, deterministic post-process to `compileEntityPage`, applied to the LLM's raw output before it's written into any protected region:

```typescript
/** Collapse any `[[folder/path/Name]]`-shaped wikilink the model emits down to
 *  bare-name form `[[Name]]`, so entity-merger's rewriteWikilinks() (which
 *  matches on bare slug only) can find and update it on a future merge. */
function normalizeWikilinkTargets(text: string): string {
  return text.replace(/\[\[([^\]|]*\/)([^\]|/]+)(\|[^\]]+)?\]\]/g, (_, _path, name, alias) => `[[${name}${alias ?? ''}]]`);
}
```

Applied once, right before each section (`SUMMARY:`, `PROJECTS:`, etc.) is written into its protected region in `compileEntityPage`. This is purely mechanical text normalization — it does not change what the LLM decided to link, only how the link target is written, and it directly fixes the exact defect found on `Matt Newman.md` (`[[Curated/wiki/entities/Bryan Pino]]` → `[[Bryan Pino]]`) as a byproduct of the *next* time that page is compiled, without requiring a special one-off backfill script.

## 9. Config schema changes

**File:** `src/config/schema.ts`

```typescript
export const PersonResolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Gate for Component 0 (external-ID capture) — Slack link scanning at extraction time. */
  externalIdCaptureEnabled: z.boolean().default(true),
  /** Gate for Component 1's nickname/honorific/initials fuzzy-match extensions. */
  nicknameMatchingEnabled: z.boolean().default(true),
  /** Additional nickname-equivalence groups appended to the built-in NICKNAME_GROUPS seed list. */
  extraNicknameGroups: z.array(z.array(z.string())).default([]),
});
```

Wired into `EnrichmentConfigSchema` as `personResolution: PersonResolutionConfigSchema.default({})`, alongside the existing `entityBlocklist`/`minEntityConfidence`/`significanceGate` fields, plus the corresponding entry in `PartialEnrichmentConfigSchema` (already generic via `.partial()` — picks up the new field automatically, matching how `significanceGate` etc. are already handled). No `loader.ts` changes needed — `mergeOverride()` already merges nested keys generically, per the same precedent B2b used for `intelligence.richness`.

No new fields are needed on `ReviewConfigSchema` or the reconciliation-queue machinery — Component 2/3 reuse `refreshQueue()` and the existing queue file exactly as Sub-project A built it.

## 10. Data model / frontmatter

**`EntitySchema`** (`src/vault/frontmatter.ts`) gains two fields, both optional/defaulted, fully backward-compatible with the 21 existing person pages (and every other `entity_kind`, since the fields live on the generic `entity` type, not a person-only sub-schema — organizations/tools have no meaningful use for them today but suffer no harm from the default `[]`/`false`):

```yaml
external_ids: []          # "provider:id" strings, e.g. "slack:U01FZCB8X29"
identity_uncertain: false # true when canonical_name is a bare first name or handle
```

**No changes to `BaseFrontmatterSchema`** — both new fields are entity-specific, matching how `entity_kind`/`canonical_name` are already scoped to `EntitySchema` rather than the base.

**Reconciliation queue** (`src/maintenance/reconciliation-queue.ts`, Sub-project A): **zero schema changes**. `ReconciliationEntry`'s existing shape (`sourcePath`/`targetPath`/`sourceName`/`targetName`/`reason`/`confidence`) already fits `MergeCandidate` exactly, and `refreshQueue()`'s existing pair-key dedup (`[a,b].sort().join('||')`) already prevents duplicate entries regardless of which detection tier produced the candidate — Components 2 and 3 are pure producers into a queue that requires no modification.

## 11. Decision tables

**`resolveEntity` tier resolution (§4), in order:**

| Tier | Check | Confidence | Requires human review? |
|---|---|---|---|
| 0 (NEW) | Exact `external_ids` match | 1.0 | No — definitionally certain |
| 1 | Exact slug match (honorific-stripped for persons) | 1.0 | No |
| 2 | Exact canonical-name match | 0.95 | No |
| 3 | Exact alias match | 0.9 | No |
| 4 | Cross-folder lenient (slug/name/alias, wrong folder) | 0.85 | No |
| 5a | Levenshtein ≤2/3 or word-order swap (existing) | 0.5–0.9 | No (single match) / Yes, `ambiguous_entity` review (multiple) |
| 5b (NEW) | Same/near-surname + nickname/initials-equivalent first name | 0.8 | No (single match) / Yes, `ambiguous_entity` review (multiple) |
| 6 | No match | — | N/A — page created; Component 3 immediately runs the separate no-overlap check (below) |

**Person-scoped name-variant detection (§5/§6) — always separate from the table above, always queue-bound:**

| Signal | Confidence | Destination |
|---|---|---|
| One name fully contained in the other (no surname corroboration) | 0.5 | Reconciliation queue (`pending`) |
| Same/near-identical surname + nickname/initials-equivalent first name | 0.65 | Reconciliation queue (`pending`) |
| (either signal, ever) | always < 0.85 | Never `autoCandidates` in `detect-entity-dupes` — always human-reviewed |

**Frontmatter state transitions for `identity_uncertain`:**

| Event | `identity_uncertain` |
|---|---|
| New person page created, name is bare (`looksLikeBareHandleOrFirstName`) | `true` |
| New person page created, name has ≥2 tokens | `false` |
| Page merged into another (either direction) via `mergeEntities`/`mergeEntityPage` | `false` on the surviving target |
| `karpathy curator` `rename` decision applied | `false` |
| No action taken | unchanged — persists until one of the above fires |

## 12. Edge cases and failure modes

- **The residual gap Component 0 cannot close:** a future mention of "Frank Brown" with *no* accompanying Slack link cannot be matched to `brownf.md` via external ID (there's no ID present in that mention to compare). This is exactly the case Components 2/3 exist for — the substring/nickname tier would need "Frank Brown" to contain or nickname-match "brownf" textually, which it doesn't (a Slack handle isn't a name fragment in any general, reliable way). This is an **acknowledged, permanent residual risk** — closing it fully would require either a human-maintained handle→name lookup table (out of scope; that's effectively what the reconciliation queue is for once a human notices) or an LLM-based inference step (explicitly out of scope per §1). Flagged, not solved.
- **False-positive risk from the substring tier is real and intentional-by-design, not a bug:** two genuinely different people both named "Chris" (one "Chris Anderson," one "Chris Patel," say) would generate a reconciliation-queue candidate the first time either is mentioned with a fuller name — correctly resolved by a human `skip` decision. This is the entire reason Component 2's output is capped below `AUTO_MERGE_THRESHOLD` and always queue-bound rather than auto-applied.
- **Two different people who are *never* mentioned with anything beyond the same bare first name** (e.g., two distinct real "Chris"es, neither ever given a surname in any source) are — and remain — a **pre-existing, unrelated risk this spec does not fix**: `resolveEntity`'s tier 2 (exact canonical-name match) would already silently collapse the second "Chris" mention into the first "Chris" page today, with or without this spec. Nothing in `entity_kind: person` resolution can distinguish two identically-named real people without more identifying context than a bare first name provides. Noted here for honesty, not addressed — a deterministic system fundamentally cannot solve this without an external identifier or human intervention, both already covered elsewhere in this design for the cases where a *second* signal (Slack ID, surname) eventually appears.
- **`personNameVariantScore` comparing a bare handle against another bare handle** (e.g. hypothetically `brownf` vs. some future `bwhite` handle): both fail the substring test (no containment) and the token-level test (both single-token, no surname to compare) — correctly produces no candidate. Two different handles never spuriously match each other.
- **A person page created with `external_ids` already carrying a Slack ID that later turns out to belong to a *different* person** (e.g. a Slack user ID gets reassigned after someone leaves the org and a new hire receives the same handle — Slack IDs are per-workspace-account, not per-handle-string, so this is unlikely in practice but not impossible over long time horizons): `resolveEntity`'s tier 0 would silently and confidently misattribute the new person's mentions to the old page. This is an accepted, low-probability risk consistent with treating Slack IDs as stable identity — flagged, not mitigated (mitigating it would require org-directory integration, well out of scope).
- **`TransientLLMError` interaction:** none of the new components in this spec make any LLM call — Components 0 through 3 are entirely deterministic (regex extraction, string comparison, frontmatter merges). There is no new `TransientLLMError` surface to handle; existing try/catch around the *surrounding* compile/link operations is untouched.
- **Concurrent creation of two new person pages that would each flag against each other:** `findNameVariantCandidatesForNewPage` runs once per newly-created page, against the entity index as it stood *at that page's creation time*. If two bare-name pages for the same person are created in the same batch (e.g. two chunks of the same long source both extract "Bryan" independently, in a hypothetical race), the second one's index snapshot would already include the first, so the second creation's check would flag against the first, landing one candidate in the queue — correctly surfaced, just once, not twice, since `refreshQueue`'s pair-key dedup collapses any repeat.
- **A name that is a common English word or generic single token** (e.g. hypothetically extracting "Team" as a person name due to an extraction-prompt misfire): `personNameVariantScore`'s length floor (`a.length < 3 || b.length < 3`) only filters out very short strings, not generic words — this is a pre-existing extraction-quality problem (the significance gate / `entityBlocklist`, `src/enrichment/entity-filter.ts`, already exists to filter exactly this class of noise before a page is ever created) and is not re-solved here; Component 2/3 only run on names that already survived the significance gate.

## 13. Observability

- `DecayScanResult`/rot-scan gains `bareIdentityCandidates: BareIdentityEntry[]` (§7), surfaced via `vault-health.md`'s new table — same pattern, same consumers, as B2b's `thinCandidates`.
- `detect-entity-dupes`'s existing log line (`appendLogEntry`, `entity:dedupe` kind — unchanged) already reports `${candidates.length} scanned → ${merged} auto-merged, ${added} newly queued`; Component 2's new tier is folded into `candidates.length`/`added` with no new log plumbing required.
- The immediate ingest-time check (§6) logs via the existing `createLogger('compiler')`/`createLogger('handler:link-concepts')` loggers — `'Queued person name-variant candidates'` at `info` level when candidates are found, matching the existing logging density in both files (no new logger created).
- No new `log.md` vault entries — external-ID capture and frontmatter merges are silent, deterministic-lane operations, consistent with how backlink/index updates are already silent in `log.md` today.

## 14. Testing plan

- `name-variants.ts`: `stripHonorifics` against every documented prefix/suffix form (`Dr. `, `Mr. `, ` Jr.`, ` PhD`, case-insensitivity) and a no-op case (a name with no honorific is returned unchanged). `firstNamesEquivalent`: every documented group pair, plus a negative case (names in different groups). `initialsMatch`: `"J"`/`"J."` against `"John"`, plus negative cases (empty string, multi-letter "short" token). `looksLikeBareHandleOrFirstName`: single-token true, multi-token false, empty-string false.
- `external-id-extractor.ts`: the exact Slack-link markdown reproduced verbatim from `directors-squad-offsite-jan-2025.md` (regression fixture, taken directly from the real vault finding) extracts all four handle→ID pairs correctly; a non-Slack markdown link is ignored; a Slack link with a malformed/short ID is ignored (regex length floor); duplicate handles in the same text keep the first ID seen.
- `entity-resolver.ts` (`resolveEntity`, `findFuzzyMatches`): a mention carrying `externalIds: ['slack:U01FZCB8X29']` matches the corresponding existing page at confidence 1.0 even when the incoming `name` differs entirely from the page's `canonical_name` (this is the crux test — proves tier 0 fires ahead of and independent of every name-based tier). Honorific-stripped exact-slug match (`"Dr. Sarah Chen"` → matches an existing `sarah-chen.md`). Nickname/initials tier: `"Matt Newman"` vs a hypothetical existing `"Matthew Newman"` page resolves as `matched`, single candidate; two existing candidates (`"Matthew Newman"` and `"Matthew Newby"`) both satisfying the nickname+near-surname tier resolves as `ambiguous`. Regression: every existing `entity-resolver.test.ts` case continues to pass unmodified (byte-for-byte behavior for kinds other than `person`, and for persons whose name needs no honorific-stripping).
- `person-name-variants.ts` (`personNameVariantScore`): the Bryan/Pino case reproduced as a literal fixture (`"Bryan"`, `[]`, `"Bryan Pino"`, `["pino"]`) returns a non-null match at confidence 0.5 (substring tier). `"Matt Newman"` vs `"Matthew Newman"` returns confidence 0.65 (surname+nickname tier). Two unrelated names (`"Grig"` vs `"Kevin Bement"`, reproduced from the real vault's correctly-*not*-merged pair) returns `null`. Exact-name-match input returns `null` (handled upstream, not by this function). `findNameVariantCandidatesForNewPage`: given an index fixture containing `Bryan Pino.md`, a new page named `"Bryan"` produces exactly one candidate; a new page named `"Zzyzx"` (no plausible match) produces zero.
- `entity-merger.ts` (`detectMergeCandidates`): a person-kind pair with zero shared `source_refs` but a qualifying `personNameVariantScore` is detected (the regression test that directly proves this spec's core fix — construct a fixture vault with two person pages sourced from *different*, non-overlapping documents, one bare-named, one full-named, and assert the pair is found). A non-person pair (e.g. two concepts) with the same textual relationship is *not* detected by the new tier (proves the person-only scope). Confidence of every new-tier candidate is asserted `< AUTO_MERGE_THRESHOLD`. Existing three tiers' tests are unaffected (regression).
- `compiler.ts`/`link-concepts.ts`: creating a new bare-named person page against a fixture vault that already contains a plausible fuller-named page results in exactly one new reconciliation-queue entry (`readReconciliationQueue` assertion) after the ingest job completes; creating a page with no plausible match results in zero new entries; a failure thrown by the name-variant check (mocked) does not prevent the page from being created or the job from completing (try/catch regression test, mirroring the existing `flaggedForReview` best-effort pattern already tested in `compiler.test.ts`).
- `entity-writer.ts`: `buildFrontmatter` for `kind: 'person'` sets `identity_uncertain: true` for a bare name and `false` for a "First Last" name; `external_ids` defaults to `[]` when `info.externalIds` is undefined and to the provided array otherwise. `mergeEntityPage` unions `external_ids` without duplication across two calls with overlapping IDs.
- `entity-merger.ts` (`mergeEntities`): merging a bare-named source into a fuller-named target unions `external_ids` and sets `identity_uncertain: false` on the target regardless of the target's own prior state.
- `rot-scan.ts`: a fixture vault with one `identity_uncertain: true` person page and one fully-named person page produces a "Bare-identity person pages" table containing only the former; existing rot/thin-content table tests unaffected.
- `entity-compiler.ts` (`normalizeWikilinkTargets`): a full-path wikilink (`[[Curated/wiki/entities/Bryan Pino]]`, reproduced verbatim from the real `Matt Newman.md` finding) collapses to `[[Bryan Pino]]`; a link with a display alias (`[[folder/Name|Display]]`) collapses to `[[Name|Display]]`; a link already in bare form is unchanged (idempotent).

## 15. Explicitly deferred

- **Non-Slack external-identity providers** (email, GitHub, Jira account IDs) — `external_ids`'s `provider:id` shape is generalized for this, but only a Slack extractor ships here. Worth revisiting once a source type carrying a different stable identifier shows up in practice.
- **Retroactive `external_ids` backfill** for the 12 already-existing bare-name/handle pages, whose Slack IDs are still recoverable from `raw/2026-05-15/...`. Would require either a one-off backfill script reading `raw/` directly (outside `re-enrich-note`'s current scope, which is wiki-content-only per spec §23.2) or a full re-ingest. Flagged as operator follow-up, not designed here.
- **Concept-merging/canonicalization for non-person entities** — unrelated to this spec's scope (§1); B2b already flagged the analogous concept-glossary near-duplicate problem (`LLM Gateway`/`LLM Gateway with Fallback`/etc.) as its own future sub-project, and this spec doesn't touch it.
- **An org-directory or SSO-backed identity provider integration** that could deterministically resolve a Slack handle to a real name at ingest time (rather than only linking two mentions once both eventually appear) — would fully close the residual gap noted in §12's first edge case, but requires infrastructure (an internal directory API/credential) well outside this project's local-first, no-cloud-dependency design goals (spec §4 non-goals: "a cloud service for normal operation").
- **Fixing the duplicate `### From Wiki` backlink block on `Bryan Pino.md`** — already correctly scoped to B2b's deferred backlinks-scanner bug list; not re-owned here.

## 16. Open questions for Tom

- **`maintenance.reviewEnabled` is currently `false` in the real vault's config**, meaning `detect-entity-dupes` (and the other daily review-scan jobs Sub-project A wired up) never runs on a schedule today — the periodic half of this spec's detection (Component 2, via `detectMergeCandidates`) would sit dormant until either that config flips to `true` or `karpathy maintenance`/`curator` is run manually. Component 3 (the immediate ingest-time check) works regardless, since it doesn't depend on the cron. Recommend flipping `reviewEnabled: true` in `~/.karpathy/config.json` alongside deploying this spec, but that's a one-line operator config change outside this design's code changes — flagging rather than assuming.
- **Nickname-table scope/ownership**: the seed list in §3 is deliberately small and Anglophone-centric; it does nothing for the Armenian first names that make up 9 of this vault's 12 problem pages (Arevik, Sargis, Sebouh, etc. — there's no obvious "nickname" relationship to encode for those). Is a larger, more broadly multilingual seed list worth the upfront curation cost, or should `enrichment.personResolution.extraNicknameGroups` remain purely config-driven so Tom can add exactly the pairs relevant to his own vault's people over time? This spec ships the small English seed list and the config extension point; growing the built-in list further is a product-taste call, not a technical one.

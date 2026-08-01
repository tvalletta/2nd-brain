# B2c Person Name Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the proven Bryan/Pino-shaped blind spot where a bare first name or Slack handle in one document and a fuller name in an unrelated document create a silent duplicate person page. Capture stable Slack-handle external IDs at extraction time as the highest-confidence resolution signal; extend `resolveEntity`'s fuzzy tier with honorific stripping, nickname equivalence, and initials matching (person-scoped); add an overlap-free person-name-variant detection tier feeding the existing Sub-project A reconciliation queue, both as a periodic `detectMergeCandidates` tier and as immediate same-day detection when a new person page is created; make "identity unresolved" a cheap, greppable, reportable frontmatter signal; and fix a wikilink-hygiene defect in LLM-authored entity content.

**Architecture:** A new `src/ingest/name-variants.ts` provides pure, dependency-free honorific/nickname/initials heuristics used by both `entity-resolver.ts` (ingest-time matching) and a new `src/compilation/person-name-variants.ts` (overlap-free candidate scoring, used both as `detectMergeCandidates`'s 4th tier and as an immediate-detection check wired into both ingest pipelines). A new `src/ingest/external-id-extractor.ts` deterministically extracts Slack user IDs from raw markdown; `EntitySchema` gains `external_ids`/`identity_uncertain`; `resolveEntity` gains a highest-priority external-ID match tier. `rot-scan.ts` gains a bare-identity reporting table. A small deterministic post-process in `entity-compiler.ts` fixes the full-vault-path wikilink defect found on `Matt Newman.md`.

**Design spec:** `docs/superpowers/specs/2026-07-31-b2c-person-name-resolution-design.md` (all 16 sections approved; both items in §16 already resolved — see "Design decisions already settled" below, no plan work follows from them beyond what's noted).

## Design decisions already settled (no task needed)

- **Nickname-table scope stays as designed** (§16): `NICKNAME_GROUPS` in Task 1 stays a small, curated, Anglophone seed list. `enrichment.personResolution.extraNicknameGroups` (Task 2) is the config-driven extension point for locale-specific additions Tom can make later — this plan does not attempt to guess additional groups.
- **`maintenance.reviewEnabled` stays `false` in the real vault's live config** (§16, §0.2): that's a one-line change to `~/.karpathy/config.json`, outside this git repo, and an explicit operator action — not performed by this plan or any task below. Component 3 (immediate detection, Task 7) works regardless of this flag; only the periodic `detect-entity-dupes` cron sweep depends on it.

## Global Constraints

- ESM only — all imports use `.js` extensions, even for `.ts` source files.
- Strict TypeScript — `pnpm lint` (`tsc --noEmit`) must pass with no errors.
- `pnpm build && pnpm test && pnpm lint` must all pass before any commit.
- Vitest is the test runner; tests live under `test/`, mirroring `src/` structure.
- No new runtime dependencies.
- Tests use real temp directories + `createFsAdapter` + real `KarpathyConfigSchema.parse(...)` — never mock vault I/O.
- None of this plan's new production code (`name-variants.ts`, `external-id-extractor.ts`, `person-name-variants.ts`, the new tiers in `entity-resolver.ts`/`entity-merger.ts`, the immediate-detection wiring) makes any LLM call — all of it is pure/deterministic (confirmed in the design's §12 edge-case notes). The try/catch wrappers added in Task 7 around the new immediate-detection calls do not need to special-case `TransientLLMError`, because nothing inside those blocks can throw one; existing `TransientLLMError` propagation elsewhere in the files this plan touches (`compiler.ts`, `link-concepts.ts`) must remain byte-for-byte unchanged.
- `test/bin/intel-tick-exit.test.ts` is a known pre-existing flake in this environment (spawns the real CLI against whatever vault is configured on the host machine, unrelated to this plan) — if it's the only failure in a full `pnpm test` run, treat the run as clean.

## Discrepancies found vs. the design doc (resolved inline in the affected tasks)

- **`src/jobs/handlers/detect-entity-dupes.ts` calls `detectMergeCandidates(context.vault)` without passing `layout`.** `detectMergeCandidates(vault, layout: VaultLayout = DEFAULT_LAYOUT)` therefore silently defaults to `DEFAULT_LAYOUT` (`wiki/entities`, etc.) regardless of the real vault's configured `layout.wiki` (`Curated/wiki` in Tom's live config). Under that production layout, `buildEntityIndex(vault, DEFAULT_LAYOUT)` tries to list `wiki/entities`, which doesn't exist, catches the error, and continues — so `allEntries` stays empty and `detectMergeCandidates` (and therefore the periodic `detect-entity-dupes` job, and this plan's new 4th tier) **finds zero candidates in the real vault today**, silently. This is the exact same class of layout-hardcoding bug B2b fixed twice (`check-confidence-decay.ts`, `agent-synthesize-project.ts`). The existing `detect-entity-dupes.test.ts` suite never caught it because every fixture in that file uses the DEFAULT layout's own `wiki/entities/...` path. `karpathy curator` (`src/bin/karpathy.ts`'s `curatorCommand()`) already correctly calls `detectMergeCandidates(vault, layout)` — only the job handler had the bug. Fixed in Task 6 with a regression test modeled directly on B2b's own precedent for this bug class.
- **`entity-merger.ts` does not currently import `kindToFolder`** (only `wikiContentFolders, DEFAULT_LAYOUT, type VaultLayout` from `../vault/paths.js`), which the design's §5 snippet for the new 4th tier assumes is available. Added in Task 6.
- **The design's §2 architecture overview and its §6 prose contradict each other** on when `findNameVariantCandidatesForNewPage` runs. §2 says `compileFromSource()` calls it "after creating a new person page, **or after merging external_ids into a matched page's frontmatter**." §6's own explicit statement says the opposite: "This component does NOT run for the matched branch — an existing page gaining a new mention isn't a 'new identity' event." Neither §4 nor §6 gives any code for merging `external_ids` into an already-*matched* page in the **rich** pipeline (`compileEntityPage` in `entity-compiler.ts`, called from `compiler.ts`'s matched branch, only ever touches `source_refs`/`updated_at`/protected regions — it has no alias/external-ID frontmatter-merge logic at all, unlike `entity-writer.ts`'s `mergeEntityPage`, which *is* given explicit merge code in §4 but is only ever called from the **simple** path, `link-concepts.ts`). Resolved by following §6's more detailed, doubly-reasoned prose (the same "more precise, doubly-corroborated source wins" rule B2b's own plan used to resolve its analogous contradiction): `findNameVariantCandidatesForNewPage` runs **only** on new-page creation, in both pipelines (Task 7). `external_ids` merging onto an already-*matched* page is implemented only for the simple path's `mergeEntityPage` (Task 3) — the rich path's matched branch does not gain an external-ID merge step, since doing so would require extending `entity-compiler.ts`'s frontmatter-merge surface with no code anywhere in the design to base it on.
- **`RichExtractedEntities`'s person-item Zod schema (`src/enrichment/entity-extractor-rich.ts`) has no `externalIds` field**, and the design's §2 file list never mentions this file. `src/jobs/handlers/compile-entities.ts` casts the deserialized job payload as `entitiesPayload as unknown as RichExtractedEntities` and then reads `person.externalIds` off it — under strict TypeScript this requires the field to exist on the type, not just at runtime. Task 8 adds one additive, defaulted field to the person schema (`externalIds: z.array(z.string()).default([])`) — the LLM never populates it (it isn't in the extraction prompt); it's attached deterministically by `extract-entities.ts` after extraction completes.
- **`findFuzzyMatches` in `entity-resolver.ts` has no `kind` parameter today** (`findFuzzyMatches(name, entries, preferredFolder)`), but the design's G1 requires the new nickname/initials tier to be "scoped to `entity_kind: person` only" and its §4 code snippet never shows how the function would know the kind. Resolved in Task 4 by adding a 4th parameter `kind: EntityKind`, threaded from `resolveEntity`'s existing destructured `kind`, gating the new block on `kind === 'person'`.
- **`karpathy curator`'s "rename" decision does not actually rename anything.** Reading `curatorCommand()` (`src/bin/karpathy.ts` around line 1416–1429): the `answer === 'r'` branch calls the *exact same* `mergeEntities()` function as the plain `answer === 'm'` merge branch, and only additionally records the operator's desired `newName` as metadata on the reconciliation-queue entry via `resolveEntry(vault, entry.id, 'rename', newName, layout)` — which just sets `entry.newName`; nothing ever applies it to `canonical_name` on the page. The design's §7 claims "the existing rename path... already updates `canonical_name`" and asks for "one line" in that handler to also clear `identity_uncertain`. Since both the 'rename' and 'merge' CLI branches call the identical `mergeEntities()` function, and Task 6 already makes `mergeEntities()` unconditionally clear `identity_uncertain` on its target, **this is already fully covered with no `src/bin/karpathy.ts` change needed or possible to correctly attribute to a distinct "rename" code path that doesn't exist.** No change made to `src/bin/karpathy.ts` in this plan.
- **`compileEntityPrompt`'s wikilink instruction is one shared preamble line**, not scattered per-section text: `Use [[wikilinks]] for all entity cross-references.` (`src/enrichment/prompts.ts`). The design calls `prompts.ts` "MODIFIED, minor" without showing code; Task 10 makes exactly this one-line edit rather than touching each per-kind `sectionInstructions` block repeatedly.
- **Confirmed accurate, no discrepancy:** `MergeCandidate` (`sourcePath`, `targetPath`, `sourceName`, `targetName`, `reason`, `confidence`) and `AUTO_MERGE_THRESHOLD = 0.85` are exported from `entity-merger.ts` exactly as the design assumes. `refreshQueue(vault, candidates, layout)`'s signature (`src/maintenance/reconciliation-queue.ts`) matches exactly. `EntityKind = 'person' | 'project' | 'concept' | 'decision' | 'tool' | 'topic' | 'organization'` (`src/vault/paths.ts`) — `'person'` is indeed the literal used everywhere. `kindToFolder(layout, kind)` signature matches. `detectMergeCandidates`'s existing three-tier pairwise loop (Levenshtein+overlap, substring+overlap, alias-match) can have a 4th tier appended cleanly: every existing tier calls `seen.add(pairKey)` when it fires, so gating the new tier on `!seen.has(pairKey)` correctly skips pairs any earlier tier already claimed, without needing to touch the existing three tiers' logic at all.

---

### Task 1: `name-variants.ts` — honorifics, nicknames, initials (foundation)

**Files:**
- Create: `src/ingest/name-variants.ts`
- Test: `test/ingest/name-variants.test.ts` (new file)

**Interfaces:**
- Produces: `stripHonorifics(name): string`, `NICKNAME_GROUPS: string[][]`, `firstNamesEquivalent(a, b): boolean`, `initialsMatch(shortToken, longToken): boolean`, `looksLikeBareHandleOrFirstName(name): boolean` — all consumed by Tasks 3, 4, 5.
- Consumes: nothing (pure, dependency-free — per design §3).

- [ ] **Step 1: Write the failing tests**

Create `test/ingest/name-variants.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  stripHonorifics,
  NICKNAME_GROUPS,
  firstNamesEquivalent,
  initialsMatch,
  looksLikeBareHandleOrFirstName,
} from '../../src/ingest/name-variants.js';

describe('name-variants', () => {
  describe('stripHonorifics', () => {
    it('strips a leading honorific with a period', () => {
      expect(stripHonorifics('Dr. Sarah Chen')).toBe('Sarah Chen');
    });

    it('strips a leading honorific case-insensitively and without a period', () => {
      expect(stripHonorifics('mr John Smith')).toBe('John Smith');
    });

    it('strips every documented trailing suffix form', () => {
      expect(stripHonorifics('Sarah Chen Jr.')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen Sr.')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen PhD')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen MD')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen Esq.')).toBe('Sarah Chen');
    });

    it('strips every documented leading prefix form', () => {
      expect(stripHonorifics('Mrs. Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Ms. Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Miss Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Prof. Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Sir Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Rev. Jane Doe')).toBe('Jane Doe');
    });

    it('is a no-op for a name with no honorific', () => {
      expect(stripHonorifics('Bryan Pino')).toBe('Bryan Pino');
    });
  });

  describe('firstNamesEquivalent', () => {
    it('is true for exact matches', () => {
      expect(firstNamesEquivalent('matt', 'matt')).toBe(true);
    });

    it('is true for documented nickname/spelling-variant group pairs', () => {
      expect(firstNamesEquivalent('matt', 'matthew')).toBe(true);
      expect(firstNamesEquivalent('bryan', 'brian')).toBe(true);
      expect(firstNamesEquivalent('bob', 'robert')).toBe(true);
      expect(firstNamesEquivalent('liz', 'elizabeth')).toBe(true);
    });

    it('is false for names in different groups', () => {
      expect(firstNamesEquivalent('matt', 'mike')).toBe(false);
      expect(firstNamesEquivalent('grig', 'gagik')).toBe(false);
    });

    it('is false for a name not in any group', () => {
      expect(firstNamesEquivalent('zephyr', 'matt')).toBe(false);
    });
  });

  describe('initialsMatch', () => {
    it('matches a bare initial (with or without a trailing period) against the first letter of a longer token', () => {
      expect(initialsMatch('J', 'John')).toBe(true);
      expect(initialsMatch('J.', 'John')).toBe(true);
    });

    it('is false when the letters differ', () => {
      expect(initialsMatch('K', 'John')).toBe(false);
    });

    it('is false for an empty short token', () => {
      expect(initialsMatch('', 'John')).toBe(false);
    });

    it('is false when the "short" token is itself more than one letter', () => {
      expect(initialsMatch('Jo', 'John')).toBe(false);
    });
  });

  describe('looksLikeBareHandleOrFirstName', () => {
    it('is true for a single token (bare first name or handle)', () => {
      expect(looksLikeBareHandleOrFirstName('Bryan')).toBe(true);
      expect(looksLikeBareHandleOrFirstName('pvaughn')).toBe(true);
    });

    it('is false for a multi-token "First Last" name', () => {
      expect(looksLikeBareHandleOrFirstName('Bryan Pino')).toBe(false);
    });

    it('is false for an empty or whitespace-only string', () => {
      expect(looksLikeBareHandleOrFirstName('')).toBe(false);
      expect(looksLikeBareHandleOrFirstName('   ')).toBe(false);
    });
  });

  it('NICKNAME_GROUPS is exported for config-driven extension (enrichment.personResolution.extraNicknameGroups)', () => {
    expect(NICKNAME_GROUPS.some((g) => g.includes('bryan') && g.includes('brian'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/ingest/name-variants.test.ts`
Expected: FAIL — `src/ingest/name-variants.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/ingest/name-variants.ts` (verbatim per design §3 — self-contained, no imports):

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/ingest/name-variants.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingest/name-variants.ts test/ingest/name-variants.test.ts
git commit -m "feat(ingest): add name-variants honorific/nickname/initials heuristics"
```

---

### Task 2: Config schema — `enrichment.personResolution`

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config/schema.test.ts` (extend existing file)

**Interfaces:**
- Produces: `PersonResolutionConfigSchema` (exported Zod schema), `KarpathyConfig['enrichment']['personResolution']: { enabled: boolean; externalIdCaptureEnabled: boolean; nicknameMatchingEnabled: boolean; extraNicknameGroups: string[][] }` — consumed by the gate check in Task 7.

- [ ] **Step 1: Write the failing test**

Add to `test/config/schema.test.ts`, a new `describe` block after the existing `'KarpathyConfigSchema — intelligence.richness'` block:

```typescript
describe('KarpathyConfigSchema — enrichment.personResolution', () => {
  it('defaults enrichment.personResolution when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.enrichment.personResolution).toEqual({
      enabled: true,
      externalIdCaptureEnabled: true,
      nicknameMatchingEnabled: true,
      extraNicknameGroups: [],
    });
  });

  it('allows overriding enabled and supplying extraNicknameGroups', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      enrichment: {
        personResolution: { enabled: false, extraNicknameGroups: [['grig', 'grigor']] },
      },
    });
    expect(config.enrichment.personResolution.enabled).toBe(false);
    expect(config.enrichment.personResolution.extraNicknameGroups).toEqual([['grig', 'grigor']]);
    // Other fields still default
    expect(config.enrichment.personResolution.externalIdCaptureEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: FAIL — `config.enrichment.personResolution` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schema.ts`, add the new schema right before `EnrichmentConfigSchema`:

```typescript
/**
 * B2c: person name resolution. Gates external-ID capture (Component 0),
 * nickname/honorific/initials fuzzy-match extensions (Component 1), and the
 * immediate name-variant detection check on new-page creation (Component 3).
 */
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

Then in `EnrichmentConfigSchema`, add `personResolution` after `significanceGateDropConfidence`:

```typescript
export const EnrichmentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxChunkSize: z.number().int().positive().default(12000),
  chunkOverlap: z.number().int().nonnegative().default(1000),
  autoCreateEntities: z.boolean().default(true),
  autoMergeEntities: z.boolean().default(true),
  contradictionDetection: z.boolean().default(false),
  entityBlocklist: z.array(z.string()).default([]),
  minEntityConfidence: z.number().min(0).max(1).default(0.3),
  /** D4: Significance gate — `off` legacy behaviour, `heuristic` (cheap), or `llm` (Bedrock-backed). */
  significanceGate: z.enum(['off', 'heuristic', 'llm']).default('llm'),
  /** Below this confidence, an LLM "drop" verdict creates the page anyway and flags it for review instead of silently discarding it. */
  significanceGateDropConfidence: z.number().min(0).max(1).default(0.7),
  personResolution: PersonResolutionConfigSchema.default({}),
});
```

No other changes are needed: `PartialEnrichmentConfigSchema = EnrichmentConfigSchema.partial()` (already present) picks up the new field automatically, and `ProjectOverrideSchema`/`GlobalDefaultsSchema` already reference it generically — same precedent as `intelligence.richness` (B2b). No `loader.ts` changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "feat(config): add enrichment.personResolution schema"
```

---

### Task 3: External-ID capture — extractor, frontmatter fields, entity-writer

**Files:**
- Create: `src/ingest/external-id-extractor.ts`
- Modify: `src/vault/frontmatter.ts`
- Modify: `src/ingest/entity-writer.ts`
- Test: `test/ingest/external-id-extractor.test.ts` (new file)
- Test: `test/vault/frontmatter.test.ts` (extend existing file)
- Test: `test/ingest/entity-writer.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `looksLikeBareHandleOrFirstName` from Task 1 (`src/ingest/name-variants.js`).
- Produces: `extractSlackHandleIds(rawText): Map<string, string>`; `EntitySchema` gains `external_ids`/`identity_uncertain`; `ExtractedEntityInfo` gains `externalIds?: string[]`; `buildFrontmatter`'s person case writes both new fields; `mergeEntityPage` unions `external_ids`. Consumed by Tasks 4 (resolver reads `external_ids` via the index), 7 (immediate-detection wiring reads `identity_uncertain` indirectly via bare-name check), 8 (payload threading), 9 (rot-scan reads `identity_uncertain`).

- [ ] **Step 1: Write the failing tests**

Create `test/ingest/external-id-extractor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractSlackHandleIds } from '../../src/ingest/external-id-extractor.js';

// Reproduced verbatim from the real vault finding (B2c design §0.1):
// raw/2026-05-15/Directors Squad Offsite - Jan 2025.md
const REAL_FIXTURE = `
* [@pino](https://adobe.enterprise.slack.com/team/U01FZCB8X29)
Ownership: PM, PMM ([@pvaughn](https://adobe.enterprise.slack.com/team/U08C58CF45A))
Ownership: Eng, UX ([@brownf](https://adobe.enterprise.slack.com/team/U01MCKEDYAH))
Ownership: PgM ([@mewing](https://adobe.enterprise.slack.com/team/W5S3UAN8M))
`;

describe('extractSlackHandleIds', () => {
  it('extracts all four handle -> ID pairs from the real vault fixture', () => {
    const map = extractSlackHandleIds(REAL_FIXTURE);
    expect(map.get('pino')).toBe('slack:U01FZCB8X29');
    expect(map.get('pvaughn')).toBe('slack:U08C58CF45A');
    expect(map.get('brownf')).toBe('slack:U01MCKEDYAH');
    expect(map.get('mewing')).toBe('slack:W5S3UAN8M');
    expect(map.size).toBe(4);
  });

  it('ignores a non-Slack markdown link', () => {
    const map = extractSlackHandleIds('[@someone](https://example.com/team/U01FZCB8X29)');
    expect(map.size).toBe(0);
  });

  it('ignores a Slack link with a malformed/too-short ID', () => {
    const map = extractSlackHandleIds('[@x](https://foo.slack.com/team/U01)');
    expect(map.size).toBe(0);
  });

  it('keeps the first ID seen for a duplicate handle', () => {
    const text = '[@pino](https://foo.slack.com/team/U01FZCB8X29) ... [@pino](https://foo.slack.com/team/U0OTHERID1)';
    const map = extractSlackHandleIds(text);
    expect(map.get('pino')).toBe('slack:U01FZCB8X29');
  });

  it('lowercases the handle key', () => {
    const map = extractSlackHandleIds('[@Pino](https://foo.slack.com/team/U01FZCB8X29)');
    expect(map.has('pino')).toBe(true);
  });

  it('returns an empty map for text with no Slack links', () => {
    expect(extractSlackHandleIds('Just some plain text.').size).toBe(0);
  });
});
```

Add to `test/vault/frontmatter.test.ts`, inside the existing `describe('type-specific schemas', ...)` block, right after the existing `it('validates entity', ...)` test:

```typescript
  it('defaults external_ids and identity_uncertain on entity when omitted', () => {
    const result = EntitySchema.parse({
      id: 'ent-2',
      type: 'entity',
      title: 'Bryan',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      entity_kind: 'person',
      canonical_name: 'Bryan',
    });
    expect(result.external_ids).toEqual([]);
    expect(result.identity_uncertain).toBe(false);
  });

  it('accepts explicit external_ids and identity_uncertain on entity', () => {
    const result = EntitySchema.parse({
      id: 'ent-3',
      type: 'entity',
      title: 'Bryan',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      entity_kind: 'person',
      canonical_name: 'Bryan',
      external_ids: ['slack:U01FZCB8X29'],
      identity_uncertain: true,
    });
    expect(result.external_ids).toEqual(['slack:U01FZCB8X29']);
    expect(result.identity_uncertain).toBe(true);
  });
```

Add to `test/ingest/entity-writer.test.ts`, inside the existing `describe('createEntityPage', ...)` block, right after the existing `'creates a person page'` test:

```typescript
    it('sets identity_uncertain=true and stores external_ids for a bare-named person', async () => {
      const info: ExtractedEntityInfo = {
        name: 'Bryan',
        kind: 'person',
        chunkRefs: [],
        externalIds: ['slack:U01FZCB8X29'],
      };
      const resolution: EntityResolution = {
        entityName: 'Bryan',
        entityKind: 'person',
        status: 'new',
        suggestedPath: 'wiki/entities/bryan.md',
        confidence: 0,
      };

      const path = await createEntityPage(vault, resolution, info, 'outputs/source-summaries/offsite.md');
      const { data } = parseNote(await vault.read(path));

      expect(data.identity_uncertain).toBe(true);
      expect(data.external_ids).toEqual(['slack:U01FZCB8X29']);
    });

    it('sets identity_uncertain=false for a "First Last" person and defaults external_ids to []', async () => {
      const info: ExtractedEntityInfo = {
        name: 'Bryan Pino',
        kind: 'person',
        chunkRefs: [],
      };
      const resolution: EntityResolution = {
        entityName: 'Bryan Pino',
        entityKind: 'person',
        status: 'new',
        suggestedPath: 'wiki/entities/bryan-pino.md',
        confidence: 0,
      };

      const path = await createEntityPage(vault, resolution, info, 'outputs/source-summaries/offsite.md');
      const { data } = parseNote(await vault.read(path));

      expect(data.identity_uncertain).toBe(false);
      expect(data.external_ids).toEqual([]);
    });
```

Add inside the existing `describe('mergeEntityPage', ...)` block, right after the existing `'adds alias for new name variant'` test:

```typescript
    it('unions external_ids without duplication across two calls with overlapping IDs', async () => {
      const path = await createTestEntityPage();

      const first = await mergeEntityPage(
        vault, path,
        { name: 'Alice', kind: 'person', context: 'first mention', chunkRefs: [], externalIds: ['slack:U1', 'slack:U2'] },
        'outputs/source-summaries/a.md',
      );
      expect(first.fieldsUpdated).toContain('external_ids');

      const second = await mergeEntityPage(
        vault, path,
        { name: 'Alice', kind: 'person', context: 'second mention', chunkRefs: [], externalIds: ['slack:U2', 'slack:U3'] },
        'outputs/source-summaries/b.md',
      );
      expect(second.fieldsUpdated).toContain('external_ids');

      const { data } = parseNote(await vault.read(path));
      expect((data.external_ids as string[]).sort()).toEqual(['slack:U1', 'slack:U2', 'slack:U3']);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/ingest/external-id-extractor.test.ts test/vault/frontmatter.test.ts test/ingest/entity-writer.test.ts`
Expected: FAIL — `external-id-extractor.js` doesn't exist; `EntitySchema.parse` strips unknown `external_ids`/`identity_uncertain` keys (Zod object schemas without `.passthrough()` drop unrecognized fields, so `result.external_ids` is `undefined`, not `[]`); `createEntityPage`/`mergeEntityPage` don't yet read/write these fields.

- [ ] **Step 3: Write minimal implementation**

Create `src/ingest/external-id-extractor.ts`:

```typescript
const SLACK_LINK_RE = /\[@([\w.-]+)\]\(https?:\/\/[\w.-]+\.slack\.com\/team\/([A-Z0-9]{6,})\)/g;

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

In `src/vault/frontmatter.ts`, change:

```typescript
export const EntitySchema = BaseFrontmatterSchema.extend({
  type: z.literal('entity'),
  entity_kind: z.string(),
  canonical_name: z.string(),
});
```

to:

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

In `src/ingest/entity-writer.ts`, add the import (after the existing `import { getOrCreateProjectHub } from '../compilation/project-hub.js';` line):

```typescript
import { looksLikeBareHandleOrFirstName } from './name-variants.js';
```

Change `ExtractedEntityInfo`:

```typescript
export interface ExtractedEntityInfo {
  name: string;
  kind: EntityKind;
  role?: string;
  context?: string;
  definition?: string;
  status?: string;
  chunkRefs: string[];
}
```

to:

```typescript
export interface ExtractedEntityInfo {
  name: string;
  kind: EntityKind;
  role?: string;
  context?: string;
  definition?: string;
  status?: string;
  chunkRefs: string[];
  externalIds?: string[];
}
```

Change `buildFrontmatter`'s `case 'person':` branch:

```typescript
    case 'person':
      return {
        ...base,
        type: 'entity',
        entity_kind: 'person',
        canonical_name: info.name,
        protected_regions: ['summary', 'projects', 'topics', 'timeline', 'sources', 'backlinks'],
      };
```

to:

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

In `mergeEntityPage`, insert right after the existing aliases-merge block (`target.data.aliases = ...` — actually this function operates on `data`/`aliases` directly, not `target.data`; insert after the block that ends `data.aliases = aliases; fieldsUpdated.push('aliases'); }` and before `// Append to mentions/timeline region`):

```typescript
  // Merge external_ids (deduped) — B2c Component 0.
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/ingest/external-id-extractor.test.ts test/vault/frontmatter.test.ts test/ingest/entity-writer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingest/external-id-extractor.ts src/vault/frontmatter.ts src/ingest/entity-writer.ts test/ingest/external-id-extractor.test.ts test/vault/frontmatter.test.ts test/ingest/entity-writer.test.ts
git commit -m "feat(ingest): capture Slack external IDs; add external_ids/identity_uncertain to EntitySchema"
```

---

### Task 4: `entity-resolver.ts` — external-ID tier 0, honorific stripping, nickname/initials fuzzy tier

**Files:**
- Modify: `src/ingest/entity-resolver.ts`
- Test: `test/ingest/entity-resolver.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `stripHonorifics`, `firstNamesEquivalent`, `initialsMatch` from Task 1 (`src/ingest/name-variants.js`); reads `external_ids` frontmatter (schema from Task 3, but read generically via `data.external_ids as string[]`, so no hard dependency on Task 3 landing first).
- Produces: `EntityIndex` gains `byExternalId: Map<string, string>`; `resolveEntity`'s `entity` param gains optional `externalIds?: string[]`. Consumed by Task 8 (call-site wiring) and used directly by Task 5/6's tests indirectly via `buildEntityIndex`.

- [ ] **Step 1: Write the failing tests**

Add to `test/ingest/entity-resolver.test.ts`, a new `describe` block after the existing `describe('buildEntityIndex', ...)` block's closing, but still inside the outer `describe('entity-resolver', ...)`:

```typescript
  describe('resolveEntity — external-ID tier (B2c)', () => {
    it('matches via external_ids even when the incoming name differs entirely from the page canonical_name', async () => {
      await createEntityFile('wiki/entities/pino.md', {
        id: 'e1', title: 'pino', canonical_name: 'pino', entity_kind: 'person',
        type: 'entity', aliases: [], external_ids: ['slack:U01FZCB8X29'],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      const resolution = resolveEntity(
        { name: 'Frank Brown', kind: 'person', externalIds: ['slack:U01FZCB8X29'] },
        index,
      );

      expect(resolution.status).toBe('matched');
      expect(resolution.matchedPath).toBe('wiki/entities/pino.md');
      expect(resolution.confidence).toBe(1.0);
    });

    it('falls through to name-based tiers when externalIds is omitted or has no match', async () => {
      await createEntityFile('wiki/entities/pino.md', {
        id: 'e1', title: 'pino', canonical_name: 'pino', entity_kind: 'person',
        type: 'entity', aliases: [], external_ids: ['slack:U01FZCB8X29'],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      const resolution = resolveEntity({ name: 'pino', kind: 'person' }, index);
      expect(resolution.status).toBe('matched');
      expect(resolution.matchedPath).toBe('wiki/entities/pino.md');
      expect(resolution.confidence).toBe(1.0); // exact slug match, tier 1 — not tier 0
    });
  });

  describe('resolveEntity — honorific stripping (B2c)', () => {
    it('matches an existing page by slug after stripping a leading honorific', async () => {
      await createEntityFile('wiki/entities/sarah-chen.md', {
        id: 'e1', title: 'Sarah Chen', canonical_name: 'Sarah Chen', entity_kind: 'person',
        type: 'entity', aliases: [],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      const resolution = resolveEntity({ name: 'Dr. Sarah Chen', kind: 'person' }, index);
      expect(resolution.status).toBe('matched');
      expect(resolution.matchedPath).toBe('wiki/entities/sarah-chen.md');
      // entityName reports the original mention, not the stripped form.
      expect(resolution.entityName).toBe('Dr. Sarah Chen');
    });

    it('does not strip honorifics for non-person kinds', async () => {
      await createEntityFile('wiki/projects/dr-strange-project.md', {
        id: 'p1', title: 'Dr Strange Project', canonical_name: 'Dr Strange Project',
        type: 'project', project_key: 'dr-strange-project', aliases: [],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      // "Dr Strange Project" as a *project* name must not have "Dr" stripped.
      const resolution = resolveEntity({ name: 'Dr Strange Project', kind: 'project' }, index);
      expect(resolution.status).toBe('matched');
      expect(resolution.matchedPath).toBe('wiki/projects/dr-strange-project.md');
    });
  });

  describe('resolveEntity — nickname/initials fuzzy tier (B2c, person-only)', () => {
    it('resolves a nickname + matching surname to a single existing page', async () => {
      await createEntityFile('wiki/entities/matthew-newman.md', {
        id: 'e1', title: 'Matthew Newman', canonical_name: 'Matthew Newman', entity_kind: 'person',
        type: 'entity', aliases: [],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      const resolution = resolveEntity({ name: 'Matt Newman', kind: 'person' }, index);
      expect(resolution.status).toBe('matched');
      expect(resolution.matchedPath).toBe('wiki/entities/matthew-newman.md');
      expect(resolution.confidence).toBe(0.8);
    });

    it('resolves ambiguous when two candidates both satisfy the nickname+near-surname tier', async () => {
      await createEntityFile('wiki/entities/matthew-newman.md', {
        id: 'e1', title: 'Matthew Newman', canonical_name: 'Matthew Newman', entity_kind: 'person',
        type: 'entity', aliases: [],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      await createEntityFile('wiki/entities/matthew-newby.md', {
        id: 'e2', title: 'Matthew Newby', canonical_name: 'Matthew Newby', entity_kind: 'person',
        type: 'entity', aliases: [],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      const resolution = resolveEntity({ name: 'Matt Newman', kind: 'person' }, index);
      expect(resolution.status).toBe('ambiguous');
      expect(resolution.candidates?.map((c) => c.path).sort()).toEqual([
        'wiki/entities/matthew-newby.md',
        'wiki/entities/matthew-newman.md',
      ]);
    });

    it('does not apply the nickname tier to non-person kinds', async () => {
      await createEntityFile('wiki/concepts/matthew-effect.md', {
        id: 'c1', title: 'Matthew Effect', canonical_name: 'Matthew Effect',
        type: 'concept', aliases: [],
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      });
      const index = await buildEntityIndex(vault);

      const resolution = resolveEntity({ name: 'Matt Effect', kind: 'concept' }, index);
      expect(resolution.status).toBe('new');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/ingest/entity-resolver.test.ts`
Expected: FAIL — `EntityIndex` has no `byExternalId`; `resolveEntity` rejects (TS) or ignores `externalIds`; honorific stripping and the nickname/initials tier don't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `src/ingest/entity-resolver.ts`, add the import (after the existing `createLogger` import):

```typescript
import { stripHonorifics, firstNamesEquivalent, initialsMatch } from './name-variants.js';
```

Change `EntityIndex`:

```typescript
export interface EntityIndex {
  bySlug: Map<string, string>;
  byCanonicalName: Map<string, string>;
  byAlias: Map<string, string>;
  allEntries: EntityIndexEntry[];
}
```

to:

```typescript
export interface EntityIndex {
  bySlug: Map<string, string>;
  byCanonicalName: Map<string, string>;
  byAlias: Map<string, string>;
  byExternalId: Map<string, string>;
  allEntries: EntityIndexEntry[];
}
```

In `buildEntityIndex`, change:

```typescript
  const bySlug = new Map<string, string>();
  const byCanonicalName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const allEntries: EntityIndexEntry[] = [];
```

to:

```typescript
  const bySlug = new Map<string, string>();
  const byCanonicalName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const byExternalId = new Map<string, string>();
  const allEntries: EntityIndexEntry[] = [];
```

and change:

```typescript
        for (const alias of aliases) {
          byAlias.set(normalizeName(alias), filePath);
        }
        allEntries.push({ name: canonicalName || fileName, path: filePath, aliases, slug });
```

to:

```typescript
        for (const alias of aliases) {
          byAlias.set(normalizeName(alias), filePath);
        }
        const externalIds = (data.external_ids as string[]) ?? [];
        for (const externalId of externalIds) {
          byExternalId.set(externalId, filePath);
        }
        allEntries.push({ name: canonicalName || fileName, path: filePath, aliases, slug });
```

and change the return statement:

```typescript
  return { bySlug, byCanonicalName, byAlias, allEntries };
```

to:

```typescript
  return { bySlug, byCanonicalName, byAlias, byExternalId, allEntries };
```

Change `resolveEntity`'s signature and opening lines:

```typescript
export function resolveEntity(
  entity: { name: string; kind: EntityKind },
  index: EntityIndex,
  layout: VaultLayout = DEFAULT_LAYOUT,
): EntityResolution {
  const { name, kind } = entity;
  const normalized = normalizeName(name);
  const slug = slugify(name);
  const folder = kindToFolder(layout, kind);
```

to:

```typescript
export function resolveEntity(
  entity: { name: string; kind: EntityKind; externalIds?: string[] },
  index: EntityIndex,
  layout: VaultLayout = DEFAULT_LAYOUT,
): EntityResolution {
  // Tier 0 (highest priority): exact external-ID match. Definitionally
  // certain — no fuzziness, no honorific stripping needed.
  for (const id of entity.externalIds ?? []) {
    const match = index.byExternalId.get(id);
    if (match) {
      return {
        entityName: entity.name,
        entityKind: entity.kind,
        status: 'matched',
        matchedPath: match,
        confidence: 1.0,
      };
    }
  }

  const { name, kind } = entity;
  const normalizedInput = kind === 'person' ? stripHonorifics(name) : name;
  const normalized = normalizeName(normalizedInput);
  const slug = slugify(normalizedInput);
  const folder = kindToFolder(layout, kind);
```

(Tiers 1–4 and 6 are otherwise unchanged — they already operate on `normalized`/`slug`, which now derive from the honorific-stripped input.)

Change tier 5's call site:

```typescript
  // 5. Fuzzy matching
  const fuzzyMatches = findFuzzyMatches(name, index.allEntries, folder);
```

to:

```typescript
  // 5. Fuzzy matching
  const fuzzyMatches = findFuzzyMatches(normalizedInput, index.allEntries, folder, kind);
```

Change `findFuzzyMatches` itself — add the `kind` parameter and the new person-only tier between the Levenshtein block and the alias-check loop:

```typescript
function findFuzzyMatches(
  name: string,
  entries: EntityIndexEntry[],
  preferredFolder: string,
): Array<{ path: string; confidence: number }> {
```

to:

```typescript
function findFuzzyMatches(
  name: string,
  entries: EntityIndexEntry[],
  preferredFolder: string,
  kind: EntityKind,
): Array<{ path: string; confidence: number }> {
```

and insert, right after the existing Levenshtein-distance block (`if (dist > 0 && dist <= maxDist) { ... continue; }`) and before `// Also check aliases`:

```typescript
    // B2c: same/near-identical surname + nickname/initials-equivalent first
    // name — person-only. Extends this same matched/ambiguous tier (no new
    // risk class; a nickname-based single match auto-resolves exactly as a
    // misspelling-based single match already does above).
    if (kind === 'person') {
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
    }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/ingest/entity-resolver.test.ts`
Expected: PASS — including all pre-existing tests in this file (regression: no honorific in the name, no `externalIds` passed, kinds other than `person` — byte-for-byte unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/entity-resolver.ts test/ingest/entity-resolver.test.ts
git commit -m "feat(ingest): add external-ID resolution tier and honorific/nickname/initials matching for persons"
```

---

### Task 5: `person-name-variants.ts` — overlap-free scoring + immediate-detection helper

**Files:**
- Create: `src/compilation/person-name-variants.ts`
- Test: `test/compilation/person-name-variants.test.ts` (new file)

**Interfaces:**
- Consumes: `normalizeName`, `levenshtein` from `src/ingest/entity-resolver.js` (both already exported, confirmed); `stripHonorifics`, `firstNamesEquivalent`, `initialsMatch` from Task 1 (`src/ingest/name-variants.js`); `type { EntityIndex }` from `src/ingest/entity-resolver.js`; `kindToFolder`, `type VaultLayout` from `src/vault/paths.js`; `type { MergeCandidate }` from `./entity-merger.js` — **type-only import**, so no runtime circular-dependency issue even though Task 6 will make `entity-merger.ts` import back from this file.
- Produces: `personNameVariantScore(nameA, aliasesA, nameB, aliasesB): NameVariantMatch | null`, `findNameVariantCandidatesForNewPage(index, layout, newEntry): MergeCandidate[]`. Consumed by Task 6 (`detectMergeCandidates`'s 4th tier) and Task 7 (immediate-detection wiring).

- [ ] **Step 1: Write the failing tests**

Create `test/compilation/person-name-variants.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  personNameVariantScore,
  findNameVariantCandidatesForNewPage,
} from '../../src/compilation/person-name-variants.js';
import type { EntityIndex } from '../../src/ingest/entity-resolver.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';

describe('personNameVariantScore', () => {
  it('scores the real Bryan/Pino case (substring tier, confidence 0.5)', () => {
    const result = personNameVariantScore('Bryan', [], 'Bryan Pino', ['pino']);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.5);
  });

  it('scores a nickname + matching surname (confidence 0.65)', () => {
    const result = personNameVariantScore('Matt Newman', [], 'Matthew Newman', []);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.65);
  });

  it('returns null for two genuinely different people (Grig vs Kevin Bement, from the real vault)', () => {
    expect(personNameVariantScore('Grig', [], 'Kevin Bement', [])).toBeNull();
  });

  it('returns null for two different bare handles (no containment, no surname to compare)', () => {
    expect(personNameVariantScore('brownf', [], 'bwhite', [])).toBeNull();
  });

  it('returns null for an exact-name match (handled upstream by resolveEntity)', () => {
    expect(personNameVariantScore('Bryan Pino', [], 'Bryan Pino', [])).toBeNull();
  });

  it('every non-null result is below AUTO_MERGE_THRESHOLD (0.85)', () => {
    const r1 = personNameVariantScore('Bryan', [], 'Bryan Pino', []);
    const r2 = personNameVariantScore('Matt Newman', [], 'Matthew Newman', []);
    expect(r1!.confidence).toBeLessThan(0.85);
    expect(r2!.confidence).toBeLessThan(0.85);
  });
});

describe('findNameVariantCandidatesForNewPage', () => {
  function makeIndex(entries: Array<{ name: string; path: string; aliases: string[] }>): EntityIndex {
    return {
      bySlug: new Map(),
      byCanonicalName: new Map(),
      byAlias: new Map(),
      byExternalId: new Map(),
      allEntries: entries.map((e) => ({ ...e, slug: e.name.toLowerCase() })),
    };
  }

  it('finds exactly one candidate against an existing fuller-named page', () => {
    const index = makeIndex([
      { name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'] },
    ]);

    const candidates = findNameVariantCandidatesForNewPage(index, DEFAULT_LAYOUT, {
      name: 'Bryan', path: 'wiki/entities/bryan.md', aliases: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourcePath).toBe('wiki/entities/bryan.md');
    expect(candidates[0].targetPath).toBe('wiki/entities/bryan-pino.md');
  });

  it('finds zero candidates when no plausible match exists', () => {
    const index = makeIndex([
      { name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'] },
    ]);

    const candidates = findNameVariantCandidatesForNewPage(index, DEFAULT_LAYOUT, {
      name: 'Zzyzx', path: 'wiki/entities/zzyzx.md', aliases: [],
    });

    expect(candidates).toHaveLength(0);
  });

  it('excludes the new page itself and skips non-person folders', () => {
    const index = makeIndex([
      { name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'] },
      { name: 'Bryan', path: 'wiki/concepts/bryan.md', aliases: [] }, // not a person page
    ]);

    const candidates = findNameVariantCandidatesForNewPage(index, DEFAULT_LAYOUT, {
      name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'], // itself
    });

    expect(candidates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/compilation/person-name-variants.test.ts`
Expected: FAIL — `src/compilation/person-name-variants.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/compilation/person-name-variants.ts` (verbatim per design §5/§6, combined into one file as the design specifies):

```typescript
import { normalizeName, levenshtein } from '../ingest/entity-resolver.js';
import { stripHonorifics, firstNamesEquivalent, initialsMatch } from '../ingest/name-variants.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { kindToFolder, type VaultLayout } from '../vault/paths.js';
import type { MergeCandidate } from './entity-merger.js';

export interface NameVariantMatch {
  confidence: number;
  reason: string;
}

/**
 * Pure, vault-I/O-free scoring function. No shared-source-reference
 * requirement (that's the entire point — see B2c design §0.1's Bryan/Pino
 * evidence). Always returns a confidence well below AUTO_MERGE_THRESHOLD
 * (0.85); every result of this function is destined for the human-reviewed
 * reconciliation queue, never an automatic merge.
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

/**
 * O(n) check of a single freshly-created person page against every existing
 * person page already in a pre-built EntityIndex. Used at ingest time so a
 * same-day bare-name mention gets a same-day reconciliation-queue entry,
 * rather than waiting for the next scheduled detect-entity-dupes sweep.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/compilation/person-name-variants.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/compilation/person-name-variants.ts test/compilation/person-name-variants.test.ts
git commit -m "feat(compilation): add person-name-variant scoring and new-page candidate detection"
```

---

### Task 6: `entity-merger.ts` — 4th detectMergeCandidates tier, mergeEntities extension, detect-entity-dupes layout fix

**Files:**
- Modify: `src/compilation/entity-merger.ts`
- Modify: `src/jobs/handlers/detect-entity-dupes.ts` (real pre-existing layout bug — see Discrepancies)
- Test: `test/compilation/entity-merger.test.ts` (extend existing file)
- Test: `test/jobs/handlers/detect-entity-dupes.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `personNameVariantScore` from Task 5 (`src/compilation/person-name-variants.js`); `kindToFolder` from `src/vault/paths.js` (newly imported into this file).
- Produces: no new exports — `detectMergeCandidates` and `mergeEntities` keep their existing signatures; only their internal behavior changes.

- [ ] **Step 1: Write the failing tests**

Add to `test/compilation/entity-merger.test.ts`, a new `describe` block:

```typescript
import { detectMergeCandidates, AUTO_MERGE_THRESHOLD } from '../../src/compilation/entity-merger.js';
import { serializeNote, parseNote } from '../../src/vault/frontmatter.js';

describe('mergeEntities — external_ids and identity_uncertain (B2c)', () => {
  it('unions external_ids and clears identity_uncertain on the target regardless of prior state', async () => {
    const tempDir2 = await (await import('node:fs/promises')).mkdtemp(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'karpathy-merger-b2c-'),
    );
    const vault2 = createFsAdapter(tempDir2);
    await vault2.ensureFolder('wiki/entities');
    await vault2.atomicWrite(
      'wiki/entities/bryan.md',
      serializeNote(
        { canonical_name: 'Bryan', external_ids: ['slack:U01FZCB8X29'], identity_uncertain: true, aliases: [] },
        'Body.',
      ),
    );
    await vault2.atomicWrite(
      'wiki/entities/bryan-pino.md',
      serializeNote(
        { canonical_name: 'Bryan Pino', external_ids: [], identity_uncertain: false, aliases: ['pino'] },
        'Body.',
      ),
    );

    const { mergeEntities } = await import('../../src/compilation/entity-merger.js');
    await mergeEntities('wiki/entities/bryan.md', 'wiki/entities/bryan-pino.md', vault2);

    const { data } = parseNote(await vault2.read('wiki/entities/bryan-pino.md'));
    expect(data.external_ids).toEqual(['slack:U01FZCB8X29']);
    expect(data.identity_uncertain).toBe(false);

    await (await import('node:fs/promises')).rm(tempDir2, { recursive: true, force: true });
  });
});

describe('detectMergeCandidates — person name-variant tier (B2c)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-merger-tier4-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/entities');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects a person pair with zero shared source_refs (the Bryan/Pino regression fixture)', async () => {
    await vault.atomicWrite(
      'wiki/entities/bryan.md',
      serializeNote(
        { canonical_name: 'Bryan', aliases: [], source_refs: ['outputs/source-summaries/doc-a.md'] },
        'Body.',
      ),
    );
    await vault.atomicWrite(
      'wiki/entities/bryan-pino.md',
      serializeNote(
        { canonical_name: 'Bryan Pino', aliases: ['pino'], source_refs: ['outputs/source-summaries/doc-b.md'] },
        'Body.',
      ),
    );

    const candidates = await detectMergeCandidates(vault);
    const found = candidates.find(
      (c) => [c.sourceName, c.targetName].includes('Bryan') && [c.sourceName, c.targetName].includes('Bryan Pino'),
    );
    expect(found).toBeDefined();
    expect(found!.confidence).toBeLessThan(AUTO_MERGE_THRESHOLD);
  });

  it('does not detect a same-shaped pair for a non-person kind (person-only scope)', async () => {
    await vault.ensureFolder('wiki/concepts');
    await vault.atomicWrite(
      'wiki/concepts/bryan.md',
      serializeNote({ canonical_name: 'Bryan', aliases: [], source_refs: ['outputs/source-summaries/doc-a.md'] }, 'Body.'),
    );
    await vault.atomicWrite(
      'wiki/concepts/bryan-pino.md',
      serializeNote({ canonical_name: 'Bryan Pino', aliases: [], source_refs: ['outputs/source-summaries/doc-b.md'] }, 'Body.'),
    );

    const candidates = await detectMergeCandidates(vault);
    expect(candidates).toHaveLength(0);
  });
});
```

Add to `test/jobs/handlers/detect-entity-dupes.test.ts`, a new test after the existing `'queues candidates below the auto-merge threshold instead of merging them'` test:

```typescript
  it('finds person name-variant candidates under a non-default layout.wiki (regression for the missing-layout-arg bug)', async () => {
    // Regression for a real pre-existing bug: detectEntityDupesHandler used to
    // call detectMergeCandidates(context.vault) without a layout argument, so
    // it always scanned DEFAULT_LAYOUT's wiki/entities regardless of the
    // configured layout.wiki — under Curated/wiki (the real vault's layout),
    // that folder doesn't exist, so zero candidates were ever found.
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, layout: { wiki: 'Curated/wiki' } });
    await vault.ensureFolder('Curated/wiki/entities');
    const fmBryan = {
      id: 'b1', type: 'entity', entity_kind: 'person', canonical_name: 'Bryan', title: 'Bryan',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      source_refs: ['outputs/source-summaries/doc-a.md'], aliases: [],
    };
    const fmBryanPino = {
      id: 'b2', type: 'entity', entity_kind: 'person', canonical_name: 'Bryan Pino', title: 'Bryan Pino',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      source_refs: ['outputs/source-summaries/doc-b.md'], aliases: ['pino'],
    };
    await vault.create('Curated/wiki/entities/bryan.md', serializeNote(fmBryan, ''));
    await vault.create('Curated/wiki/entities/bryan-pino.md', serializeNote(fmBryanPino, ''));

    const ctx: JobContext = {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: {} as never,
      config,
    };

    await detectEntityDupesHandler.execute(makeJob(), ctx);

    const queue = await readReconciliationQueue(vault, config.layout);
    const found = queue.entries.find(
      (e) => [e.sourceName, e.targetName].includes('Bryan') && [e.sourceName, e.targetName].includes('Bryan Pino'),
    );
    expect(found).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/compilation/entity-merger.test.ts test/jobs/handlers/detect-entity-dupes.test.ts`
Expected: FAIL — `mergeEntities` doesn't touch `external_ids`/`identity_uncertain`; `detectMergeCandidates` has no 4th tier; the `detect-entity-dupes` regression test finds zero queue entries under `Curated/wiki` because of the missing `layout` argument.

- [ ] **Step 3: Write minimal implementation**

In `src/compilation/entity-merger.ts`, change the import:

```typescript
import { wikiContentFolders, DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
```

to:

```typescript
import { wikiContentFolders, kindToFolder, DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
```

and add, right after the `normalizeName, levenshtein, buildEntityIndex` import:

```typescript
import { personNameVariantScore } from './person-name-variants.js';
```

In `mergeEntities`, insert right after the existing aliases-merge block and before `// links`:

```typescript
  target.data.aliases = [
    ...((target.data.aliases as string[]) ?? []),
    ...aliasesAdded,
  ];

  // B2c: union external_ids (deduped) and clear identity_uncertain — a merge
  // means the identity is now better-established than either page alone,
  // regardless of the target's own prior identity_uncertain state.
  const targetExternalIds = new Set((target.data.external_ids as string[]) ?? []);
  for (const id of (source.data.external_ids as string[]) ?? []) {
    targetExternalIds.add(id);
  }
  target.data.external_ids = [...targetExternalIds];
  target.data.identity_uncertain = false;

  // links
  const targetLinks = new Set((target.data.links as string[]) ?? []);
```

In `detectMergeCandidates`, hoist the person-folder constant right after `seen`:

```typescript
  const index = await buildEntityIndex(vault, layout);
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();
```

to:

```typescript
  const index = await buildEntityIndex(vault, layout);
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();
  const personFolder = kindToFolder(layout, 'person');
```

and insert the 4th tier right after the existing alias-overlap block, still inside the `for (let j ...)` loop, before its closing brace:

```typescript
      // Check alias overlap — if a's name matches b's alias or vice versa
      const aAliasMatch = b.aliases.some((al) => normalizeName(al) === normA);
      const bAliasMatch = a.aliases.some((al) => normalizeName(al) === normB);
      if (aAliasMatch || bAliasMatch) {
        seen.add(pairKey);
        // Keep the one with more aliases as target
        const [source, target] = a.aliases.length >= b.aliases.length
          ? [b, a]
          : [a, b];
        candidates.push({
          sourcePath: source.path,
          targetPath: target.path,
          sourceName: source.name,
          targetName: target.name,
          reason: `Name matches alias`,
          confidence: 0.95,
        });
      }

      // B2c 4th tier: person-scoped name-variant detection. No source_refs
      // overlap requirement — this is the fix for the Bryan/Pino-shaped blind
      // spot (a bare name/handle in one document, a fuller name in an
      // unrelated document). Only runs if no earlier tier already claimed
      // this pair. personNameVariantScore caps confidence at 0.65, well below
      // AUTO_MERGE_THRESHOLD, so it only ever lands in the human-reviewed queue.
      if (!seen.has(pairKey) && a.path.startsWith(personFolder) && b.path.startsWith(personFolder)) {
        const scored = personNameVariantScore(a.name, a.aliases, b.name, b.aliases);
        if (scored) {
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
    }
  }
```

In `src/jobs/handlers/detect-entity-dupes.ts`, fix the missing `layout` argument:

```typescript
    const layout = layoutFromConfig(context.config);
    const candidates = await detectMergeCandidates(context.vault);
```

to:

```typescript
    const layout = layoutFromConfig(context.config);
    const candidates = await detectMergeCandidates(context.vault, layout);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/compilation/entity-merger.test.ts test/jobs/handlers/detect-entity-dupes.test.ts`
Expected: PASS — including every pre-existing test in both files (regression: the three original `detectMergeCandidates` tiers, `mergeEntities`'s existing alias/source_refs/wikilink behavior, and all four pre-existing `detect-entity-dupes` handler tests, none of which pass a non-default layout so none of them were exercising the bug).

- [ ] **Step 5: Commit**

```bash
git add src/compilation/entity-merger.ts src/jobs/handlers/detect-entity-dupes.ts test/compilation/entity-merger.test.ts test/jobs/handlers/detect-entity-dupes.test.ts
git commit -m "fix(compilation): add person name-variant tier to detectMergeCandidates; pass configured layout into detect-entity-dupes"
```

---

### Task 7: Immediate detection wiring — `compiler.ts` and `link-concepts.ts`

**Files:**
- Modify: `src/compilation/compiler.ts`
- Modify: `src/jobs/handlers/link-concepts.ts`
- Test: `test/compilation/compiler.test.ts` (extend existing file)
- Test: `test/jobs/handlers/link-concepts.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `findNameVariantCandidatesForNewPage` from Task 5 (`src/compilation/person-name-variants.js`); `refreshQueue` from `src/maintenance/reconciliation-queue.js` (pre-existing); `config.enrichment.personResolution.enabled` from Task 2.
- Produces: no new exports — both `compileFromSource` and `linkConceptsHandler.execute` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

Add to `test/compilation/compiler.test.ts`, a new `describe` block:

```typescript
import { readReconciliationQueue } from '../../src/maintenance/reconciliation-queue.js';
import { serializeNote } from '../../src/vault/frontmatter.js';

vi.mock('../../src/maintenance/reconciliation-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/maintenance/reconciliation-queue.js')>();
  return { ...actual, refreshQueue: vi.fn(actual.refreshQueue) };
});

describe('compileFromSource — person name-variant detection (B2c)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-compiler-namevariant-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/entities');
    vi.mocked(refreshQueue).mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('queues a candidate when a new bare-named person page is created against an existing fuller-named page', async () => {
    await vault.atomicWrite(
      'wiki/entities/bryan-pino.md',
      serializeNote({ id: 'e1', type: 'entity', title: 'Bryan Pino', canonical_name: 'Bryan Pino', entity_kind: 'person', aliases: ['pino'], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }, 'Body.'),
    );
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });

    await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'Bryan', kind: 'person' })],
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );

    const queue = await readReconciliationQueue(vault, config.layout);
    const found = queue.entries.find(
      (e) => [e.sourceName, e.targetName].includes('Bryan') && [e.sourceName, e.targetName].includes('Bryan Pino'),
    );
    expect(found).toBeDefined();
  });

  it('does not queue anything when no plausible match exists', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });

    await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'Zzyzx', kind: 'person' })],
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );

    const queue = await readReconciliationQueue(vault, config.layout);
    expect(queue.entries).toHaveLength(0);
  });

  it('a failure in the name-variant check does not prevent the page from being created', async () => {
    vi.mocked(refreshQueue).mockRejectedValueOnce(new Error('disk full'));
    await vault.atomicWrite(
      'wiki/entities/bryan-pino.md',
      serializeNote({ id: 'e1', type: 'entity', title: 'Bryan Pino', canonical_name: 'Bryan Pino', entity_kind: 'person', aliases: ['pino'], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }, 'Body.'),
    );
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });

    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'Bryan', kind: 'person' })],
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );

    expect(result.created).toHaveLength(1);
    expect(await vault.exists('wiki/entities/bryan.md')).toBe(true);
  });
});
```

Add to `test/jobs/handlers/link-concepts.test.ts`, a new test:

```typescript
import { readReconciliationQueue } from '../../../src/maintenance/reconciliation-queue.js';

it('queues a person name-variant candidate when a new bare-named page is created (B2c)', async () => {
  await vault.ensureFolder('Curated/wiki/entities');
  await vault.create(
    'Curated/wiki/entities/bryan-pino.md',
    serializeNote(
      { id: 'e1', type: 'entity', title: 'Bryan Pino', canonical_name: 'Bryan Pino', entity_kind: 'person', aliases: ['pino'], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      '\n# Bryan Pino\n\nContent.\n',
    ),
  );
  const summaryPath = 'sources/s1.md';
  await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
  const ctx = makeCtx();

  await linkConceptsHandler.execute(makeJob(summaryPath, { people: [{ name: 'Bryan' }] }), ctx);

  const queue = await readReconciliationQueue(vault, ctx.config.layout);
  const found = queue.entries.find(
    (e) => [e.sourceName, e.targetName].includes('Bryan') && [e.sourceName, e.targetName].includes('Bryan Pino'),
  );
  expect(found).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/compilation/compiler.test.ts test/jobs/handlers/link-concepts.test.ts`
Expected: FAIL — neither `compileFromSource` nor `linkConceptsHandler` yet call `findNameVariantCandidatesForNewPage`/`refreshQueue`.

- [ ] **Step 3: Write minimal implementation**

In `src/compilation/compiler.ts`, add imports (after the existing `createBudgetTrackerFromConfig` import):

```typescript
import { findNameVariantCandidatesForNewPage } from './person-name-variants.js';
import { refreshQueue } from '../maintenance/reconciliation-queue.js';
```

Insert the new block right after `result.created.push(createdPath);` and before `if (flaggedForReview) {`:

```typescript
      result.created.push(createdPath);

      // B2c Component 3: immediate person name-variant detection on new-page
      // creation, so a same-day bare-name mention gets a same-day
      // reconciliation-queue entry instead of waiting on the (often-disabled)
      // scheduled detect-entity-dupes sweep. Best-effort: a failure here must
      // never undo or block a page that was already successfully created.
      if (entity.kind === 'person' && config.enrichment.personResolution.enabled) {
        try {
          const nameVariantCandidates = findNameVariantCandidatesForNewPage(entityIndex, layout, {
            name: entity.name,
            path: createdPath,
            aliases: [],
          });
          if (nameVariantCandidates.length > 0) {
            await refreshQueue(vault, nameVariantCandidates, layout);
            log.info('Queued person name-variant candidates', {
              path: createdPath,
              count: nameVariantCandidates.length,
            });
          }
        } catch (err) {
          log.warn('Name-variant check failed; page created without a candidate check', {
            path: createdPath,
            error: (err as Error).message,
          });
        }
      }

      if (flaggedForReview) {
```

In `src/jobs/handlers/link-concepts.ts`, add imports (after the existing `createReviewItem` import):

```typescript
import { findNameVariantCandidatesForNewPage } from '../../compilation/person-name-variants.js';
import { refreshQueue } from '../../maintenance/reconciliation-queue.js';
```

Insert the new block right after `linkedPaths.push(path);` and before `touchedPages.push(path);`:

```typescript
          const path = await createEntityPage(context.vault, resolution, info, summaryPath);
          linkedPaths.push(path);

          // B2c Component 3: same immediate-detection hookup as compiler.ts's
          // rich path (compileFromSource) — best-effort, person-only.
          if (kind === 'person' && context.config.enrichment.personResolution.enabled) {
            try {
              const nameVariantCandidates = findNameVariantCandidatesForNewPage(index, context.config.layout, {
                name: entity.name,
                path,
                aliases: [],
              });
              if (nameVariantCandidates.length > 0) {
                await refreshQueue(context.vault, nameVariantCandidates, context.config.layout);
                log.info('Queued person name-variant candidates', {
                  path,
                  count: nameVariantCandidates.length,
                });
              }
            } catch (err) {
              log.warn('Name-variant check failed; page created without a candidate check', {
                path,
                error: (err as Error).message,
              });
            }
          }

          touchedPages.push(path);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/compilation/compiler.test.ts test/jobs/handlers/link-concepts.test.ts`
Expected: PASS — including all pre-existing tests in both files.

- [ ] **Step 5: Commit**

```bash
git add src/compilation/compiler.ts src/jobs/handlers/link-concepts.ts test/compilation/compiler.test.ts test/jobs/handlers/link-concepts.test.ts
git commit -m "feat(compilation,jobs): run immediate person name-variant detection when a new person page is created"
```

---

### Task 8: End-to-end external-ID payload threading

**Files:**
- Modify: `src/jobs/handlers/extract-entities.ts`
- Modify: `src/enrichment/entity-extractor-rich.ts`
- Modify: `src/jobs/handlers/compile-entities.ts`
- Modify: `src/compilation/compiler.ts` (`CompilableEntity`, `createEntityPage` call, `resolveEntity` call)
- Modify: `src/jobs/handlers/link-concepts.ts` (`PayloadEntity`, `ExtractedEntityInfo` construction, `resolveEntity` call)
- Test: `test/jobs/handlers/extract-entities.test.ts` (extend existing file)
- Test: `test/compilation/compiler.test.ts` (extend existing file)
- Test: `test/jobs/handlers/link-concepts.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `extractSlackHandleIds` from Task 3 (`src/ingest/external-id-extractor.js`); `resolveEntity`'s `externalIds` param from Task 4.
- Produces: `externalIds?: string[]` threaded through `CompilableEntity`, `ExtractedEntityInfo` (already added in Task 3), the local `PayloadEntity` interface in `link-concepts.ts`, and the person item of `RichExtractedEntities`.

- [ ] **Step 1: Write the failing tests**

Add to `test/jobs/handlers/extract-entities.test.ts`:

```typescript
import { extractEntitiesHandler, extractEntitiesRichHandler } from '../../../src/jobs/handlers/extract-entities.js';

const SLACK_FIXTURE = '* [@pino](https://adobe.enterprise.slack.com/team/U01FZCB8X29) is the lead.';

describe('extract-entities — external-ID capture (B2c)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  function makeCtx(llm: LLMClient): JobContext {
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => {
        enqueued.push(input);
        return { ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0, priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade' } as Job;
      },
      llm,
      config: KarpathyConfigSchema.parse({ vaultPath: dir }),
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-extract-extid-'));
    vault = createFsAdapter(dir);
    enqueued = [];
    await vault.ensureFolder('outputs/source-summaries');
    await vault.write('raw/offsite.md', SLACK_FIXTURE);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('attaches externalIds to a matching person in the simple extract-entities -> link-concepts payload', async () => {
    const summaryPath = 'outputs/source-summaries/offsite.md';
    await vault.create(summaryPath, serializeNote(
      { id: 's1', type: 'source_summary', title: 'Offsite', source_type: 'plaintext', source_path: 'raw/offsite.md', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      '\n%% begin:entities %%\n%% end:entities %%\n',
    ));
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() {
        return { people: [{ name: 'pino', role: undefined, context: undefined, chunkRefs: [] }], projects: [], concepts: [], decisions: [], open_questions: [] } as never;
      },
    };
    const ctx = makeCtx(llm);

    await extractEntitiesHandler.execute(
      { id: 'j1', type: 'extract-entities', status: 'running', priority: 50, targetPath: summaryPath, payload: { rawPath: 'raw/offsite.md' }, trigger: 'cascade', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0 },
      ctx,
    );

    const linkJob = enqueued.find((j) => j.type === 'link-concepts');
    const people = (linkJob!.payload!.entities as Record<string, unknown[]>).people as Array<{ name: string; externalIds: string[] }>;
    expect(people[0].externalIds).toEqual(['slack:U01FZCB8X29']);
  });
});
```

Add to `test/compilation/compiler.test.ts`, inside the `describe('compileFromSource — person name-variant detection (B2c)', ...)` block added in Task 7:

```typescript
  it('resolves an existing external-ID-matched page instead of creating a duplicate, even with a completely different name', async () => {
    await vault.atomicWrite(
      'wiki/entities/pino.md',
      serializeNote({ id: 'e1', type: 'entity', title: 'pino', canonical_name: 'pino', entity_kind: 'person', aliases: [], external_ids: ['slack:U01FZCB8X29'], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }, 'Body.'),
    );
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });

    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'Frank Brown', kind: 'person', externalIds: ['slack:U01FZCB8X29'] })],
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );

    expect(result.created).toHaveLength(0);
    expect(result.updated).toContain('wiki/entities/pino.md');
  });
```

Add to `test/jobs/handlers/link-concepts.test.ts`:

```typescript
it('resolves an existing external-ID-matched page instead of creating a duplicate (B2c)', async () => {
  await vault.ensureFolder('Curated/wiki/entities');
  await vault.create(
    'Curated/wiki/entities/pino.md',
    serializeNote(
      { id: 'e1', type: 'entity', title: 'pino', canonical_name: 'pino', entity_kind: 'person', aliases: [], external_ids: ['slack:U01FZCB8X29'], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      '\n# pino\n\nContent.\n',
    ),
  );
  const summaryPath = 'sources/s1.md';
  await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
  const ctx = makeCtx();

  await linkConceptsHandler.execute(
    makeJob(summaryPath, { people: [{ name: 'Frank Brown', externalIds: ['slack:U01FZCB8X29'] }] }),
    ctx,
  );

  const entityFiles = await vault.listMarkdownFiles('Curated/wiki/entities');
  expect(entityFiles).toEqual(['Curated/wiki/entities/pino.md']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/jobs/handlers/extract-entities.test.ts test/compilation/compiler.test.ts test/jobs/handlers/link-concepts.test.ts`
Expected: FAIL — `externalIds` isn't attached to the payload; `resolveEntity` never receives `externalIds` from either pipeline, so both new tests would create a duplicate page instead of resolving to the existing one.

- [ ] **Step 3: Write minimal implementation**

In `src/jobs/handlers/extract-entities.ts`, add the import (after the existing `TransientLLMError` import):

```typescript
import { extractSlackHandleIds } from '../../ingest/external-id-extractor.js';
```

In `extractEntitiesHandler`, after `const rawContent = await context.vault.read(rawPath);`:

```typescript
    // Read raw content
    const rawContent = await context.vault.read(rawPath);
    // B2c Component 0: deterministic Slack-handle -> external-ID capture.
    // No LLM call — same deterministic-lane cost as chunking.
    const handleIdMap = extractSlackHandleIds(rawContent);
```

Change the enqueue call:

```typescript
          entities: serializeEntitiesForPayload(entities),
```

to:

```typescript
          entities: serializeEntitiesForPayload(entities, handleIdMap),
```

Change `serializeEntitiesForPayload`:

```typescript
function serializeEntitiesForPayload(entities: ExtractedEntities): Record<string, unknown> {
  return {
    people: entities.people.map((p) => ({ name: p.name, role: p.role, context: p.context, chunkRefs: p.chunkRefs })),
```

to:

```typescript
function serializeEntitiesForPayload(
  entities: ExtractedEntities,
  handleIdMap: Map<string, string>,
): Record<string, unknown> {
  return {
    people: entities.people.map((p) => ({
      name: p.name, role: p.role, context: p.context, chunkRefs: p.chunkRefs,
      externalIds: handleIdMap.has(p.name.toLowerCase()) ? [handleIdMap.get(p.name.toLowerCase())!] : [],
    })),
```

(the `projects`/`concepts`/`decisions` lines are unchanged.)

Apply the identical pattern to `extractEntitiesRichHandler` and `serializeRichEntitiesForPayload`: add `const handleIdMap = extractSlackHandleIds(rawContent);` after the rich handler's own `const rawContent = ...` read, change the `compile-entities` enqueue call to `serializeRichEntitiesForPayload(entities, handleIdMap)`, and change:

```typescript
function serializeRichEntitiesForPayload(entities: RichExtractedEntities): Record<string, unknown> {
  return {
    people: entities.people.map((p) => ({
      name: p.name, role: p.role, context: p.context,
      relationships: p.relationships, chunkRefs: p.chunkRefs,
    })),
```

to:

```typescript
function serializeRichEntitiesForPayload(
  entities: RichExtractedEntities,
  handleIdMap: Map<string, string>,
): Record<string, unknown> {
  return {
    people: entities.people.map((p) => ({
      name: p.name, role: p.role, context: p.context,
      relationships: p.relationships, chunkRefs: p.chunkRefs,
      externalIds: handleIdMap.has(p.name.toLowerCase()) ? [handleIdMap.get(p.name.toLowerCase())!] : [],
    })),
```

(the `projects`/`concepts`/`topics`/`decisions`/`tools`/`organizations`/`open_questions`/`actionItems` lines are unchanged.)

In `src/enrichment/entity-extractor-rich.ts`, change the `people` schema entry:

```typescript
    people: z.array(z.object({
      name: z.string(),
      role: optStr,
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
    })).default([]),
```

to:

```typescript
    people: z.array(z.object({
      name: z.string(),
      role: optStr,
      context: optStr,
      confidence: z.number().min(0).max(1).default(0.5),
      relationships: z.array(RelationshipSchema).default([]),
      chunkRefs: z.array(z.string()).default([]),
      /** B2c: attached deterministically post-extraction by extract-entities.ts's
       *  extractSlackHandleIds — never populated by the LLM itself. */
      externalIds: z.array(z.string()).default([]),
    })).default([]),
```

In `src/jobs/handlers/compile-entities.ts`, change the person compilable push:

```typescript
    for (const person of (entities.people ?? [])) {
      if (!shouldInclude(person.name, 'person', person.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: person.name,
        kind: 'person' as EntityKind,
        context: person.context ?? '',
        role: person.role,
        relationships: person.relationships ?? [],
        chunkRefs: person.chunkRefs ?? [],
      });
    }
```

to:

```typescript
    for (const person of (entities.people ?? [])) {
      if (!shouldInclude(person.name, 'person', person.confidence)) { filteredOut++; continue; }
      compilable.push({
        name: person.name,
        kind: 'person' as EntityKind,
        context: person.context ?? '',
        role: person.role,
        relationships: person.relationships ?? [],
        chunkRefs: person.chunkRefs ?? [],
        externalIds: person.externalIds ?? [],
      });
    }
```

In `src/compilation/compiler.ts`, change `CompilableEntity`:

```typescript
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
```

to (add `externalIds?: string[];` at the end):

```typescript
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
  externalIds?: string[];
}
```

Change the `resolveEntity` call:

```typescript
    const resolution = resolveEntity(
      { name: entity.name, kind: entity.kind },
      entityIndex,
      layout,
    );
```

to:

```typescript
    const resolution = resolveEntity(
      { name: entity.name, kind: entity.kind, externalIds: entity.externalIds },
      entityIndex,
      layout,
    );
```

Change the `createEntityPage` call:

```typescript
      const createdPath = await createEntityPage(vault, resolution, {
        name: entity.name,
        kind: entity.kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs,
      }, sourcePath, layout);
```

to (add `externalIds: entity.externalIds,`):

```typescript
      const createdPath = await createEntityPage(vault, resolution, {
        name: entity.name,
        kind: entity.kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs,
        externalIds: entity.externalIds,
      }, sourcePath, layout);
```

In `src/jobs/handlers/link-concepts.ts`, change `PayloadEntity`:

```typescript
interface PayloadEntity {
  name: string;
  role?: string;
  status?: string;
  context?: string;
  definition?: string;
  confidence?: number;
  chunkRefs?: string[];
}
```

to (add `externalIds?: string[];`):

```typescript
interface PayloadEntity {
  name: string;
  role?: string;
  status?: string;
  context?: string;
  definition?: string;
  confidence?: number;
  chunkRefs?: string[];
  externalIds?: string[];
}
```

Change the resolution + info construction:

```typescript
      const resolution = resolveEntity({ name: entity.name, kind }, index, context.config.layout);
      const info: ExtractedEntityInfo = {
        name: entity.name,
        kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs ?? [],
      };
```

to:

```typescript
      const resolution = resolveEntity(
        { name: entity.name, kind, externalIds: entity.externalIds },
        index,
        context.config.layout,
      );
      const info: ExtractedEntityInfo = {
        name: entity.name,
        kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs ?? [],
        externalIds: entity.externalIds,
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/jobs/handlers/extract-entities.test.ts test/compilation/compiler.test.ts test/jobs/handlers/link-concepts.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite once to catch any missed call site**

Run: `pnpm vitest run test/jobs/handlers/compile-entities.test.ts test/enrichment/`
Expected: PASS — confirms `entity-extractor-rich.ts`'s additive schema change and `compile-entities.ts`'s new field don't break any existing extraction/compilation test (regression).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/handlers/extract-entities.ts src/enrichment/entity-extractor-rich.ts src/jobs/handlers/compile-entities.ts src/compilation/compiler.ts src/jobs/handlers/link-concepts.ts test/jobs/handlers/extract-entities.test.ts test/compilation/compiler.test.ts test/jobs/handlers/link-concepts.test.ts
git commit -m "feat(ingest,jobs,compilation): thread captured external IDs end-to-end from raw text to entity resolution"
```

---

### Task 9: `rot-scan.ts` — bare-identity reporting table

**Files:**
- Modify: `src/intelligence/rot-scan.ts`
- Test: `test/intelligence/decay-scan.test.ts` (extend the existing `describe('rot-scan (C2)', ...)` block — per B2b's established precedent that rot-scan's tests live in this shared file, not a separate `rot-scan.test.ts`)

**Interfaces:**
- Consumes: `identity_uncertain`/`entity_kind` frontmatter fields from Task 3.
- Produces: `RotScanResult` gains `bareIdentityCandidates: BareIdentityEntry[]`; `BareIdentityEntry` new export.

- [ ] **Step 1: Write the failing test**

Add to `test/intelligence/decay-scan.test.ts`, inside the existing `describe('rot-scan (C2)', ...)` block, after the existing `'does not flag a note with a substantial outcome as thin'` test:

```typescript
  it('flags a person page with identity_uncertain=true as a bare-identity candidate, in its own table', async () => {
    await vault.ensureFolder('wiki/entities');
    await vault.create(
      'wiki/entities/bryan.md',
      `---
id: e1
type: entity
title: Bryan
entity_kind: person
canonical_name: Bryan
identity_uncertain: true
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
body.

%% begin:backlinks %%
- [[wiki/something]]
%% end:backlinks %%`,
    );
    await vault.create(
      'wiki/entities/bryan-pino.md',
      `---
id: e2
type: entity
title: Bryan Pino
entity_kind: person
canonical_name: Bryan Pino
identity_uncertain: false
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
body.

%% begin:backlinks %%
- [[wiki/something]]
%% end:backlinks %%`,
    );

    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));

    expect(result.bareIdentityCandidates.map((c) => c.path)).toContain('wiki/entities/bryan.md');
    expect(result.bareIdentityCandidates.map((c) => c.path)).not.toContain('wiki/entities/bryan-pino.md');

    const report = await vault.read(result.reportPath);
    expect(report).toContain('Bare-identity person pages');
    expect(report).toContain('bryan');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: FAIL — `result.bareIdentityCandidates` is `undefined` (TS error at compile/type-check time, and the property doesn't exist at runtime).

- [ ] **Step 3: Write minimal implementation**

In `src/intelligence/rot-scan.ts`, add after the `ThinContentEntry` interface:

```typescript
export interface BareIdentityEntry {
  path: string;
  title: string;
}
```

Change `RotScanResult`:

```typescript
export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  reportPath: string;
}
```

to:

```typescript
export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  bareIdentityCandidates: BareIdentityEntry[];
  reportPath: string;
}
```

Add the region constant after `THIN_REGION_ID`:

```typescript
const BARE_IDENTITY_REGION_ID = 'vault-health-bare-identity';
```

In `runRotScan`, add the array alongside `thinCandidates`:

```typescript
  const candidates: RotEntry[] = [];
  const thinCandidates: ThinContentEntry[] = [];
```

to:

```typescript
  const candidates: RotEntry[] = [];
  const thinCandidates: ThinContentEntry[] = [];
  const bareIdentityCandidates: BareIdentityEntry[] = [];
```

Insert, right after the existing thin-content check inside the per-file loop:

```typescript
      const type = asString(fm.type);
      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
      if (target && isPlaceholderContent(target, getProtectedRegion(body, target.primaryRegion))) {
        thinCandidates.push({ path, title: asString(fm.title) || path, region: target.primaryRegion });
      }
```

becomes:

```typescript
      const type = asString(fm.type);
      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
      if (target && isPlaceholderContent(target, getProtectedRegion(body, target.primaryRegion))) {
        thinCandidates.push({ path, title: asString(fm.title) || path, region: target.primaryRegion });
      }

      if (asString(fm.entity_kind) === 'person' && fm.identity_uncertain === true) {
        bareIdentityCandidates.push({ path, title: asString(fm.title) || path });
      }
```

Change the write + return:

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  await vault.ensureFolder(layout.system);
  await vault.atomicWrite(healthPath, renderReport(scanned, candidates, thinCandidates, nowMs));
  return { scanned, candidates, thinCandidates, reportPath: healthPath };
```

to:

```typescript
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  await vault.ensureFolder(layout.system);
  await vault.atomicWrite(healthPath, renderReport(scanned, candidates, thinCandidates, bareIdentityCandidates, nowMs));
  return { scanned, candidates, thinCandidates, bareIdentityCandidates, reportPath: healthPath };
```

Change `renderReport`'s signature:

```typescript
function renderReport(
  scanned: number,
  candidates: RotEntry[],
  thinCandidates: ThinContentEntry[],
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
  nowMs: number,
): string {
```

and add a third table right after the existing thin-content table block, before the final `return lines.join('\n');`:

```typescript
  lines.push(CLOSE_TAG(THIN_REGION_ID));
  lines.push('');
  lines.push('## Bare-identity person pages');
  lines.push('');
  lines.push(`${bareIdentityCandidates.length} person pages have a canonical name that is a bare first name or handle.`);
  lines.push('');
  lines.push(OPEN_TAG(BARE_IDENTITY_REGION_ID));
  if (bareIdentityCandidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path |');
    lines.push('|------|');
    for (const b of bareIdentityCandidates) {
      lines.push(`| [[${b.path.replace(/\.md$/, '')}|${b.title}]] |`);
    }
  }
  lines.push(CLOSE_TAG(BARE_IDENTITY_REGION_ID));
  lines.push('');
  return lines.join('\n');
}
```

(Replace only the final `lines.push(CLOSE_TAG(THIN_REGION_ID)); lines.push(''); return lines.join('\n');` — i.e. insert the new block between the existing close-tag line and the final return.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/intelligence/decay-scan.test.ts`
Expected: PASS — including all pre-existing `decay-scan (C1)` and `rot-scan (C2)` tests in the same file.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/rot-scan.ts test/intelligence/decay-scan.test.ts
git commit -m "feat(intelligence): add bare-identity person pages table to the rot-scan vault-health report"
```

---

### Task 10: Wikilink-hygiene fix (G4)

**Files:**
- Modify: `src/compilation/entity-compiler.ts`
- Modify: `src/enrichment/prompts.ts`
- Test: `test/compilation/entity-compiler.test.ts` (extend existing file)

**Interfaces:**
- Produces: no new exports — `compileEntityPage`'s output is now post-processed before being written into any protected region.

- [ ] **Step 1: Write the failing test**

Add to `test/compilation/entity-compiler.test.ts`, a new `describe` block:

```typescript
describe('compileEntityPage — wikilink-hygiene fix (B2c)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-entity-compiler-wikilink-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/entities');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collapses a full-vault-path wikilink emitted by the LLM to bare-name form (reproduces the real Matt Newman.md defect)', async () => {
    const path = 'wiki/entities/matt-newman.md';
    await vault.create(
      path,
      serializeNote(
        {
          id: 'p1', type: 'entity', title: 'Matt Newman', entity_kind: 'person', canonical_name: 'Matt Newman',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
          source_refs: [], aliases: [], links: [],
          protected_regions: ['summary', 'projects', 'topics', 'timeline', 'sources'],
        },
        `
# Matt Newman

## Summary
%% begin:summary %%
%% end:summary %%

## Projects
%% begin:projects %%
%% end:projects %%

## Topics & Interests
%% begin:topics %%
%% end:topics %%

## Interactions Timeline
%% begin:timeline %%
%% end:timeline %%

## Source References
%% begin:sources %%
%% end:sources %%
`,
      ),
    );

    const entity: CompilableEntity = {
      name: 'Matt Newman', kind: 'person', context: 'Evaluated by Bryan Pino.', relationships: [], chunkRefs: [],
    };
    const llm: LLMClient = {
      async complete() {
        return `SUMMARY:
Matt Newman was evaluated by [[Curated/wiki/entities/Bryan Pino]] on calibration.

PROJECTS:
(none)

TOPICS:
(none)

TIMELINE:
Evaluated per [[folder/sub/Bryan Pino|Bryan]].

SOURCES:
- source1.md`;
      },
      async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };

    await compileEntityPage(entity, path, 'sources/source1.md', { vault, llm });

    const { body } = parseNote(await vault.read(path));
    expect(body).toContain('[[Bryan Pino]]');
    expect(body).not.toContain('[[Curated/wiki/entities/Bryan Pino]]');
    expect(body).toContain('[[Bryan Pino|Bryan]]');
    expect(body).not.toContain('[[folder/sub/Bryan Pino|Bryan]]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/compilation/entity-compiler.test.ts`
Expected: FAIL — the full-path wikilinks pass through unchanged.

- [ ] **Step 3: Write minimal implementation**

In `src/compilation/entity-compiler.ts`, change the region-write loop:

```typescript
    updatedBody = updateProtectedRegion(updatedBody, section, compiledContent);
  }
```

to:

```typescript
    // B2c G4: collapse any full-vault-path wikilink the model still emits
    // (e.g. [[Curated/wiki/entities/Bryan Pino]]) down to bare-name form
    // ([[Bryan Pino]]) so entity-merger's rewriteWikilinks() — which matches
    // on bare slug only — can find and update it on a future merge.
    updatedBody = updateProtectedRegion(updatedBody, section, normalizeWikilinkTargets(compiledContent));
  }
```

and add the new function near `parseSectionResponse` (either before or after it, module-private, no export needed):

```typescript
/** Collapse any `[[folder/path/Name]]`-shaped wikilink the model emits down to
 *  bare-name form `[[Name]]`, so entity-merger's rewriteWikilinks() (which
 *  matches on bare slug only) can find and update it on a future merge. */
function normalizeWikilinkTargets(text: string): string {
  return text.replace(/\[\[([^\]|]*\/)([^\]|/]+)(\|[^\]]+)?\]\]/g, (_, _path, name, alias) => `[[${name}${alias ?? ''}]]`);
}
```

In `src/enrichment/prompts.ts`, in `compileEntityPrompt`, change:

```typescript
Use the references and related entities below to write comprehensive, well-organized content.
Use [[wikilinks]] for all entity cross-references.
```

to:

```typescript
Use the references and related entities below to write comprehensive, well-organized content.
Use [[wikilinks]] for all entity cross-references — always the bare entity name (e.g. [[Bryan Pino]]), never a full vault path (e.g. NOT [[Curated/wiki/entities/Bryan Pino]]).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/compilation/entity-compiler.test.ts`
Expected: PASS — including all pre-existing tests in this file (regression: an already-bare wikilink is unchanged/idempotent, since the regex requires at least one `/` before the final path segment).

- [ ] **Step 5: Commit**

```bash
git add src/compilation/entity-compiler.ts src/enrichment/prompts.ts test/compilation/entity-compiler.test.ts
git commit -m "fix(compilation): normalize full-vault-path wikilinks to bare-name form in compiled entity content"
```

---

## Final verification

After Task 10, run the full suite once more to confirm nothing upstream regressed:

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: all pass (module count/test count will have grown by the new files/tests added across Tasks 1–10; `test/bin/intel-tick-exit.test.ts` may still flake per the Global Constraints note above — that alone does not indicate a regression).

## Operator follow-up (not part of this plan)

Per the design's §16 and §17: flip `maintenance.reviewEnabled: true` in `~/.karpathy/config.json` to get the periodic `detect-entity-dupes` half of this feature running on a schedule in the real vault (Component 3's immediate detection, Tasks 5–7, works regardless of this flag). This is a one-line config change to Tom's live vault config, outside this git repo — not performed by this plan.

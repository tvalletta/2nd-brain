# Design: Review-Note Explanatory Content (Sub-project B2a)

**Status:** Approved for spec write-up (design conversation complete 2026-07-28)
**Sub-project:** B2a of Sub-project B (Content Richness). B2b (wiki content richness) and B2c (person name resolution) are separate, not covered here.
**Prerequisite:** VPN-aware LLM retry (`docs/superpowers/specs/2026-07-27-vpn-aware-llm-retry-design.md`, merged to main) — `TransientLLMError`, the indefinite-retry job-queue lane, and the consolidated `createLLMFromConfig` factory are all load-bearing for this design.

## 0. Context

An audit of Karpathy's curation effectiveness found review notes weak: "The content of the review is weak. It doesn't provide enough detail about what needs to be reviewed and why." Four code paths write review notes today, and — contrary to what was assumed when this sub-project was first scoped — they do **not** already share one write function:

1. **Contradiction** (`src/review/contradiction-detector.ts`) — `writeContradictionReview()` builds its own frontmatter/body inline. Analysis body is the literal string `"Pending human review."`
2. **Duplicate** (`src/review/duplicate-detector.ts`) — `writeDuplicateReview()`, same pattern, own inline frontmatter. Analysis body is `"These pages have {N}% word overlap. Review and merge if appropriate."`
3. **Ambiguous entity** (`src/jobs/handlers/link-concepts.ts`, the `resolution.status === 'ambiguous'` branch) — calls the shared `createReviewItem()` (`src/review/create-review-item.ts`). Body already has some hand-written explanatory text listing the candidates and a generic 3-step resolution checklist.
4. **Uncertain entity drop** (`src/compilation/compiler.ts`, the significance-gate low-confidence-drop branch) — also calls `createReviewItem()`. Body already explains *why* the page was flagged, referencing the gate's stated reason and confidence.

So today only #3 and #4 share a write path; #1 and #2 duplicate the frontmatter-writing logic independently, and all four write essentially static or template-only "analysis," with no LLM judgment of whether the underlying heuristic detection (word-overlap, negation/date/number signals for contradiction; Jaccard similarity for duplicate; fuzzy path/alias matching for ambiguous entity) is even a true positive.

This spec covers: unifying all four onto `createReviewItem`, adding a shared `generateReviewAnalysis()` step that produces real LLM-judged analysis for all four, and the small pieces of infrastructure that requires (real per-call model-tier selection, which exists in config today but is never read; a confidence-gated fast→medium fallback).

## 1. Goals / Non-Goals

**Goals:**
- All four review-note kinds get real LLM-generated analysis — a verdict, 2-3 sentences of reasoning grounded in the actual content being compared, and a confidence score — replacing today's static/templated text.
- Cheap-first: try a fast-tier model (Haiku) before a slower/costlier one (Sonnet), consistent with the empirically-validated finding that Haiku's judgment quality is sufficient for this task (Haiku and Sonnet reached the same verdict on a real contradiction-detection case, Haiku in ~2.2s vs Sonnet's ~4.2s).
- Never regress the VPN-outage protection just built: a real connectivity failure (`TransientLLMError`) aborts and retries the whole job later — it must never be silently absorbed into "just show the placeholder text instead."
- Reuse the existing budget/degradation conventions (`BudgetTracker`, the significance-gate's confidence-threshold pattern) rather than inventing new ones.
- Fix the real architectural gap this feature exposed: `config.llm.models.{fast,medium,heavy}` already exists with sensible defaults but nothing reads it — every call uses the single `config.llm.model` regardless of tier.
- Unify the four review-note write paths onto the one existing `createReviewItem()` function, removing the two duplicated inline frontmatter-writers.

**Non-goals:**
- Auto-resolving anything based on the LLM's verdict (no auto-merge, no auto-approve/dismiss) — the analysis is informational; a human still acts via the existing `approveReviewItem`/`rejectReviewItem`/review-queue workflow.
- B2b (wiki page content richness) and B2c (person name resolution) — separate specs.
- Changing review-note frontmatter's `type: 'contradiction'` literal (all four kinds share this literal today, differentiated by `conflict_type`; `review-queue.ts`'s `listReviewItems()` already reads `conflict_type` as the effective kind discriminator) — out of scope, no consumer needs it changed.
- A `heavy`-tier escalation beyond `medium` — Sonnet is the ceiling for this feature per the explicit "Haiku, with Sonnet as fallback" framing.

## 2. Architecture Overview

```
src/enrichment/llm-factory.ts (MODIFIED)
  createLLMFromConfig(config, stateDir, tier?: LLMTier): LLMClient
    — tier omitted → today's behavior (config.llm.model), fully backward compatible
    — tier given → config.llm.models[tier]

src/review/generate-review-analysis.ts (NEW)
  generateReviewAnalysis(config, projectRoot, input): Promise<ReviewAnalysisResult>
    — orchestrator: reserve fast budget → call → confident enough? return.
      Not confident or fast threw non-transiently → reserve medium budget →
      call → return whatever medium produced. Both unavailable/failed →
      return fast's result if we got one, else a placeholder.
    — a TransientLLMError from either tier is NEVER swallowed into this
      degradation path — it propagates straight out, exactly like every
      other real LLM call site fixed in the VPN-retry work, so the whole
      job aborts and retries later instead of writing a fake "analysis."
  bucketConfidence(score: number): 'low' | 'medium' | 'high'
    — 0-1 float → the categorical bucket createReviewItem's frontmatter uses.

src/review/analysis-prompts.ts (NEW)
  Four { buildPrompt(input), responseSchema } pairs — contradiction,
  duplicate, ambiguousEntity, uncertainEntityDrop. Each schema is
  { verdict: <kind-specific enum>, reasoning: string, confidence: number }.

src/review/create-review-item.ts (MODIFIED — additive only)
  ReviewItemInput gains one optional field: confidence?: 'low'|'medium'|'high'
  (default 'low', preserving today's hardcoded behavior when omitted).

src/review/contradiction-detector.ts (MODIFIED)
  writeContradictionReview() gains config/projectRoot params, calls
  generateReviewAnalysis(), builds its body from the result, delegates the
  write to createReviewItem() instead of its own inline frontmatter code.

src/review/duplicate-detector.ts (MODIFIED)
  Same shape. detectDuplicates() additionally captures a ~400-char body
  excerpt per page during its existing per-page scan (one more field on
  the PageInfo it already builds — not a new pass over the vault).

src/jobs/handlers/link-concepts.ts (MODIFIED, ambiguous branch only)
  Fetches title + ~300-char excerpt for each candidate (typically 2-4
  paths) via vault.read/parseNote, then calls generateReviewAnalysis().
  Validates any returned matchedPath is actually one of the given
  candidates before trusting it.

src/compilation/compiler.ts (MODIFIED, uncertain-drop branch only)
  Calls generateReviewAnalysis() with data already in scope
  (entity.context, flaggedForReview.reason/confidence) — no new fetching.

src/jobs/handlers/detect-contradictions.ts, detect-duplicates.ts (MODIFIED)
  Pass context.config/context.projectRoot through to the now-widened
  writeContradictionReview()/writeDuplicateReview() signatures.

src/config/schema.ts (MODIFIED)
  New top-level `review` section: analysisEnabled (default true),
  confidenceEscalationThreshold (default 0.7).
```

## 3. Component 1 — Tier-aware LLM factory

**File:** `src/enrichment/llm-factory.ts`

```typescript
import { createBedrockClient, createLiteLLMClient, createNoopClient, type LLMClient } from './llm-client.js';
import { withConnectivityProbe } from './connectivity-probe.js';
import type { KarpathyConfig, LLMTier } from '../config/schema.js';

export function createLLMFromConfig(config: KarpathyConfig, stateDir: string, tier?: LLMTier): LLMClient {
  const model = tier ? config.llm.models[tier] : config.llm.model;

  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    const client = createLiteLLMClient({ baseUrl, apiKey, model, maxTokens: config.llm.maxTokens });
    return withConnectivityProbe(client, 'litellm', config, stateDir);
  }
  if (config.llm.provider === 'bedrock') {
    const client = createBedrockClient({
      region: config.llm.region,
      model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
    return withConnectivityProbe(client, 'bedrock', config, stateDir);
  }
  return createNoopClient();
}
```

`tier` is optional and additive — every existing call site (`karpathy.ts`, `intel-command.ts`, `mcp/context.ts`, `hooks/dispatch.ts`) keeps calling `createLLMFromConfig(config, stateDir)` with no changes and gets byte-identical behavior (`config.llm.model`, unchanged). The connectivity-probe's `providerId` stays `'litellm'`/`'bedrock'` (not per-tier) — a VPN outage affects the endpoint regardless of which model is requested, so provider-level (not model-level) reachability tracking is correct and requires no change to `connectivity-probe.ts`.

`LLMTier` (`'fast'|'medium'|'heavy'`) is already exported from `src/config/schema.ts` (`export type LLMTier = keyof LLMModelTiers;`) — no new type needed, just imported.

## 4. Component 2 — `generateReviewAnalysis` orchestrator

**File:** `src/review/generate-review-analysis.ts` (new)

```typescript
import { z } from 'zod';
import { createLLMFromConfig } from '../enrichment/llm-factory.js';
import { createBudgetTrackerFromConfig } from '../shared/budget.js';
import { resolveStateDir } from '../config/defaults.js';
import { TransientLLMError } from '../shared/errors.js';
import type { KarpathyConfig } from '../config/schema.js';
import { PROMPTS, type ReviewAnalysisInput } from './analysis-prompts.js';

export type { ReviewAnalysisInput } from './analysis-prompts.js';

export interface ReviewAnalysisResult {
  verdict: string;
  reasoning: string;
  confidence: number;
  matchedPath?: string; // only meaningful for kind: 'ambiguous_entity'
  tier: 'fast' | 'medium' | 'placeholder';
}

const PLACEHOLDER_TEXT: Record<ReviewAnalysisInput['kind'], string> = {
  contradiction: 'Pending human review.',
  duplicate: 'Pending human review — LLM analysis unavailable.',
  ambiguous_entity: 'Multiple pages match this entity. Please review and resolve manually.',
  uncertain_entity_drop: 'Pending human review — LLM analysis unavailable.',
};

function placeholderResult(kind: ReviewAnalysisInput['kind']): ReviewAnalysisResult {
  return { verdict: 'unclear', reasoning: PLACEHOLDER_TEXT[kind], confidence: 0, tier: 'placeholder' };
}

export function bucketConfidence(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

export async function generateReviewAnalysis(
  config: KarpathyConfig,
  projectRoot: string,
  input: ReviewAnalysisInput,
): Promise<ReviewAnalysisResult> {
  if (!config.review.analysisEnabled) return placeholderResult(input.kind);

  const budget = createBudgetTrackerFromConfig(config, projectRoot);
  const stateDir = resolveStateDir(config);
  const { buildPrompt, responseSchema } = PROMPTS[input.kind];
  const prompt = buildPrompt(input);
  const threshold = config.review.confidenceEscalationThreshold;

  let fastResult: ReviewAnalysisResult | null = null;

  if (budget.tryReserve('fast')) {
    try {
      const fastClient = createLLMFromConfig(config, stateDir, 'fast');
      const parsed = await fastClient.extractStructured(prompt, responseSchema);
      fastResult = { ...parsed, tier: 'fast' };
      if (parsed.confidence >= threshold) return fastResult;
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      // non-transient (e.g. malformed JSON) — fall through to medium escalation
    }
  }

  if (budget.tryReserve('medium')) {
    try {
      const mediumClient = createLLMFromConfig(config, stateDir, 'medium');
      const parsed = await mediumClient.extractStructured(prompt, responseSchema);
      return { ...parsed, tier: 'medium' };
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      // both tiers failed for real content/parsing reasons — fall through
    }
  }

  return fastResult ?? placeholderResult(input.kind);
}
```

Behavior table:

| Fast tier | Medium tier | Result |
|---|---|---|
| Succeeds, confidence ≥ threshold | (never called) | Fast's result |
| Succeeds, confidence < threshold | Succeeds | Medium's result (no further gating) |
| Succeeds, confidence < threshold | Fails / budget exhausted | Fast's (low-confidence) result — still better than a placeholder |
| Throws non-transient | Succeeds | Medium's result |
| Throws non-transient | Fails / budget exhausted | Placeholder |
| Throws `TransientLLMError` | — | Rethrows immediately, no fallback attempted |
| Budget exhausted from the start | — | Placeholder immediately |

The `TransientLLMError` short-circuit is the one piece of this design with no analogue in ordinary "graceful degradation" thinking — it's a deliberate carry-over from the VPN-retry work: a real outage must abort this job and let the queue's indefinite-retry lane handle it, not get masked as "the review note just has generic text this time."

## 5. Component 3 — The four prompts

**File:** `src/review/analysis-prompts.ts` (new). All four `buildPrompt` functions produce a prompt ending in the same instruction (matching the existing convention in `significance-gate.ts`): `Output ONLY a single fenced \`\`\`json block.` All four schemas share the shape `{ verdict: <enum>, reasoning: z.string(), confidence: z.number().min(0).max(1) }`, differing only in the verdict enum and prompt content.

```typescript
import { z } from 'zod';

export type ReviewAnalysisInput =
  | { kind: 'contradiction'; pageATitle: string; pageBTitle: string; claimA: string; claimB: string }
  | { kind: 'duplicate'; titleA: string; titleB: string; excerptA: string; excerptB: string; wordOverlapPercent: number }
  | {
      kind: 'ambiguous_entity';
      entityName: string;
      entityKind: string;
      sourceContext: string;
      candidates: Array<{ path: string; title: string; excerpt: string }>;
    }
  | {
      kind: 'uncertain_entity_drop';
      entityName: string;
      entityKind: string;
      entityContext: string;
      dropReason: string;
      gateConfidence: number;
    };

const ContradictionSchema = z.object({
  verdict: z.enum(['genuine_conflict', 'false_positive', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildContradictionPrompt(input: Extract<ReviewAnalysisInput, { kind: 'contradiction' }>): string {
  return `Two claims from a personal knowledge base were flagged as a potential contradiction by an automated heuristic (it just checks for shared subject words plus negation/date/number differences, so it produces many false positives). Judge whether these claims actually conflict.

Page A ("${input.pageATitle}"): "${input.claimA}"
Page B ("${input.pageBTitle}"): "${input.claimB}"

Decide: genuine_conflict, false_positive, or unclear. Explain in 2-3 sentences, referencing what's actually said. If there's a genuine conflict and a date makes it inferable, note which claim seems more current — the human reviewer makes the final call either way.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "genuine_conflict" | "false_positive" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const DuplicateSchema = z.object({
  verdict: z.enum(['same_entity', 'different_entities', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildDuplicatePrompt(input: Extract<ReviewAnalysisInput, { kind: 'duplicate' }>): string {
  return `Two wiki pages were flagged as possible duplicates by a heuristic (${input.wordOverlapPercent}% word overlap, plus bonuses for shared aliases/entity-kind/sources). Judge whether they describe the same real-world thing.

Page A ("${input.titleA}"): ${input.excerptA}

Page B ("${input.titleB}"): ${input.excerptB}

Decide: same_entity, different_entities, or unclear. If the same entity, say which page looks more complete/authoritative and should be kept as canonical. Explain in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "same_entity" | "different_entities" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const AmbiguousEntitySchema = z.object({
  verdict: z.enum(['match', 'no_match', 'unclear']),
  matchedPath: z.string().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildAmbiguousEntityPrompt(input: Extract<ReviewAnalysisInput, { kind: 'ambiguous_entity' }>): string {
  const candidateBlock = input.candidates
    .map((c, i) => `[${i + 1}] ${c.title} (${c.path}): ${c.excerpt}`)
    .join('\n');
  return `While processing a new mention, the entity "${input.entityName}" (${input.entityKind}) matched multiple existing pages ambiguously.

Context where it was mentioned: ${input.sourceContext}

Candidates:
${candidateBlock}

Decide: does this mention clearly match ONE of these candidates (name its exact path in matchedPath), do none of them match (no_match), or is it genuinely unclear? Explain your reasoning in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "match" | "no_match" | "unclear", "matchedPath": "<exact path from the list, only if verdict=match>", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const UncertainEntityDropSchema = z.object({
  verdict: z.enum(['keep', 'drop', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildUncertainEntityDropPrompt(input: Extract<ReviewAnalysisInput, { kind: 'uncertain_entity_drop' }>): string {
  return `An automated significance gate suggested dropping the newly-extracted entity "${input.entityName}" (${input.entityKind}) as likely noise, but wasn't confident enough (confidence ${input.gateConfidence.toFixed(2)}) to drop it outright — its page was created and flagged for review instead of being silently discarded.

Gate's stated reason: ${input.dropReason}
Context where the entity was mentioned: ${input.entityContext}

Judge independently: does this deserve to exist as its own wiki page (keep), is it genuinely low-signal noise (drop), or is it unclear? Explain your reasoning in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "keep" | "drop" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

export const PROMPTS = {
  contradiction: { buildPrompt: buildContradictionPrompt, responseSchema: ContradictionSchema },
  duplicate: { buildPrompt: buildDuplicatePrompt, responseSchema: DuplicateSchema },
  ambiguous_entity: { buildPrompt: buildAmbiguousEntityPrompt, responseSchema: AmbiguousEntitySchema },
  uncertain_entity_drop: { buildPrompt: buildUncertainEntityDropPrompt, responseSchema: UncertainEntityDropSchema },
} as const;
```

**`matchedPath` validation** happens in the caller (`link-concepts.ts`), not here — `generateReviewAnalysis` returns whatever the model said verbatim; the caller checks it against its own candidate list before trusting it (Component 6).

## 6. Component 4 — `createReviewItem` extension

**File:** `src/review/create-review-item.ts`

```typescript
export interface ReviewItemInput {
  slug: string;
  title: string;
  claimA: string;
  claimB: string;
  sourceRefs: string[];
  links: string[];
  conflictType: string;
  body: string;
  /** LLM-assessed confidence bucket for this review item. Defaults to 'low' (today's hardcoded value) when omitted. */
  confidence?: 'low' | 'medium' | 'high';
}
```

One line changes inside the function: `confidence: input.confidence ?? 'low',` replacing the hardcoded `confidence: 'low',` in the frontmatter object. No other change — `createReviewItem` remains a pure "write this content" function exactly as designed in Sub-project A.

## 7. Component 5 — Contradiction & duplicate detectors

**File:** `src/review/contradiction-detector.ts`

`writeContradictionReview` gains parameters and delegates to `createReviewItem`:

```typescript
export async function writeContradictionReview(
  vault: VaultAdapter,
  config: KarpathyConfig,
  projectRoot: string,
  candidate: ContradictionCandidate,
): Promise<string> {
  const titleA = candidate.pageA.split('/').pop()?.replace(/\.md$/, '') ?? candidate.pageA;
  const titleB = candidate.pageB.split('/').pop()?.replace(/\.md$/, '') ?? candidate.pageB;

  const analysis = await generateReviewAnalysis(config, projectRoot, {
    kind: 'contradiction',
    pageATitle: titleA,
    pageBTitle: titleB,
    claimA: candidate.claimA,
    claimB: candidate.claimB,
  });

  const body = `
# Contradiction Candidate

## Page A
**Source:** [[${titleA}]]
> ${candidate.claimA}

## Page B
**Source:** [[${titleB}]]
> ${candidate.claimB}

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}

**Verdict:** ${analysis.verdict} (confidence: ${analysis.confidence.toFixed(2)})
${CLOSE_TAG('analysis')}
`;

  return createReviewItem(vault, {
    slug: candidate.reviewPath.replace(/^review\//, '').replace(/\.md$/, ''),
    title: `Contradiction: ${candidate.pageA} vs ${candidate.pageB}`,
    claimA: candidate.claimA,
    claimB: candidate.claimB,
    sourceRefs: [candidate.pageA, candidate.pageB],
    links: [candidate.pageA, candidate.pageB],
    conflictType: candidate.conflictType,
    confidence: bucketConfidence(analysis.confidence),
    body,
  });
}
```

The old inline `frontmatter`/`serializeNote`/`vault.exists`/`vault.write`/`vault.create` block is deleted — `createReviewItem` already does exactly this.

**File:** `src/review/duplicate-detector.ts` — same shape for `writeDuplicateReview`, plus `PageInfo` and `DuplicateCandidate` each gain an excerpt field:

```typescript
interface PageInfo {
  path: string;
  title: string;
  words: Set<string>;
  excerpt: string; // NEW — first ~400 chars of body, captured during the existing scan
  entityKind?: string;
  aliases: string[];
  sourceRefs: string[];
}
```

Populated in `detectDuplicates`'s existing per-page loop: `excerpt: body.trim().slice(0, 400)` — one extra field on an object already being built from data already read (`vault.read`/`parseNote` are already called for every page; this adds no new vault I/O). `DuplicateCandidate` gains `excerptA: string; excerptB: string`, populated from the two `PageInfo`s when a candidate pair is found.

**Both handlers pass config/projectRoot through:**

`src/jobs/handlers/detect-contradictions.ts`: `await writeContradictionReview(context.vault, context.config, context.projectRoot, candidate);`
`src/jobs/handlers/detect-duplicates.ts`: `await writeDuplicateReview(context.vault, context.config, context.projectRoot, candidate);`

## 8. Component 6 — Ambiguous entity (`link-concepts.ts`)

Inside the existing `resolution.status === 'ambiguous'` branch. `candidateList` (the existing `candidates.map((c) => \`- [[...]] (confidence: ...)\`).join('\n')` markdown line) is untouched, pre-existing code, reused as-is in the body template below — only `candidateDetails` (a separate, richer array built for the LLM prompt) and the analysis/match logic around it are new:

```typescript
const candidateDetails = await Promise.all(
  candidates.map(async (c) => {
    const content = await context.vault.read(c.path);
    const { data, body } = parseNote(content);
    return {
      path: c.path,
      title: (data.title as string) ?? c.path.split('/').pop()?.replace(/\.md$/, '') ?? c.path,
      excerpt: body.replace(/%%[\s\S]*?%%/g, '').trim().slice(0, 300),
    };
  }),
);

const analysis = await generateReviewAnalysis(context.config, context.projectRoot, {
  kind: 'ambiguous_entity',
  entityName: entity.name,
  entityKind: kind,
  sourceContext: entity.context ?? entity.definition ?? '(no additional context)',
  candidates: candidateDetails,
});

const validatedMatch =
  analysis.verdict === 'match' && candidateDetails.some((c) => c.path === analysis.matchedPath)
    ? analysis.matchedPath
    : undefined;

const matchNote = validatedMatch
  ? `\n\n**Suggested match:** [[${validatedMatch.split('/').pop()?.replace(/\.md$/, '')}]] (unconfirmed — approve or dismiss below)`
  : '';

await createReviewItem(context.vault, {
  slug: slugify(`ambiguous-${entity.name}`),
  title: `Ambiguous: ${entity.name} (${kind})`,
  claimA: `Entity "${entity.name}" found in ${summaryPath}`,
  claimB: `Multiple matching pages: ${candidates.map((c) => c.path).join(', ')}`,
  sourceRefs: [summaryPath],
  links: candidates.map((c) => c.path),
  conflictType: 'ambiguous_entity',
  confidence: bucketConfidence(analysis.confidence),
  body: `
# Ambiguous Entity: ${entity.name}

**Kind:** ${kind}
**Source:** [[${summaryPath.split('/').pop()?.replace(/\.md$/, '')}]]

## Candidates
${candidateList}

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}${matchNote}
${CLOSE_TAG('analysis')}
`,
});
```

`%%[\s\S]*?%%/g` strips protected-region tags (`OPEN_TAG`/`CLOSE_TAG` produce `%% begin:id %%`/`%% end:id %%` markers) from the excerpt so the prompt isn't cluttered with machine markup — a plain regex is sufficient here since this is a read-only display excerpt, not a re-parse.

If the model names a `matchedPath` not present in `candidateDetails`, `validatedMatch` is `undefined` and the note simply omits the suggested-match line — no auto-action is ever taken regardless of the verdict.

## 9. Component 7 — Uncertain entity drop (`compiler.ts`)

No new data fetching — everything needed is already in scope in the existing branch:

```typescript
const analysis = await generateReviewAnalysis(config, projectRoot, {
  kind: 'uncertain_entity_drop',
  entityName: entity.name,
  entityKind: entity.kind,
  entityContext: entity.context,
  dropReason: flaggedForReview.reason,
  gateConfidence: flaggedForReview.confidence ?? 0,
});

await createReviewItem(vault, {
  slug: `uncertain-drop-${slug}`,
  title: `Uncertain: ${entity.name} (${entity.kind})`,
  claimA: `Significance gate suggested dropping this entity: ${flaggedForReview.reason}`,
  claimB: `Confidence ${flaggedForReview.confidence} is below the review threshold (${config.enrichment.significanceGateDropConfidence})`,
  sourceRefs: [sourcePath],
  links: [createdPath],
  conflictType: 'uncertain_entity_drop',
  confidence: bucketConfidence(analysis.confidence),
  body: `
# Uncertain: ${entity.name}

**Kind:** ${entity.kind}
**Page created:** [[${slug}]]
**Source:** [[${sourcePath.split('/').pop()?.replace(/\.md$/, '')}]]

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}

**Verdict:** ${analysis.verdict} (confidence: ${analysis.confidence.toFixed(2)})
${CLOSE_TAG('analysis')}
`,
});
```

This call site already sits inside a `try { ... } catch (err) { log.error(...) }` block (added originally so a review-item failure wouldn't blow up an otherwise-successful entity-page creation) — a rethrown `TransientLLMError` from `generateReviewAnalysis` is caught there today. **This needs to change**: that catch must let `TransientLLMError` through too (`if (err instanceof TransientLLMError) throw err;`, same pattern as everywhere else), otherwise a VPN outage during review-item creation would silently proceed as if analysis generation had merely failed to log, defeating the whole point of Component 2's design. This is folded into this component's changes, not a separate task.

## 10. Config schema changes

**File:** `src/config/schema.ts`

```typescript
export const ReviewConfigSchema = z.object({
  analysisEnabled: z.boolean().default(true),
  confidenceEscalationThreshold: z.number().min(0).max(1).default(0.7),
});
```

Wired into `KarpathyConfigSchema` (`review: ReviewConfigSchema.default({})`), plus the corresponding `PartialReviewConfigSchema` entries in `ProjectOverrideSchema`/`GlobalDefaultsSchema`, following the exact same three-edit pattern established for `jobs.transientRetry` in the VPN-retry work. `mergeOverride()` in `src/config/loader.ts` needs no changes (already generic by key name).

## 11. Data model / frontmatter

No frontmatter schema changes. `createReviewItem`'s `confidence` field already exists in the base schema (`z.enum(['low','medium','high'])` categorical, not new) — this spec just stops hardcoding it to `'low'`.

## 12. Decision tables

**Per-kind verdict meaning:**

| Kind | Verdict values | What "match"/positive means |
|---|---|---|
| contradiction | `genuine_conflict` / `false_positive` / `unclear` | The two claims actually conflict, not just share vocabulary |
| duplicate | `same_entity` / `different_entities` / `unclear` | The two pages describe the same real-world thing |
| ambiguous_entity | `match` / `no_match` / `unclear` | One specific candidate is confirmed as the right page for this mention |
| uncertain_entity_drop | `keep` / `drop` / `unclear` | The entity independently deserves its own page |

**Tier/fallback outcome**: see the table in §4.

## 13. Observability

No new `log.md` vault entries (matches the VPN-retry work's precedent — this is generation-quality infrastructure, not curated content). `generateReviewAnalysis`'s `tier` field (`'fast'|'medium'|'placeholder'`) is available to whichever caller wants to log it via the existing `createLogger` convention, so it's possible to later measure how often the fallback actually fires — not required by this spec, just not precluded.

## 14. Testing plan

- `generateReviewAnalysis`: every row of §4's behavior table, using a fake `LLMClient` per tier (mock via `vi.mock` on `llm-factory.js`, matching the established convention from the VPN-retry work's `llm-factory.test.ts`). Specifically: fast confident → returns fast, medium never constructed; fast unconfident → medium succeeds → returns medium; fast throws non-transient → medium succeeds; fast throws `TransientLLMError` → rethrows without touching medium/placeholder, verified via `rejects.toBeInstanceOf(TransientLLMError)`; both fail → returns fast's low-confidence result; fast never attempted (budget pre-exhausted) → placeholder immediately; `config.review.analysisEnabled: false` → placeholder immediately, no client constructed at all.
- `bucketConfidence`: the three cutoffs (0.69 → low boundary check at 0.4/0.7 inclusive).
- Each of the four prompt/schema pairs: valid model output parses; malformed output (missing field, out-of-range confidence) is rejected by Zod.
- `contradiction-detector.ts`/`duplicate-detector.ts`: `writeContradictionReview`/`writeDuplicateReview` produce a note whose body contains the mocked analysis's `reasoning`, and whose frontmatter `confidence` matches `bucketConfidence(analysis.confidence)`. Regression: existing detection-logic tests (`detectContradictions`/`detectDuplicates`'s heuristics themselves) are untouched by this spec and must keep passing unmodified.
- `link-concepts.ts`: a test where the model names a `matchedPath` not in the candidate list — assert the note omits the suggested-match line rather than trusting it. A regression test for the existing ambiguous-entity note structure (candidate list, body sections) with the new analysis content substituted in place of the old generic checklist text.
- `compiler.ts`: a test that a `TransientLLMError` from `generateReviewAnalysis` inside the uncertain-drop branch propagates out of `compileFromSource` (not swallowed by the surrounding `try/catch`), consistent with the per-entity catch fixed in the VPN-retry work's Task 8.
- `createLLMFromConfig`: `tier` omitted behaves identically to before (regression); each tier value selects the corresponding `config.llm.models[tier]`.

## 15. Explicitly deferred

- B2b (wiki page content richness) and B2c (person name resolution) — separate specs.
- Auto-resolution of any review kind based on the LLM's verdict.
- A `heavy`-tier escalation path.
- Instrumenting/reporting how often the fast→medium→placeholder fallback fires in practice (the `tier` field exists for this; building a report on top of it is not requested).

## 16. Open implementation questions (for the plan phase, not product decisions)

- Confirm `contradiction-detector.ts`/`duplicate-detector.ts`'s existing `reviewPath`/`slug` construction (`slugify(...)`) can be reused as-is for the `slug` field `createReviewItem` expects (it wants the slug without the `review/` prefix or `.md` suffix — the sketch above strips both defensively; confirm this matches `slugify`'s actual output format during implementation).
- Confirm exact `resolveStateDir` import path from `src/review/` (one level of nesting from `src/`, same depth as `src/enrichment/`) — mechanical, but worth a quick check against the real file during implementation.

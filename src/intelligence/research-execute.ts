// D3: Tiered research executor.
//
// Executes a single approved research request at the configured depth. The
// loop is bounded:
//   light  → 1 round × 3 framings
//   medium → 2 rounds × 5 framings
//   heavy  → 3 rounds × 7 framings
//
// Search/fetch is pluggable via the `WebSearch` interface — by default we use
// the LLM's own knowledge (same approach as the existing web-enricher) so this
// works offline. A user can wire in Tavily/Brave by passing a real `WebSearch`.

import { z } from 'zod';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG, updateProtectedRegion } from '../vault/protected-regions.js';
import { defaultStability } from '../vault/half-life.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { layoutFromConfig } from '../vault/paths.js';
import {
  type ResearchDepth,
  upsertCandidate,
  readResearchQueue,
} from '../maintenance/research-queue.js';

export const TLDR_REGION = 'tldr';
export const RESEARCH_REGION = 'research';
export const SOURCES_REGION = 'sources';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}
export interface WebSearch {
  search(query: string, topK: number): Promise<SearchResult[]>;
}

const DEPTH_PROFILES: Record<Exclude<ResearchDepth, 'skip'>, { rounds: number; perRound: number; topSources: number }> = {
  light: { rounds: 1, perRound: 3, topSources: 3 },
  medium: { rounds: 2, perRound: 5, topSources: 8 },
  heavy: { rounds: 3, perRound: 7, topSources: 15 },
};

const FRAMINGS_LIGHT = ['definition', 'recent', 'applied example'];
const FRAMINGS_MEDIUM = [...FRAMINGS_LIGHT, 'comparison', 'contrarian'];
const FRAMINGS_HEAVY = [...FRAMINGS_MEDIUM, 'historical', 'benchmarks', 'community discussion'];

const COVERAGE_KEYS = ['what-is', 'why-it-matters', 'how-it-works', 'alternatives', 'recent-changes'];

const SynthesisSchema = z.object({
  tldr: z.string(),
  body: z.string(),
  claims: z
    .array(z.object({ claim: z.string(), confidence: z.enum(['low', 'medium', 'high']).default('medium') }))
    .default([]),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  coverage: z
    .object({
      'what-is': z.boolean().default(false),
      'why-it-matters': z.boolean().default(false),
      'how-it-works': z.boolean().default(false),
      alternatives: z.boolean().default(false),
      'recent-changes': z.boolean().default(false),
    })
    .default({}),
});

export interface ResearchExecuteOptions {
  depth: ResearchDepth;
  notePath?: string;
  search?: WebSearch;
  nowMs?: number;
}

export interface ResearchExecuteDeps {
  vault: VaultAdapter;
  llm: LLMClient;
  config: KarpathyConfig;
}

export interface ResearchExecuteResult {
  slug: string;
  depth: ResearchDepth;
  notePath: string;
  rounds: number;
  totalQueries: number;
  totalSources: number;
  coverage: Record<string, boolean>;
}

export async function executeResearch(
  deps: ResearchExecuteDeps,
  slug: string,
  options: ResearchExecuteOptions,
): Promise<ResearchExecuteResult> {
  if (options.depth === 'skip') {
    throw new Error(`cannot execute research with depth=skip (slug=${slug})`);
  }
  const profile = DEPTH_PROFILES[options.depth];
  const framings =
    options.depth === 'light' ? FRAMINGS_LIGHT : options.depth === 'medium' ? FRAMINGS_MEDIUM : FRAMINGS_HEAVY;
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const layout = layoutFromConfig(deps.config);
  const conceptsFolder = `${layout.wiki}/concepts`;
  const notePath = options.notePath ?? `${conceptsFolder}/${slug}.md`;
  const titleHint = await loadTitleHint(deps.vault, notePath, slug);

  // Round-based query loop with coverage check.
  let allSources: SearchResult[] = [];
  let queries = 0;
  let lastSynthesis: z.infer<typeof SynthesisSchema> | null = null;

  for (let round = 0; round < profile.rounds; round++) {
    const roundFramings = framings.slice(0, profile.perRound);
    const gapTargets =
      lastSynthesis && round > 0
        ? COVERAGE_KEYS.filter((k) => !(lastSynthesis!.coverage as Record<string, boolean>)[k])
        : [];

    const roundQueries = [
      ...roundFramings.map((f) => `${titleHint} ${f}`),
      ...gapTargets.map((g) => `${titleHint} ${g.replace('-', ' ')}`),
    ];
    queries += roundQueries.length;

    if (options.search) {
      for (const q of roundQueries) {
        try {
          const hits = await options.search.search(q, profile.topSources);
          allSources.push(...hits);
        } catch {
          // Tolerate per-query failures.
        }
      }
    }
    // Dedup by URL.
    allSources = dedupeBy(allSources, (s) => s.url).slice(0, profile.topSources);

    lastSynthesis = await synthesize(deps.llm, {
      title: titleHint,
      sources: allSources,
      depth: options.depth,
    });

    // Coverage check: if we have full coverage, exit early (saves $$$ at heavy).
    const covered = COVERAGE_KEYS.every(
      (k) => (lastSynthesis!.coverage as Record<string, boolean>)[k],
    );
    if (covered) break;
  }

  if (!lastSynthesis) {
    throw new Error(`research synthesis returned nothing for ${slug}`);
  }

  await writeConceptNote(deps, {
    slug,
    notePath,
    title: titleHint,
    synthesis: lastSynthesis,
    sources: allSources,
    nowIso,
    depth: options.depth,
    conceptsFolder,
  });

  // Update queue row as completed.
  const queue = await readResearchQueue(deps.vault, layout);
  const prior = queue.candidates.find((c) => c.slug === slug);
  await upsertCandidate(
    deps.vault,
    {
      slug,
      title: titleHint,
      score: prior?.score ?? 0,
      reason: prior?.reason ?? 'Completed',
      suggested: (prior?.suggested ?? 'medium') as 'light' | 'medium' | 'heavy',
      decision: options.depth,
      status: 'completed',
      addedAt: prior?.addedAt ?? nowIso,
      completedAt: nowIso,
      completedDepth: options.depth,
    },
    layout,
  );

  await appendLogEntry(
    deps.vault,
    {
      kind: 'research:execute',
      message: `${slug} (${options.depth}) — ${queries} queries, ${allSources.length} sources`,
      at: nowIso,
    },
    layout,
  );

  return {
    slug,
    depth: options.depth,
    notePath,
    rounds: profile.rounds,
    totalQueries: queries,
    totalSources: allSources.length,
    coverage: lastSynthesis.coverage as Record<string, boolean>,
  };
}

async function loadTitleHint(vault: VaultAdapter, notePath: string, slug: string): Promise<string> {
  if (!(await vault.exists(notePath))) return slug.replace(/-/g, ' ');
  const { data } = parseNote(await vault.read(notePath));
  const fm = data as Record<string, unknown>;
  return typeof fm.title === 'string' && fm.title ? fm.title : slug.replace(/-/g, ' ');
}

function dedupeBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function synthesize(
  llm: LLMClient,
  args: { title: string; sources: SearchResult[]; depth: ResearchDepth },
): Promise<z.infer<typeof SynthesisSchema>> {
  const sourceBlock =
    args.sources.length > 0
      ? args.sources
          .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.snippet}`)
          .join('\n\n')
      : '(no external sources fetched — use your own knowledge)';

  const prompt = `You are a research assistant filling out a concept page in a knowledge base.

Concept: ${args.title}
Depth: ${args.depth}

Sources:
${sourceBlock}

Produce a JSON object with these fields:
{
  "tldr": "≤120 char chain-of-density summary",
  "body": "Markdown body, structured with sections: ## What it is, ## Why it matters, ## How it works, ## Alternatives, ## Recent changes. Cite sources inline as [n]. Be honest about gaps.",
  "claims": [{ "claim": "single-sentence claim", "confidence": "low|medium|high" }],
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "coverage": { "what-is": true, "why-it-matters": true, "how-it-works": true, "alternatives": true, "recent-changes": true }
}

Each coverage flag should be true ONLY if the body covers that aspect substantively. Output ONLY a single fenced \`\`\`json block.`;
  return llm.extractStructured(prompt, SynthesisSchema);
}

interface WriteArgs {
  slug: string;
  notePath: string;
  title: string;
  synthesis: z.infer<typeof SynthesisSchema>;
  sources: SearchResult[];
  nowIso: string;
  depth: ResearchDepth;
  conceptsFolder: string;
}

async function writeConceptNote(deps: ResearchExecuteDeps, args: WriteArgs): Promise<void> {
  await deps.vault.ensureFolder(args.conceptsFolder);
  const exists = await deps.vault.exists(args.notePath);

  let fm: Record<string, unknown>;
  let body: string;
  if (exists) {
    const parsed = parseNote(await deps.vault.read(args.notePath));
    fm = parsed.data as Record<string, unknown>;
    body = parsed.body;
  } else {
    fm = {
      id: args.slug,
      type: 'concept',
      title: args.title,
      created_at: args.nowIso,
      updated_at: args.nowIso,
      status: 'active',
      half_life_domain: 'concept',
    };
    body = `# ${args.title}\n\n`;
  }

  fm.updated_at = args.nowIso;
  fm.last_verified = args.nowIso;
  fm.tldr = args.synthesis.tldr.slice(0, 120);
  fm.tldr_updated_at = args.nowIso;
  fm.last_research_depth = args.depth;
  fm.last_research_at = args.nowIso;

  // Bump stability based on coverage completeness — full coverage doubles
  // domain default, partial coverage gives 1.2× whatever's there.
  const coveredCount = Object.values(args.synthesis.coverage).filter(Boolean).length;
  const baseDomain = (typeof fm.half_life_domain === 'string' ? fm.half_life_domain : 'concept');
  const baseStability = defaultStability(baseDomain);
  const prevStab = typeof fm.stability === 'number' ? fm.stability : baseStability;
  const factor = coveredCount === 5 ? 2.0 : coveredCount >= 3 ? 1.4 : 1.1;
  fm.stability = Math.round(Math.min(baseStability * 4, prevStab * factor));

  // Confidence from claims (highest confidence claim wins).
  const confidences = args.synthesis.claims.map((c) => c.confidence);
  if (confidences.includes('high')) fm.confidence = 'high';
  else if (confidences.includes('medium')) fm.confidence = 'medium';
  else if (confidences.length > 0) fm.confidence = 'low';

  // TL;DR region.
  body = upsertRegion(body, TLDR_REGION, `> **TL;DR** — ${fm.tldr}`);

  // Research region (the body itself).
  body = upsertRegion(body, RESEARCH_REGION, args.synthesis.body.trim());

  // Sources region.
  const existingSources = parseSourcesRegion(extractRegion(body, SOURCES_REGION) ?? '');
  const newUrls = args.sources.map((s) => s.url);
  const merged = [...new Set([...existingSources, ...newUrls])].sort();
  const sourcesBlock = merged.map((u) => `- ${u}`).join('\n');
  body = upsertRegion(body, SOURCES_REGION, sourcesBlock);

  // Track regions in frontmatter.
  const regions = new Set<string>(
    Array.isArray(fm.protected_regions) ? (fm.protected_regions as string[]) : [],
  );
  regions.add(TLDR_REGION);
  regions.add(RESEARCH_REGION);
  regions.add(SOURCES_REGION);
  fm.protected_regions = [...regions];

  await deps.vault.atomicWrite(args.notePath, serializeNote(fm, body));
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

function parseSourcesRegion(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(https?:\/\/\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { slugify } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';
import type { KarpathyConfig } from '../config/schema.js';
import { generateReviewAnalysis, bucketConfidence } from './generate-review-analysis.js';
import { createReviewItem } from './create-review-item.js';

const log = createLogger('duplicates');

export interface DuplicateCandidate {
  pathA: string;
  pathB: string;
  titleA: string;
  titleB: string;
  excerptA: string;
  excerptB: string;
  similarity: number;
  reviewPath: string;
}

interface PageInfo {
  path: string;
  title: string;
  words: Set<string>;
  excerpt: string;
  entityKind?: string;
  aliases: string[];
  sourceRefs: string[];
}

export async function detectDuplicates(
  vault: VaultAdapter,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const wikiPaths = await vault.listMarkdownFiles('wiki');

  const pages: PageInfo[] = [];

  for (const path of wikiPaths) {
    if (path.endsWith('_index.md')) continue;
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    const title = (data.title as string) ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    const words = new Set(
      (title + ' ' + body)
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    pages.push({
      path,
      title,
      words,
      excerpt: body.trim().slice(0, 400),
      entityKind: data.entity_kind as string | undefined,
      aliases: (data.aliases as string[] | undefined) ?? [],
      sourceRefs: (data.source_refs as string[] | undefined) ?? [],
    });
  }

  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const sim = compositeSimilarity(pages[i], pages[j]);
      if (sim > 0.6) {
        const slug = slugify(`duplicate-${pages[i].title}-${pages[j].title}`);
        candidates.push({
          pathA: pages[i].path,
          pathB: pages[j].path,
          titleA: pages[i].title,
          titleB: pages[j].title,
          excerptA: pages[i].excerpt,
          excerptB: pages[j].excerpt,
          similarity: Math.round(sim * 100),
          reviewPath: `review/${slug}.md`,
        });
      }
    }
  }

  return candidates;
}

/** Composite similarity: Jaccard base + frontmatter bonuses. */
function compositeSimilarity(a: PageInfo, b: PageInfo): number {
  let score = jaccardSimilarity(a.words, b.words);

  // Bonus: same entity_kind
  if (a.entityKind && b.entityKind && a.entityKind === b.entityKind) {
    score += 0.2;
  }

  // Bonus: shared aliases
  const sharedAliases = a.aliases.filter((al) =>
    b.aliases.some((bl) => al.toLowerCase() === bl.toLowerCase()),
  );
  score += sharedAliases.length * 0.15;

  // Bonus: shared source_refs
  const sharedRefs = a.sourceRefs.filter((r) => b.sourceRefs.includes(r));
  score += sharedRefs.length * 0.1;

  return Math.min(score, 1.0);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

export async function writeDuplicateReview(
  vault: VaultAdapter,
  config: KarpathyConfig,
  projectRoot: string,
  candidate: DuplicateCandidate,
): Promise<string> {
  const analysis = await generateReviewAnalysis(config, projectRoot, {
    kind: 'duplicate',
    titleA: candidate.titleA,
    titleB: candidate.titleB,
    excerptA: candidate.excerptA,
    excerptB: candidate.excerptB,
    wordOverlapPercent: candidate.similarity,
  });

  const body = `
# Duplicate Candidate (${candidate.similarity}% similarity)

## Page A
**[[${candidate.titleA}]]** — \`${candidate.pathA}\`

## Page B
**[[${candidate.titleB}]]** — \`${candidate.pathB}\`

## Analysis
${OPEN_TAG('analysis')}
${analysis.reasoning}

**Verdict:** ${analysis.verdict} (confidence: ${analysis.confidence.toFixed(2)})
${CLOSE_TAG('analysis')}
`;

  const slug = candidate.reviewPath.replace(/^review\//, '').replace(/\.md$/, '');

  const path = await createReviewItem(vault, {
    slug,
    title: `Duplicate: ${candidate.titleA} / ${candidate.titleB}`,
    claimA: `Page: ${candidate.titleA}`,
    claimB: `Page: ${candidate.titleB}`,
    sourceRefs: [candidate.pathA, candidate.pathB],
    links: [candidate.pathA, candidate.pathB],
    conflictType: 'duplicate_candidate',
    confidence: bucketConfidence(analysis.confidence),
    body,
  });

  log.info('Duplicate review created', { path });
  return path;
}

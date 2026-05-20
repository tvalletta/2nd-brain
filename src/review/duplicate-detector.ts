import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { nanoid } from 'nanoid';
import { nowISO } from '../shared/date-utils.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { slugify } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('duplicates');

export interface DuplicateCandidate {
  pathA: string;
  pathB: string;
  titleA: string;
  titleB: string;
  similarity: number;
  reviewPath: string;
}

interface PageInfo {
  path: string;
  title: string;
  words: Set<string>;
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
  candidate: DuplicateCandidate,
): Promise<string> {
  await vault.ensureFolder('review');

  const frontmatter = {
    id: nanoid(),
    type: 'contradiction',
    title: `Duplicate: ${candidate.titleA} / ${candidate.titleB}`,
    status: 'draft',
    confidence: 'low',
    review_state: 'unreviewed',
    created_at: nowISO(),
    updated_at: nowISO(),
    conflict_type: 'duplicate_candidate',
    claim_a: `Page: ${candidate.titleA}`,
    claim_b: `Page: ${candidate.titleB}`,
    resolution_state: 'open',
    source_refs: [candidate.pathA, candidate.pathB],
    derived_from: [],
    aliases: [],
    links: [candidate.pathA, candidate.pathB],
    change_origin: 'heuristic_review',
    protected_regions: ['analysis'],
  };

  const body = `
# Duplicate Candidate (${candidate.similarity}% similarity)

## Page A
**[[${candidate.titleA}]]** — \`${candidate.pathA}\`

## Page B
**[[${candidate.titleB}]]** — \`${candidate.pathB}\`

## Analysis
${OPEN_TAG('analysis')}
These pages have ${candidate.similarity}% word overlap. Review and merge if appropriate.
${CLOSE_TAG('analysis')}
`;

  const content = serializeNote(frontmatter, body);

  if (await vault.exists(candidate.reviewPath)) {
    await vault.write(candidate.reviewPath, content);
  } else {
    await vault.create(candidate.reviewPath, content);
  }

  log.info('Duplicate review created', { path: candidate.reviewPath });
  return candidate.reviewPath;
}

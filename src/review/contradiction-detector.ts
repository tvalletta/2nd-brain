import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { nanoid } from 'nanoid';
import { nowISO } from '../shared/date-utils.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { slugify } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('contradictions');

export interface ContradictionCandidate {
  pageA: string;
  pageB: string;
  claimA: string;
  claimB: string;
  conflictType: string;
  reviewPath: string;
}

/**
 * Detect potential contradictions by comparing claims across wiki pages.
 * This is a heuristic detector — it flags candidates for human review.
 * Currently uses simple text overlap; LLM-based detection is Phase 4+ work.
 */
export async function detectContradictions(
  vault: VaultAdapter,
): Promise<ContradictionCandidate[]> {
  const candidates: ContradictionCandidate[] = [];
  const wikiPaths = await vault.listMarkdownFiles('wiki');

  // Build a map of pages to their key claims (from frontmatter + headers)
  const pageClaims = new Map<string, { title: string; claims: string[] }>();

  for (const path of wikiPaths) {
    if (path.endsWith('_index.md')) continue;
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    const title = (data.title as string) ?? path;

    // Extract claims from decision/status fields and headers
    const claims: string[] = [];
    if (data.decision_status) claims.push(`decision_status: ${data.decision_status}`);
    if (data.project_status) claims.push(`project_status: ${data.project_status}`);

    // Extract "decided" or "concluded" sentences
    const sentences = body.split(/[.!?]\s+/).filter((s) => {
      const lower = s.toLowerCase();
      return (
        lower.includes('decided') ||
        lower.includes('concluded') ||
        lower.includes('confirmed') ||
        lower.includes('deadline') ||
        lower.includes('must') ||
        lower.includes('will not')
      );
    });
    claims.push(...sentences.map((s) => s.trim()).filter((s) => s.length > 10));

    if (claims.length > 0) {
      pageClaims.set(path, { title, claims });
    }
  }

  // Cross-reference: find overlapping subjects with conflicting claims
  const paths = [...pageClaims.keys()];
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = pageClaims.get(paths[i])!;
      const b = pageClaims.get(paths[j])!;

      for (const claimA of a.claims) {
        for (const claimB of b.claims) {
          // Simple heuristic: same subject word overlap but different conclusions
          if (hasConflictSignal(claimA, claimB)) {
            const slug = slugify(`contradiction-${a.title}-${b.title}`);
            const reviewPath = `review/${slug}.md`;

            candidates.push({
              pageA: paths[i],
              pageB: paths[j],
              claimA: claimA.slice(0, 200),
              claimB: claimB.slice(0, 200),
              conflictType: 'potential_factual',
              reviewPath,
            });
          }
        }
      }
    }
  }

  return candidates;
}

function hasConflictSignal(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

  // Need some overlap (same subject)
  const overlap = [...wordsA].filter((w) => wordsB.has(w));
  if (overlap.length < 2) return false;

  // Check 1: Negation divergence — one negates, the other doesn't
  const negationWords = ['not', 'never', 'cannot', 'won\'t', 'shouldn\'t', 'rejected', 'cancelled'];
  const aNeg = negationWords.some((w) => a.toLowerCase().includes(w));
  const bNeg = negationWords.some((w) => b.toLowerCase().includes(w));
  if (aNeg !== bNeg) return true;

  // Check 2: Conflicting dates on the same subject
  const datesA = extractDates(a);
  const datesB = extractDates(b);
  if (datesA.length > 0 && datesB.length > 0 && !datesA.some((d) => datesB.includes(d))) {
    return true;
  }

  // Check 3: Conflicting numbers on the same subject
  const numsA = extractNumbers(a);
  const numsB = extractNumbers(b);
  if (numsA.length > 0 && numsB.length > 0 && !numsA.some((n) => numsB.includes(n))) {
    return true;
  }

  return false;
}

/** Extract ISO dates (YYYY-MM-DD) and month-name dates (e.g. "March 1", "April 2026"). */
function extractDates(text: string): string[] {
  const dates: string[] = [];

  // ISO dates: 2026-03-01
  const isoMatches = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (isoMatches) dates.push(...isoMatches);

  // Month-name dates: "March 1", "April 2026", "Jan 15"
  const monthPattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/gi;
  const monthMatches = text.match(monthPattern);
  if (monthMatches) dates.push(...monthMatches.map((d) => d.toLowerCase()));

  return dates;
}

/** Extract significant numbers (dollar amounts, quantities with K/M suffixes). */
function extractNumbers(text: string): string[] {
  const pattern = /\$?\d+(?:,\d{3})*(?:\.\d+)?[KkMmBb]?\b/g;
  const matches = text.match(pattern);
  if (!matches) return [];
  // Filter out very small numbers (likely not significant claims)
  return matches.filter((m) => {
    const num = parseFloat(m.replace(/[$,KkMmBb]/g, ''));
    return num >= 2;
  });
}

export async function writeContradictionReview(
  vault: VaultAdapter,
  candidate: ContradictionCandidate,
): Promise<string> {
  await vault.ensureFolder('review');

  const frontmatter = {
    id: nanoid(),
    type: 'contradiction',
    title: `Contradiction: ${candidate.pageA} vs ${candidate.pageB}`,
    status: 'draft',
    confidence: 'low',
    review_state: 'unreviewed',
    created_at: nowISO(),
    updated_at: nowISO(),
    conflict_type: candidate.conflictType,
    claim_a: candidate.claimA,
    claim_b: candidate.claimB,
    resolution_state: 'open',
    source_refs: [candidate.pageA, candidate.pageB],
    derived_from: [],
    aliases: [],
    links: [candidate.pageA, candidate.pageB],
    change_origin: 'heuristic_review',
    protected_regions: ['analysis'],
  };

  const body = `
# Contradiction Candidate

## Page A
**Source:** [[${candidate.pageA.replace(/\.md$/, '').split('/').pop()}]]
> ${candidate.claimA}

## Page B
**Source:** [[${candidate.pageB.replace(/\.md$/, '').split('/').pop()}]]
> ${candidate.claimB}

## Analysis
${OPEN_TAG('analysis')}
Pending human review.
${CLOSE_TAG('analysis')}
`;

  const content = serializeNote(frontmatter, body);

  if (await vault.exists(candidate.reviewPath)) {
    await vault.write(candidate.reviewPath, content);
  } else {
    await vault.create(candidate.reviewPath, content);
  }

  log.info('Contradiction review created', { path: candidate.reviewPath });
  return candidate.reviewPath;
}

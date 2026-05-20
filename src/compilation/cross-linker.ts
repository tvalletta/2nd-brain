import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import { buildEntityIndex } from '../ingest/entity-resolver.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { slugify } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cross-linker');

export interface CrossLinkResult {
  linksInserted: number;
  pagesUpdated: string[];
}

/**
 * Scan the given pages for bare mentions of known entities and replace them
 * with `[[entity-slug|mention text]]` wikilinks.
 *
 * Uses deterministic string matching -- no LLM required for most cases.
 * The optional `llm` parameter is accepted for interface consistency but
 * is not currently used.
 */
export async function crossLinkPages(
  pagePaths: string[],
  context: { vault: VaultAdapter; llm?: LLMClient },
): Promise<CrossLinkResult> {
  const { vault } = context;

  log.info('Starting cross-linking', { pageCount: pagePaths.length });

  const entityIndex = await buildEntityIndex(vault);
  const lookupTable = buildLookupTable(entityIndex);

  let totalLinksInserted = 0;
  const pagesUpdated: string[] = [];

  for (const pagePath of pagePaths) {
    try {
      const content = await vault.read(pagePath);
      const { data, body } = parseNote(content);

      const pageTitle = (data.title as string) ?? '';
      const pageCanonicalName = (data.canonical_name as string) ?? '';

      const { updatedBody, linksInserted } = insertWikilinks(
        body,
        lookupTable,
        pageTitle,
        pageCanonicalName,
      );

      if (linksInserted > 0) {
        const result = serializeNote(data, updatedBody);
        await vault.atomicWrite(pagePath, result);
        totalLinksInserted += linksInserted;
        pagesUpdated.push(pagePath);
        log.info('Cross-linked page', { path: pagePath, linksInserted });
      }
    } catch (err) {
      log.warn('Failed to cross-link page', {
        path: pagePath,
        error: (err as Error).message,
      });
    }
  }

  log.info('Cross-linking complete', {
    totalLinksInserted,
    pagesUpdated: pagesUpdated.length,
  });

  return { linksInserted: totalLinksInserted, pagesUpdated };
}

// --- Internal types and helpers ---

interface LookupEntry {
  name: string;
  slug: string;
  pattern: RegExp;
}

/**
 * Build a lookup table of entity names/aliases sorted longest-first
 * so that longer names are matched before shorter substrings.
 */
function buildLookupTable(index: EntityIndex): LookupEntry[] {
  const entries: LookupEntry[] = [];
  const seen = new Set<string>();

  for (const entry of index.allEntries) {
    const names = [entry.name, ...entry.aliases];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (seen.has(lower) || name.length < 2) continue;
      seen.add(lower);

      entries.push({
        name,
        slug: entry.slug,
        pattern: buildMentionPattern(name),
      });
    }
  }

  // Sort longest-first so "Alice Chen" matches before "Alice"
  entries.sort((a, b) => b.name.length - a.name.length);

  return entries;
}

/**
 * Build a regex that matches a bare mention of an entity name.
 * - Case-insensitive
 * - Word-boundary aware
 * - Handles optional possessive suffix (Alice's)
 * - Does NOT match inside existing wikilinks `[[...]]`
 */
function buildMentionPattern(name: string): RegExp {
  const escaped = escapeRegex(name);
  // Match the name at a word boundary, optionally followed by 's
  return new RegExp(`(?<![\\[\\w])${escaped}(?:'s)?(?![\\]\\w])`, 'gi');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert wikilinks into a page body for all known entity mentions.
 *
 * Rules:
 * - Don't link inside existing `[[wikilinks]]`
 * - Don't link inside headings that ARE the entity name (the page's own title)
 * - Handle possessives: "Alice's" becomes "[[alice-chen|Alice]]'s"
 * - Case-insensitive matching
 * - Only link the first occurrence of each entity per page
 */
function insertWikilinks(
  body: string,
  lookupTable: LookupEntry[],
  pageTitle: string,
  pageCanonicalName: string,
): { updatedBody: string; linksInserted: number } {
  let result = body;
  let linksInserted = 0;

  // Track which slugs we've already linked to avoid duplicates
  const linkedSlugs = new Set<string>();

  // Also collect existing wikilink targets so we don't double-link
  const existingLinks = extractExistingWikilinkTargets(body);

  for (const entry of lookupTable) {
    // Skip if this entity is the page itself
    if (
      entry.name.toLowerCase() === pageTitle.toLowerCase() ||
      entry.name.toLowerCase() === pageCanonicalName.toLowerCase()
    ) {
      continue;
    }

    // Skip if we already linked to this slug
    if (linkedSlugs.has(entry.slug)) continue;

    // Skip if this entity is already wikilinked somewhere in the page
    if (existingLinks.has(entry.slug)) continue;

    // Find the first match that is NOT inside a wikilink or heading
    const match = findSafeMatch(result, entry.pattern);
    if (!match) continue;

    const matchedText = match.text;
    const isPossessive = matchedText.endsWith("'s");
    const baseName = isPossessive ? matchedText.slice(0, -2) : matchedText;
    const suffix = isPossessive ? "'s" : '';

    // Build the wikilink
    const wikilink = baseName.toLowerCase() === entry.slug
      ? `[[${entry.slug}]]${suffix}`
      : `[[${entry.slug}|${baseName}]]${suffix}`;

    result =
      result.slice(0, match.index) +
      wikilink +
      result.slice(match.index + matchedText.length);

    linkedSlugs.add(entry.slug);
    linksInserted++;
  }

  return { updatedBody: result, linksInserted };
}

interface SafeMatch {
  text: string;
  index: number;
}

/**
 * Find the first match of a pattern that is not inside:
 * - An existing wikilink `[[...]]`
 * - A heading line that starts with `#`
 * - A frontmatter block
 */
function findSafeMatch(text: string, pattern: RegExp): SafeMatch | null {
  // Reset the regex
  const re = new RegExp(pattern.source, pattern.flags);

  let match;
  while ((match = re.exec(text)) !== null) {
    const index = match.index;

    // Check if inside a wikilink: look for [[ before and ]] after without closing first
    if (isInsideWikilink(text, index)) continue;

    // Check if on a heading line (the page's own heading)
    if (isOnHeadingLine(text, index)) continue;

    return { text: match[0], index };
  }

  return null;
}

/** Check if a position is inside a `[[...]]` wikilink. */
function isInsideWikilink(text: string, pos: number): boolean {
  // Scan backwards from pos for `[[` or `]]`
  let i = pos - 1;
  while (i >= 1) {
    if (text[i] === '[' && text[i - 1] === '[') return true;
    if (text[i] === ']' && text[i - 1] === ']') return false;
    i--;
  }
  return false;
}

/** Check if a position is on a Markdown heading line (`# ...`). */
function isOnHeadingLine(text: string, pos: number): boolean {
  // Find the start of the line
  let lineStart = pos;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') {
    lineStart--;
  }
  const linePrefix = text.slice(lineStart, pos);
  return /^#{1,6}\s/.test(linePrefix);
}

/** Extract all wikilink target slugs from the body. */
function extractExistingWikilinkTargets(body: string): Set<string> {
  const targets = new Set<string>();
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    targets.add(slugify(match[1].trim()));
  }
  return targets;
}

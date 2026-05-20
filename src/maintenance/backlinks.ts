import type { VaultAdapter } from '../vault/adapter.js';
import type { NoteType } from '../vault/frontmatter.js';
import { parseNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, getProtectedRegion, hasProtectedRegion } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('backlinks');

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// --- Category mapping ---

type BacklinkCategory = 'Sources' | 'Sessions' | 'Wiki';

const TYPE_TO_CATEGORY: Record<NoteType, BacklinkCategory> = {
  source_summary: 'Sources',
  session_summary: 'Sessions',
  meeting_summary: 'Wiki',
  entity: 'Wiki',
  project: 'Wiki',
  project_spec: 'Wiki',
  concept: 'Wiki',
  topic: 'Wiki',
  tool: 'Wiki',
  organization: 'Wiki',
  decision: 'Wiki',
  contradiction: 'Wiki',
  index: 'Wiki',
};

const CATEGORY_ORDER: BacklinkCategory[] = ['Sources', 'Sessions', 'Wiki'];

// --- Backlink entry ---

interface BacklinkEntry {
  sourceName: string;
  context: string;
  sourceType: NoteType;
  date: string;
  category: BacklinkCategory;
}

// --- Extract outlinks ---

export function extractOutlinks(body: string): string[] {
  const links: string[] = [];
  let match;
  while ((match = WIKILINK_PATTERN.exec(body)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)];
}

// --- Context extraction ---

/**
 * Extract ~100 chars of surrounding context for a specific link mention.
 * Tries to align to sentence boundaries where possible.
 * Strips wikilink markup from the context text for readability.
 */
export function extractLinkContext(body: string, linkTarget: string): string {
  // Build a pattern that matches the wikilink with this target (with or without alias)
  const escapedTarget = linkTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkPattern = new RegExp(`\\[\\[${escapedTarget}(?:\\|[^\\]]+)?\\]\\]`, 'i');
  const match = linkPattern.exec(body);
  if (!match) return '';

  // Find the line containing the match
  const lineStart = body.lastIndexOf('\n', match.index) + 1;
  const lineEnd = body.indexOf('\n', match.index + match[0].length);
  const line = body.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

  // Skip heading lines — they are not useful context
  if (/^#{1,6}\s/.test(line)) {
    return '';
  }

  // Try to find the sentence containing the link
  const context = extractSentence(line, match.index - lineStart, match[0].length);

  // Strip wikilink syntax from the context: [[target|alias]] -> alias, [[target]] -> target
  const cleaned = context.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');

  return trimToLength(cleaned, 100);
}

/**
 * Extract the sentence surrounding a position in a line.
 * Falls back to a ~100 char window if no sentence boundaries are found.
 */
function extractSentence(line: string, matchStart: number, matchLength: number): string {
  // Sentence-ending punctuation followed by space or end-of-string
  const sentenceEnders = /[.!?](?:\s|$)/g;
  const matchEnd = matchStart + matchLength;

  // Find sentence start: look backward for a sentence ender before our match
  let sentStart = 0;
  let ender;
  while ((ender = sentenceEnders.exec(line)) !== null) {
    if (ender.index + ender[0].length <= matchStart) {
      sentStart = ender.index + ender[0].length;
    } else {
      break;
    }
  }

  // Find sentence end: look forward for a sentence ender after our match
  sentenceEnders.lastIndex = matchEnd;
  const nextEnder = sentenceEnders.exec(line);
  const sentEnd = nextEnder ? nextEnder.index + 1 : line.length;

  const sentence = line.slice(sentStart, sentEnd).trim();

  // If the extracted sentence is within reasonable bounds, use it
  if (sentence.length <= 150) {
    return sentence;
  }

  // Otherwise fall back to a window around the match
  const radius = 50;
  const windowStart = Math.max(0, matchStart - radius);
  const windowEnd = Math.min(line.length, matchEnd + radius);
  let window = line.slice(windowStart, windowEnd).trim();
  if (windowStart > 0) window = '...' + window;
  if (windowEnd < line.length) window = window + '...';
  return window;
}

/**
 * Trim a string to approximately `maxLen` characters, trying to end at a word boundary.
 * Adds ellipsis if truncated.
 */
function trimToLength(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  const cutPoint = lastSpace > maxLen * 0.6 ? lastSpace : maxLen;
  return truncated.slice(0, cutPoint).trimEnd() + '...';
}

// --- Slug resolution ---

function slugToPath(slug: string, allPaths: string[]): string | null {
  // Try exact match first
  const exact = allPaths.find((p) => p === slug || p === `${slug}.md`);
  if (exact) return exact;
  // Try matching by filename
  const byName = allPaths.find((p) => {
    const name = p.split('/').pop()?.replace(/\.md$/, '');
    return name === slug;
  });
  return byName ?? null;
}

function pathToSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function extractDateFromFrontmatter(data: Record<string, unknown>): string {
  const updatedAt = data.updated_at;
  if (typeof updatedAt === 'string') {
    // Return just the date portion (YYYY-MM-DD)
    return updatedAt.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

// --- Format a single backlink entry ---

function formatBacklinkEntry(entry: BacklinkEntry): string {
  if (entry.context) {
    return `- [[${entry.sourceName}]] — "${entry.context}" (${entry.sourceType}, ${entry.date})`;
  }
  return `- [[${entry.sourceName}]] (${entry.sourceType}, ${entry.date})`;
}

// --- Format grouped backlinks ---

function formatGroupedBacklinks(entries: BacklinkEntry[]): string {
  const groups = new Map<BacklinkCategory, BacklinkEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.category) ?? [];
    group.push(entry);
    groups.set(entry.category, group);
  }

  const sections: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const group = groups.get(category);
    if (!group || group.length === 0) continue;

    // Sort entries alphabetically by source name within each group
    group.sort((a, b) => a.sourceName.localeCompare(b.sourceName));

    sections.push(`### From ${category}`);
    for (const entry of group) {
      sections.push(formatBacklinkEntry(entry));
    }
  }

  return sections.join('\n');
}

// --- Public API ---

export async function updateBacklinksForFile(
  vault: VaultAdapter,
  targetPath: string,
  allPaths: string[],
): Promise<number> {
  const content = await vault.read(targetPath);
  const { body } = parseNote(content);
  const outlinks = extractOutlinks(body);
  let updated = 0;

  for (const link of outlinks) {
    const linkedPath = slugToPath(link, allPaths);
    if (!linkedPath || linkedPath === targetPath) continue;

    try {
      const linkedContent = await vault.read(linkedPath);
      const targetName = pathToSlug(targetPath);

      const currentBacklinks = extractBacklinksSection(linkedContent);
      if (currentBacklinks.includes(`[[${targetName}]]`)) continue;

      // Read source frontmatter for type and date
      const { data: sourceData } = parseNote(content);
      const sourceType = (typeof sourceData.type === 'string' ? sourceData.type : 'entity') as NoteType;
      const date = extractDateFromFrontmatter(sourceData);
      const category = TYPE_TO_CATEGORY[sourceType] ?? 'Wiki';

      // Extract context for this particular link
      const context = extractLinkContext(body, link);

      const entry: BacklinkEntry = {
        sourceName: targetName,
        context,
        sourceType,
        date,
        category,
      };

      // Parse existing entries and add the new one
      const existingEntries = parseBacklinkEntries(currentBacklinks);
      existingEntries.push(entry);

      const newBacklinks = formatGroupedBacklinks(existingEntries);

      const updatedContent = updateProtectedRegion(linkedContent, 'backlinks', newBacklinks);
      await vault.write(linkedPath, updatedContent);
      updated++;
    } catch (err) {
      log.warn('Failed to update backlinks', {
        target: linkedPath,
        error: (err as Error).message,
      });
    }
  }

  return updated;
}

/**
 * Parse existing backlink lines back into entries (best-effort for incremental updates).
 * Format: `- [[name]] — "context" (type, date)` or `- [[name]] (type, date)`
 */
function parseBacklinkEntries(section: string): BacklinkEntry[] {
  if (!section.trim()) return [];

  const entries: BacklinkEntry[] = [];
  const lines = section.split('\n');
  let currentCategory: BacklinkCategory = 'Wiki';

  for (const line of lines) {
    const headerMatch = line.match(/^### From (Sources|Sessions|Wiki)/);
    if (headerMatch) {
      currentCategory = headerMatch[1] as BacklinkCategory;
      continue;
    }

    // Match: - [[name]] — "context" (type, date)
    const contextMatch = line.match(/^- \[\[([^\]]+)\]\] — "(.+)" \((\S+), (\S+)\)$/);
    if (contextMatch) {
      entries.push({
        sourceName: contextMatch[1],
        context: contextMatch[2],
        sourceType: contextMatch[3] as NoteType,
        date: contextMatch[4],
        category: currentCategory,
      });
      continue;
    }

    // Match: - [[name]] (type, date)
    const simpleMatch = line.match(/^- \[\[([^\]]+)\]\] \((\S+), (\S+)\)$/);
    if (simpleMatch) {
      entries.push({
        sourceName: simpleMatch[1],
        context: '',
        sourceType: simpleMatch[2] as NoteType,
        date: simpleMatch[3],
        category: currentCategory,
      });
      continue;
    }

    // Legacy format: - [[name]]
    const legacyMatch = line.match(/^- \[\[([^\]]+)\]\]$/);
    if (legacyMatch) {
      entries.push({
        sourceName: legacyMatch[1],
        context: '',
        sourceType: 'entity' as NoteType,
        date: '',
        category: currentCategory,
      });
    }
  }

  return entries;
}

function extractBacklinksSection(content: string): string {
  return getProtectedRegion(content, 'backlinks') ?? '';
}

export async function rebuildAllBacklinks(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<{ scanned: number; updated: number }> {
  const allPaths = await vault.listMarkdownFiles(layout.wiki);
  let totalUpdated = 0;

  // First, clear all backlink sections
  for (const path of allPaths) {
    const content = await vault.read(path);
    if (hasProtectedRegion(content, 'backlinks')) {
      const cleared = updateProtectedRegion(content, 'backlinks', '');
      if (cleared !== content) {
        await vault.write(path, cleared);
      }
    }
  }

  // Collect all backlinks for each target in one pass
  // Build a map: targetPath -> BacklinkEntry[]
  const backlinkMap = new Map<string, BacklinkEntry[]>();

  for (const sourcePath of allPaths) {
    try {
      const sourceContent = await vault.read(sourcePath);
      const { data, body } = parseNote(sourceContent);
      const outlinks = extractOutlinks(body);
      if (outlinks.length === 0) continue;

      const sourceName = pathToSlug(sourcePath);
      const sourceType = (typeof data.type === 'string' ? data.type : 'entity') as NoteType;
      const date = extractDateFromFrontmatter(data);
      const category = TYPE_TO_CATEGORY[sourceType] ?? 'Wiki';

      for (const link of outlinks) {
        const linkedPath = slugToPath(link, allPaths);
        if (!linkedPath || linkedPath === sourcePath) continue;

        const context = extractLinkContext(body, link);

        const entry: BacklinkEntry = {
          sourceName,
          context,
          sourceType,
          date,
          category,
        };

        const existing = backlinkMap.get(linkedPath) ?? [];
        existing.push(entry);
        backlinkMap.set(linkedPath, existing);
      }
    } catch (err) {
      log.warn('Failed to process source for backlinks', {
        source: sourcePath,
        error: (err as Error).message,
      });
    }
  }

  // Write backlinks for each target
  for (const [targetPath, entries] of backlinkMap) {
    try {
      const targetContent = await vault.read(targetPath);
      const formatted = formatGroupedBacklinks(entries);
      const updatedContent = updateProtectedRegion(targetContent, 'backlinks', formatted);
      if (updatedContent !== targetContent) {
        await vault.write(targetPath, updatedContent);
        totalUpdated++;
      }
    } catch (err) {
      log.warn('Failed to write backlinks', {
        target: targetPath,
        error: (err as Error).message,
      });
    }
  }

  log.info('Backlinks rebuilt', { scanned: allPaths.length, updated: totalUpdated });
  return { scanned: allPaths.length, updated: totalUpdated };
}

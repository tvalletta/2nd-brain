import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
import {
  slugify,
  kindToFolder,
  DEFAULT_LAYOUT,
  type EntityKind,
  type VaultLayout,
} from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('entity-resolver');

export type { EntityKind } from '../vault/paths.js';
export { KIND_TO_FOLDER } from '../vault/paths.js';

export interface EntityResolution {
  entityName: string;
  entityKind: EntityKind;
  status: 'matched' | 'new' | 'ambiguous';
  matchedPath?: string;
  suggestedPath?: string;
  candidates?: Array<{ path: string; confidence: number }>;
  confidence: number;
}

export interface EntityIndexEntry {
  name: string;
  path: string;
  aliases: string[];
  slug: string;
}

export interface EntityIndex {
  bySlug: Map<string, string>;
  byCanonicalName: Map<string, string>;
  byAlias: Map<string, string>;
  allEntries: EntityIndexEntry[];
}


export async function buildEntityIndex(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<EntityIndex> {
  const bySlug = new Map<string, string>();
  const byCanonicalName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const allEntries: EntityIndexEntry[] = [];

  const kinds: EntityKind[] = ['person', 'project', 'concept', 'decision', 'tool', 'topic', 'organization'];
  const folders = kinds.map((k) => kindToFolder(layout, k));

  for (const folder of folders) {
    let files: string[];
    try {
      files = await vault.listMarkdownFiles(folder);
    } catch {
      continue; // folder may not exist yet
    }

    for (const filePath of files) {
      try {
        const content = await vault.read(filePath);
        const { data } = parseNote(content);

        const canonicalName = (data.canonical_name as string) ?? (data.title as string) ?? '';
        const aliases = (data.aliases as string[]) ?? [];
        const fileName = filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
        const slug = slugify(canonicalName || fileName);

        bySlug.set(slug, filePath);
        if (canonicalName) {
          byCanonicalName.set(normalizeName(canonicalName), filePath);
        }
        for (const alias of aliases) {
          byAlias.set(normalizeName(alias), filePath);
        }
        allEntries.push({ name: canonicalName || fileName, path: filePath, aliases, slug });
      } catch (err) {
        log.warn('Failed to index entity file', { path: filePath, error: (err as Error).message });
      }
    }
  }

  return { bySlug, byCanonicalName, byAlias, allEntries };
}

export function resolveEntity(
  entity: { name: string; kind: EntityKind },
  index: EntityIndex,
  layout: VaultLayout = DEFAULT_LAYOUT,
): EntityResolution {
  const { name, kind } = entity;
  const normalized = normalizeName(name);
  const slug = slugify(name);
  const folder = kindToFolder(layout, kind);

  // 1. Exact slug match
  const slugMatch = index.bySlug.get(slug);
  if (slugMatch && slugMatch.startsWith(folder)) {
    return { entityName: name, entityKind: kind, status: 'matched', matchedPath: slugMatch, confidence: 1.0 };
  }

  // 2. Canonical name match
  const nameMatch = index.byCanonicalName.get(normalized);
  if (nameMatch && nameMatch.startsWith(folder)) {
    return { entityName: name, entityKind: kind, status: 'matched', matchedPath: nameMatch, confidence: 0.95 };
  }

  // 3. Alias match
  const aliasMatch = index.byAlias.get(normalized);
  if (aliasMatch && aliasMatch.startsWith(folder)) {
    return { entityName: name, entityKind: kind, status: 'matched', matchedPath: aliasMatch, confidence: 0.9 };
  }

  // 4. Cross-folder matches (slug, name, alias match but in a different folder)
  const crossSlug = slugMatch ?? index.byCanonicalName.get(normalized) ?? index.byAlias.get(normalized);
  if (crossSlug) {
    return { entityName: name, entityKind: kind, status: 'matched', matchedPath: crossSlug, confidence: 0.85 };
  }

  // 5. Fuzzy matching
  const fuzzyMatches = findFuzzyMatches(name, index.allEntries, folder);
  if (fuzzyMatches.length === 1) {
    return {
      entityName: name,
      entityKind: kind,
      status: 'matched',
      matchedPath: fuzzyMatches[0].path,
      confidence: fuzzyMatches[0].confidence,
    };
  }
  if (fuzzyMatches.length > 1) {
    return {
      entityName: name,
      entityKind: kind,
      status: 'ambiguous',
      candidates: fuzzyMatches,
      confidence: fuzzyMatches[0].confidence,
    };
  }

  // 6. No match — suggest creating a new page
  const suggestedPath = `${folder}/${slug}.md`;
  return { entityName: name, entityKind: kind, status: 'new', suggestedPath, confidence: 0 };
}

export function resolveEntities(
  entities: Array<{ name: string; kind: EntityKind }>,
  index: EntityIndex,
  layout: VaultLayout = DEFAULT_LAYOUT,
): EntityResolution[] {
  return entities.map((e) => resolveEntity(e, index, layout));
}

// --- Name normalization ---

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Fuzzy matching ---

function findFuzzyMatches(
  name: string,
  entries: EntityIndexEntry[],
  preferredFolder: string,
): Array<{ path: string; confidence: number }> {
  const normalized = normalizeName(name);
  const nameWords = new Set(normalized.split(/\s+/));
  const results: Array<{ path: string; confidence: number }> = [];

  for (const entry of entries) {
    // Only match against entries in the preferred folder
    if (!entry.path.startsWith(preferredFolder)) continue;

    const entryNormalized = normalizeName(entry.name);

    // Word-order-independent matching: "John Smith" matches "Smith, John"
    const entryWords = new Set(entryNormalized.replace(/,/g, '').split(/\s+/));
    if (nameWords.size >= 2 && entryWords.size >= 2 && setsEqual(nameWords, entryWords)) {
      results.push({ path: entry.path, confidence: 0.9 });
      continue;
    }

    // Levenshtein distance
    const maxDist = normalized.length <= 10 ? 2 : 3;
    const dist = levenshtein(normalized, entryNormalized);
    if (dist > 0 && dist <= maxDist) {
      const confidence = Math.max(0.5, 0.85 - dist * 0.1);
      results.push({ path: entry.path, confidence });
      continue;
    }

    // Also check aliases
    for (const alias of entry.aliases) {
      const aliasNorm = normalizeName(alias);
      const aliasDist = levenshtein(normalized, aliasNorm);
      if (aliasDist > 0 && aliasDist <= maxDist) {
        const confidence = Math.max(0.5, 0.8 - aliasDist * 0.1);
        results.push({ path: entry.path, confidence });
        break;
      }
    }
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

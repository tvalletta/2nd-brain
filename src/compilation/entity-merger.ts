import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { extractProtectedRegions, updateProtectedRegion, getProtectedRegion } from '../vault/protected-regions.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';
import { normalizeName, levenshtein, buildEntityIndex } from '../ingest/entity-resolver.js';
import { WIKI_CONTENT_FOLDERS } from '../vault/paths.js';

const log = createLogger('entity-merger');

export interface MergeResult {
  targetPath: string;
  deletedPath: string;
  aliasesAdded: string[];
  sourceRefsAdded: string[];
  regionsUpdated: string[];
  wikilinksRewritten: number;
}

/**
 * Merge one entity page into another.
 *
 * - Combines source_refs, aliases, links (deduplicated)
 * - Adds source's canonical_name as alias on target
 * - Merges all protected region content (appends source's into target's)
 * - Rewrites wikilinks across entire vault from source slug to target slug
 * - Deletes source page
 */
export async function mergeEntities(
  sourcePath: string,
  targetPath: string,
  vault: VaultAdapter,
): Promise<MergeResult> {
  log.info('Merging entities', { from: sourcePath, into: targetPath });

  const sourceContent = await vault.read(sourcePath);
  const targetContent = await vault.read(targetPath);

  const source = parseNote(sourceContent);
  const target = parseNote(targetContent);

  const aliasesAdded: string[] = [];
  const sourceRefsAdded: string[] = [];
  const regionsUpdated: string[] = [];

  // --- Merge frontmatter arrays ---

  // source_refs
  const targetSourceRefs = new Set((target.data.source_refs as string[]) ?? []);
  const sourceSourceRefs = (source.data.source_refs as string[]) ?? [];
  for (const ref of sourceSourceRefs) {
    if (!targetSourceRefs.has(ref)) {
      targetSourceRefs.add(ref);
      sourceRefsAdded.push(ref);
    }
  }
  target.data.source_refs = [...targetSourceRefs];

  // aliases — add source's canonical_name and its aliases
  const targetAliases = new Set(
    ((target.data.aliases as string[]) ?? []).map((a) => a.toLowerCase()),
  );
  const targetCanonical = (target.data.canonical_name as string) ?? (target.data.title as string) ?? '';
  const sourceCanonical = (source.data.canonical_name as string) ?? (source.data.title as string) ?? '';

  // Add source canonical name as alias (if it differs from target's)
  if (
    sourceCanonical &&
    sourceCanonical.toLowerCase() !== targetCanonical.toLowerCase() &&
    !targetAliases.has(sourceCanonical.toLowerCase())
  ) {
    aliasesAdded.push(sourceCanonical);
  }

  // Add source's aliases
  const sourceAliases = (source.data.aliases as string[]) ?? [];
  for (const alias of sourceAliases) {
    if (
      alias.toLowerCase() !== targetCanonical.toLowerCase() &&
      !targetAliases.has(alias.toLowerCase())
    ) {
      aliasesAdded.push(alias);
    }
  }

  target.data.aliases = [
    ...((target.data.aliases as string[]) ?? []),
    ...aliasesAdded,
  ];

  // links
  const targetLinks = new Set((target.data.links as string[]) ?? []);
  const sourceLinks = (source.data.links as string[]) ?? [];
  for (const link of sourceLinks) {
    if (link !== targetPath && link !== sourcePath) {
      targetLinks.add(link);
    }
  }
  target.data.links = [...targetLinks];

  // Update timestamp
  target.data.updated_at = nowISO();

  // --- Merge protected regions ---

  const sourceRegions = extractProtectedRegions(source.body);
  let updatedBody = target.body;

  for (const region of sourceRegions) {
    const regionContent = region.content.trim();
    if (!regionContent) continue;

    const existingContent = getProtectedRegion(updatedBody, region.id);
    if (existingContent === null) {
      // Target doesn't have this region — skip (different template structure)
      continue;
    }

    const existingTrimmed = existingContent.trim();
    if (!existingTrimmed || existingTrimmed === 'Pending enrichment.') {
      // Replace empty/placeholder content
      updatedBody = updateProtectedRegion(updatedBody, region.id, regionContent);
      regionsUpdated.push(region.id);
    } else if (!existingTrimmed.includes(regionContent)) {
      // Append non-duplicate content
      updatedBody = updateProtectedRegion(
        updatedBody,
        region.id,
        `${existingTrimmed}\n${regionContent}`,
      );
      regionsUpdated.push(region.id);
    }
  }

  // Write updated target
  const updatedTarget = serializeNote(target.data, updatedBody);
  await vault.atomicWrite(targetPath, updatedTarget);

  // --- Rewrite wikilinks across the vault ---

  const sourceSlug = extractSlug(sourcePath);
  const targetSlug = extractSlug(targetPath);
  const wikilinksRewritten = await rewriteWikilinks(vault, sourceSlug, targetSlug);

  // --- Delete source page ---

  await vault.delete(sourcePath);
  log.info('Merge complete', {
    from: sourcePath,
    into: targetPath,
    aliasesAdded: aliasesAdded.length,
    sourceRefsAdded: sourceRefsAdded.length,
    regionsUpdated: regionsUpdated.length,
    wikilinksRewritten,
  });

  return {
    targetPath,
    deletedPath: sourcePath,
    aliasesAdded,
    sourceRefsAdded,
    regionsUpdated,
    wikilinksRewritten,
  };
}

/**
 * Rewrite all `[[sourceSlug]]` and `[[sourceSlug|...]]` wikilinks across
 * the entire wiki to point to `targetSlug` instead.
 */
async function rewriteWikilinks(
  vault: VaultAdapter,
  sourceSlug: string,
  targetSlug: string,
): Promise<number> {
  let total = 0;

  const folders = WIKI_CONTENT_FOLDERS;

  for (const folder of folders) {
    let files: string[];
    try {
      files = await vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const filePath of files) {
      try {
        const content = await vault.read(filePath);

        // Replace [[sourceSlug]] with [[targetSlug]]
        // Replace [[sourceSlug|Display]] with [[targetSlug|Display]]
        const pattern = new RegExp(
          `\\[\\[${escapeRegex(sourceSlug)}(\\|[^\\]]+)?\\]\\]`,
          'g',
        );

        if (!pattern.test(content)) continue;

        const updated = content.replace(
          new RegExp(`\\[\\[${escapeRegex(sourceSlug)}(\\|[^\\]]+)?\\]\\]`, 'g'),
          (_, alias) => `[[${targetSlug}${alias ?? ''}]]`,
        );

        if (updated !== content) {
          await vault.atomicWrite(filePath, updated);
          total++;
        }
      } catch (err) {
        log.warn('Failed to rewrite wikilinks in file', {
          path: filePath,
          error: (err as Error).message,
        });
      }
    }
  }

  return total;
}

// --- Auto-merge detection ---

export interface MergeCandidate {
  sourcePath: string;
  targetPath: string;
  sourceName: string;
  targetName: string;
  reason: string;
  confidence: number;
}

/**
 * Scan the entity index for potential duplicates that should be merged.
 *
 * Criteria:
 * - Very similar names (Levenshtein ≤ 2) AND overlapping source_refs
 * - Identical names but in different kind folders
 * - One name is a substring of the other AND they share sources
 */
export async function detectMergeCandidates(
  vault: VaultAdapter,
): Promise<MergeCandidate[]> {
  const index = await buildEntityIndex(vault);
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < index.allEntries.length; i++) {
    for (let j = i + 1; j < index.allEntries.length; j++) {
      const a = index.allEntries[i];
      const b = index.allEntries[j];

      const pairKey = [a.path, b.path].sort().join('|');
      if (seen.has(pairKey)) continue;

      const normA = normalizeName(a.name);
      const normB = normalizeName(b.name);

      // Skip exact same path
      if (a.path === b.path) continue;

      // Check Levenshtein distance
      const dist = levenshtein(normA, normB);
      if (dist <= 2 && dist > 0) {
        // Check overlapping source_refs
        const overlap = await checkSourceOverlap(vault, a.path, b.path);
        if (overlap > 0) {
          seen.add(pairKey);
          // Prefer the longer/more specific name as target
          const [source, target] = a.name.length >= b.name.length
            ? [b, a]
            : [a, b];
          candidates.push({
            sourcePath: source.path,
            targetPath: target.path,
            sourceName: source.name,
            targetName: target.name,
            reason: `Similar names (distance=${dist}) with ${overlap} shared sources`,
            confidence: Math.min(0.9, 0.7 + overlap * 0.1),
          });
          continue;
        }
      }

      // Check if one is a substring of the other (e.g., "John" vs "John Hancock")
      if (normA.length >= 3 && normB.length >= 3) {
        const isSubstring = normA.includes(normB) || normB.includes(normA);
        if (isSubstring) {
          const overlap = await checkSourceOverlap(vault, a.path, b.path);
          if (overlap > 0) {
            seen.add(pairKey);
            // The longer name is more specific → that's the target
            const [source, target] = a.name.length >= b.name.length
              ? [b, a]
              : [a, b];
            candidates.push({
              sourcePath: source.path,
              targetPath: target.path,
              sourceName: source.name,
              targetName: target.name,
              reason: `"${source.name}" is substring of "${target.name}" with ${overlap} shared sources`,
              confidence: Math.min(0.95, 0.8 + overlap * 0.1),
            });
          }
        }
      }

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
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

/**
 * Auto-merge high-confidence duplicates.
 * Only merges candidates with confidence >= threshold.
 */
export async function autoMerge(
  vault: VaultAdapter,
  threshold = 0.85,
): Promise<MergeResult[]> {
  const candidates = await detectMergeCandidates(vault);
  const results: MergeResult[] = [];

  // Track already-merged paths to avoid double-merging
  const mergedPaths = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.confidence < threshold) continue;
    if (mergedPaths.has(candidate.sourcePath) || mergedPaths.has(candidate.targetPath)) continue;

    try {
      log.info('Auto-merging', {
        from: candidate.sourceName,
        into: candidate.targetName,
        reason: candidate.reason,
        confidence: candidate.confidence,
      });

      const result = await mergeEntities(candidate.sourcePath, candidate.targetPath, vault);
      results.push(result);
      mergedPaths.add(candidate.sourcePath);
    } catch (err) {
      log.warn('Auto-merge failed', {
        from: candidate.sourcePath,
        into: candidate.targetPath,
        error: (err as Error).message,
      });
    }
  }

  return results;
}

// --- Helpers ---

async function checkSourceOverlap(
  vault: VaultAdapter,
  pathA: string,
  pathB: string,
): Promise<number> {
  try {
    const contentA = await vault.read(pathA);
    const contentB = await vault.read(pathB);
    const { data: dataA } = parseNote(contentA);
    const { data: dataB } = parseNote(contentB);

    const refsA = new Set((dataA.source_refs as string[]) ?? []);
    const refsB = (dataB.source_refs as string[]) ?? [];

    let overlap = 0;
    for (const ref of refsB) {
      if (refsA.has(ref)) overlap++;
    }
    return overlap;
  } catch {
    return 0;
  }
}

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

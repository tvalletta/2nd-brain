import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { serializeNote } from '../vault/frontmatter.js';
import { slugify } from '../vault/paths.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('migration');

export interface MigrationResult {
  sourceSummariesDeleted: number;
  entitiesBackfilled: number;
  projectsBackfilled: number;
  conceptsBackfilled: number;
  skipped: string[];
  errors: string[];
}

/**
 * Infer canonical_name from a wiki page filename.
 *
 * Strips suffixes like " - About", " - Notes" and handles
 * "Last, First ..." patterns (e.g., "Kubicki, Irek 2025 Q3 Check-in").
 */
export function inferCanonicalName(filename: string): string {
  // Remove .md extension
  let name = filename.replace(/\.md$/, '');

  // Strip common suffixes: " - About", " - Notes", etc.
  name = name.replace(/\s+-\s+(About|Notes|Overview|Summary)$/i, '');

  // Handle "Last, First ..." — extract just the name portion
  // Only matches single-word last names to avoid false positives
  // e.g., "Kubicki, Irek 2025 Q3 Check-in" -> "Irek Kubicki"
  // Does NOT match "Jan 8, 2026" or "Working Session - Jan 8, 2026"
  const commaMatch = name.match(/^([A-Z][a-z]+),\s+([A-Z][a-z]+)/);
  if (commaMatch) {
    name = `${commaMatch[2]} ${commaMatch[1]}`;
  }

  return name.trim();
}

/**
 * Determine if a wiki file is likely a non-entity page that shouldn't
 * get entity frontmatter (e.g., "My Team.md" is a list, not a person).
 */
function isNonEntityPage(filename: string, content: string): boolean {
  const name = filename.replace(/\.md$/, '');
  const nonEntityNames = ['My Team', '_index'];
  if (nonEntityNames.includes(name)) return true;

  // If the entire content is just a list of links, it's an index page
  const lines = content.trim().split('\n').filter((l) => l.trim().length > 0);
  const linkLines = lines.filter((l) => /^-\s*\[\[/.test(l.trim()));
  if (lines.length > 0 && linkLines.length === lines.length) return true;

  return false;
}

/**
 * Check if a file already has YAML frontmatter (starts with ---).
 */
function hasFrontmatter(content: string): boolean {
  return content.trimStart().startsWith('---');
}

/**
 * Build frontmatter for an entity (person) page.
 */
function buildEntityFrontmatter(canonicalName: string, now: string): Record<string, unknown> {
  return {
    id: nanoid(),
    type: 'entity',
    entity_kind: 'person',
    title: canonicalName,
    canonical_name: canonicalName,
    status: 'active',
    confidence: 'high',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    source_refs: [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'human',
    curation_policy: 'curated',
    protected_regions: ['summary', 'mentions', 'backlinks'],
  };
}

/**
 * Build frontmatter for a project page.
 */
function buildProjectFrontmatter(title: string, now: string): Record<string, unknown> {
  return {
    id: nanoid(),
    type: 'project',
    title,
    project_key: slugify(title),
    project_status: 'active',
    status: 'active',
    confidence: 'high',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    source_refs: [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'human',
    curation_policy: 'curated',
    protected_regions: ['overview', 'decisions', 'sessions', 'backlinks'],
  };
}

/**
 * Build frontmatter for a concept page.
 */
function buildConceptFrontmatter(title: string, now: string): Record<string, unknown> {
  return {
    id: nanoid(),
    type: 'concept',
    title,
    status: 'active',
    confidence: 'high',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    source_refs: [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'human',
    curation_policy: 'curated',
    protected_regions: ['definition', 'related', 'backlinks'],
  };
}

/**
 * Delete all source-summary files. These are old stubs with no enrichment.
 */
async function deleteSourceSummaries(vault: VaultAdapter): Promise<number> {
  const files = await vault.listMarkdownFiles('outputs/source-summaries');
  let deleted = 0;

  for (const path of files) {
    try {
      await vault.delete(path);
      deleted++;
    } catch (err) {
      log.warn('Failed to delete source summary', { path, error: (err as Error).message });
    }
  }

  return deleted;
}

/**
 * Backfill frontmatter onto wiki pages in a given folder.
 */
async function backfillFolder(
  vault: VaultAdapter,
  folder: string,
  kind: 'entity' | 'project' | 'concept',
  result: MigrationResult,
): Promise<void> {
  const files = await vault.listMarkdownFiles(folder);
  const now = nowISO();

  for (const path of files) {
    const filename = path.split('/').pop() ?? '';

    try {
      const content = await vault.read(path);

      // Skip if already has frontmatter
      if (hasFrontmatter(content)) {
        result.skipped.push(`${path} (already has frontmatter)`);
        continue;
      }

      // Skip non-entity pages like "My Team.md"
      if (kind === 'entity' && isNonEntityPage(filename, content)) {
        result.skipped.push(`${path} (non-entity page)`);
        continue;
      }

      const canonicalName = inferCanonicalName(filename);
      let frontmatter: Record<string, unknown>;

      switch (kind) {
        case 'entity':
          frontmatter = buildEntityFrontmatter(canonicalName, now);
          break;
        case 'project':
          frontmatter = buildProjectFrontmatter(canonicalName, now);
          break;
        case 'concept':
          frontmatter = buildConceptFrontmatter(canonicalName, now);
          break;
      }

      // For entity pages with " - About" or " - Notes" suffixes,
      // add the full filename (minus .md) as an alias
      const rawTitle = filename.replace(/\.md$/, '');
      if (rawTitle !== canonicalName && !rawTitle.includes(',')) {
        (frontmatter.aliases as string[]).push(rawTitle);
      }

      const migrated = serializeNote(frontmatter, '\n' + content);
      await vault.atomicWrite(path, migrated);

      switch (kind) {
        case 'entity':
          result.entitiesBackfilled++;
          break;
        case 'project':
          result.projectsBackfilled++;
          break;
        case 'concept':
          result.conceptsBackfilled++;
          break;
      }

      log.info('Backfilled frontmatter', { path, kind, canonicalName });
    } catch (err) {
      const msg = `${path}: ${(err as Error).message}`;
      result.errors.push(msg);
      log.error('Migration error', { path, error: (err as Error).message });
    }
  }
}

/**
 * Run the full vault migration:
 * 1. Delete all source-summaries (old stubs)
 * 2. Backfill frontmatter onto existing wiki pages
 */
export async function migrateVault(vault: VaultAdapter): Promise<MigrationResult> {
  const result: MigrationResult = {
    sourceSummariesDeleted: 0,
    entitiesBackfilled: 0,
    projectsBackfilled: 0,
    conceptsBackfilled: 0,
    skipped: [],
    errors: [],
  };

  // Step 1: Delete old source-summaries
  log.info('Deleting old source-summaries...');
  result.sourceSummariesDeleted = await deleteSourceSummaries(vault);
  log.info('Source summaries deleted', { count: result.sourceSummariesDeleted });

  // Step 2: Backfill frontmatter on wiki pages
  log.info('Backfilling frontmatter on wiki pages...');
  await backfillFolder(vault, 'wiki/entities', 'entity', result);
  await backfillFolder(vault, 'wiki/projects', 'project', result);
  await backfillFolder(vault, 'wiki/concepts', 'concept', result);

  log.info('Migration complete', {
    deleted: result.sourceSummariesDeleted,
    entities: result.entitiesBackfilled,
    projects: result.projectsBackfilled,
    concepts: result.conceptsBackfilled,
    skipped: result.skipped.length,
    errors: result.errors.length,
  });

  return result;
}

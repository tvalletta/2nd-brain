import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG, hasProtectedRegion } from '../vault/protected-regions.js';
import { createLogger } from '../shared/logger.js';
import { nowISO } from '../shared/date-utils.js';

const log = createLogger('migrate-project-hubs');

export interface MigrateHubsResult {
  migrated: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Migrate legacy single-page projects (wiki/projects/{slug}.md) to the hub model
 * (wiki/projects/{slug}/_index.md).
 *
 * For each legacy project page:
 * 1. Create the hub directory wiki/projects/{slug}/
 * 2. Move the content into wiki/projects/{slug}/_index.md with updated frontmatter
 * 3. Delete the old single-page file
 *
 * This does NOT update wikilinks across the vault — Obsidian resolves by filename,
 * and [[slug]] will still find _index.md inside the slug directory.
 */
export async function migrateProjectsToHubs(vault: VaultAdapter): Promise<MigrateHubsResult> {
  const result: MigrateHubsResult = {
    migrated: [],
    skipped: [],
    errors: [],
  };

  // List all markdown files directly in wiki/projects/
  let allFiles: string[];
  try {
    allFiles = await vault.listMarkdownFiles('wiki/projects');
  } catch {
    log.info('No wiki/projects directory found, nothing to migrate');
    return result;
  }

  // Filter to only top-level .md files (not _index.md, not files inside subdirectories)
  const legacyFiles = allFiles.filter((f) => {
    // Must be directly in wiki/projects/, not in a subdirectory
    const parts = f.replace('wiki/projects/', '').split('/');
    if (parts.length !== 1) return false;
    // Must not be _index.md
    if (f.endsWith('_index.md')) return false;
    return f.endsWith('.md');
  });

  if (legacyFiles.length === 0) {
    log.info('No legacy project pages found to migrate');
    return result;
  }

  log.info('Found legacy project pages to migrate', { count: legacyFiles.length });

  for (const legacyPath of legacyFiles) {
    const slug = legacyPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
    if (!slug) {
      result.skipped.push(legacyPath);
      continue;
    }

    const hubDir = `wiki/projects/${slug}`;
    const indexPath = `${hubDir}/_index.md`;

    // Skip if hub already exists (shouldn't happen, but safety check)
    if (await vault.exists(indexPath)) {
      result.skipped.push(`${legacyPath} (hub already exists)`);
      continue;
    }

    try {
      // Read the legacy page
      const content = await vault.read(legacyPath);
      const { data, body } = parseNote(content);

      // Update frontmatter for hub model
      data.updated_at = nowISO();

      // Ensure protected_regions includes the hub regions
      const hubRegions = ['overview', 'specs', 'people', 'sessions', 'sources', 'backlinks'];
      const existingRegions = (data.protected_regions as string[]) ?? [];
      const mergedRegions = [...new Set([...hubRegions, ...existingRegions])];
      data.protected_regions = mergedRegions;

      // Add specs region to body if it doesn't exist
      let updatedBody = body;
      if (!hasProtectedRegion(updatedBody, 'specs')) {
        // Insert specs section after overview section — check both new and legacy close tags
        let overviewEnd = updatedBody.indexOf(CLOSE_TAG('overview'));
        let closeLen = CLOSE_TAG('overview').length;
        if (overviewEnd === -1) {
          overviewEnd = updatedBody.indexOf('<!-- /PROTECTED:overview -->');
          closeLen = '<!-- /PROTECTED:overview -->'.length;
        }
        if (overviewEnd !== -1) {
          const insertPos = overviewEnd + closeLen;
          const specsSection = `\n\n## Specifications\n${OPEN_TAG('specs')}\n${CLOSE_TAG('specs')}`;
          updatedBody = updatedBody.slice(0, insertPos) + specsSection + updatedBody.slice(insertPos);
        }
      }

      // Create the hub directory and write _index.md
      await vault.ensureFolder(hubDir);
      const newContent = serializeNote(data, updatedBody);
      await vault.atomicWrite(indexPath, newContent);

      // Delete the legacy page
      await vault.delete(legacyPath);

      result.migrated.push(`${legacyPath} → ${indexPath}`);
      log.info('Migrated project to hub', { slug, from: legacyPath, to: indexPath });
    } catch (err) {
      const msg = `${legacyPath}: ${(err as Error).message}`;
      result.errors.push(msg);
      log.error('Failed to migrate project', { slug, error: (err as Error).message });
    }
  }

  return result;
}

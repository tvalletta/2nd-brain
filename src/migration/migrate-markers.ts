import type { VaultAdapter } from '../vault/adapter.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('migrate-markers');

export interface MigrateMarkersResult {
  filesScanned: number;
  filesModified: number;
  markersReplaced: number;
}

const OPEN_PATTERN = /<!-- PROTECTED:(\S+) -->/g;
const CLOSE_PATTERN = /<!-- \/PROTECTED:(\S+) -->/g;
const PINNED_PATTERN = /<!-- PINNED: true -->/g;

/**
 * Migrate all HTML comment protected region markers to Obsidian %% syntax.
 *
 * Replaces:
 *   <!-- PROTECTED:id --> → %% begin:id %%
 *   <!-- /PROTECTED:id --> → %% end:id %%
 *   <!-- PINNED: true --> → %% pinned %%
 *
 * Idempotent — running twice produces no additional changes.
 */
export async function migrateMarkers(vault: VaultAdapter): Promise<MigrateMarkersResult> {
  const result: MigrateMarkersResult = { filesScanned: 0, filesModified: 0, markersReplaced: 0 };

  // Collect all markdown files across the entire vault
  const dirs = ['wiki', 'outputs', 'review', 'indexes'];
  const allFiles: string[] = [];

  for (const dir of dirs) {
    try {
      const files = await vault.listMarkdownFiles(dir);
      allFiles.push(...files);
    } catch {
      // Directory may not exist
    }
  }

  // Also check CLAUDE.md at vault root
  if (await vault.exists('CLAUDE.md')) {
    allFiles.push('CLAUDE.md');
  }

  for (const filePath of allFiles) {
    result.filesScanned++;
    try {
      const content = await vault.read(filePath);
      let updated = content;
      let count = 0;

      updated = updated.replace(OPEN_PATTERN, (_match, id) => {
        count++;
        return `%% begin:${id} %%`;
      });

      updated = updated.replace(CLOSE_PATTERN, (_match, id) => {
        count++;
        return `%% end:${id} %%`;
      });

      updated = updated.replace(PINNED_PATTERN, () => {
        count++;
        return '%% pinned %%';
      });

      if (count > 0) {
        await vault.write(filePath, updated);
        result.filesModified++;
        result.markersReplaced += count;
        log.debug('Migrated markers', { path: filePath, count });
      }
    } catch (err) {
      log.warn('Failed to migrate markers in file', {
        path: filePath,
        error: (err as Error).message,
      });
    }
  }

  log.info('Marker migration complete', { ...result });
  return result;
}

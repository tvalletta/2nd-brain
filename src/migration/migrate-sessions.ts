import type { VaultAdapter } from '../vault/adapter.js';
import { routeContent, isAIConversation, getAISource } from '../ingest/content-router.js';
import { classifyCwd } from '../ingest/cwd-classifier.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('migrate-sessions');

const CWD_PATTERN = /\*\*Working directory:\*\*\s*`([^`]+)`/;

export interface MigrateSessionsResult {
  moved: number;
  skipped: number;
  errors: string[];
}

/**
 * Migrate existing AI conversation files from flat raw/ directories
 * to the structured raw/ai-conversations/{source}/{slug}/ layout.
 *
 * Also updates any source summaries that reference the old paths.
 */
export async function migrateSessions(vault: VaultAdapter): Promise<MigrateSessionsResult> {
  const result: MigrateSessionsResult = { moved: 0, skipped: 0, errors: [] };

  // Scan all raw/ files (excluding raw/ai-conversations/ which is already migrated)
  const allRawFiles = await vault.listMarkdownFiles('raw');
  const candidateFiles = allRawFiles.filter(
    (f) => !f.startsWith('raw/ai-conversations/'),
  );

  // Also check exports/ directory
  let exportFiles: string[] = [];
  try {
    exportFiles = await vault.listMarkdownFiles('exports');
  } catch { /* exports dir may not exist */ }

  const filesToCheck = [...candidateFiles, ...exportFiles];

  for (const filePath of filesToCheck) {
    try {
      const content = await vault.read(filePath);
      const routing = routeContent(filePath, content);

      if (!isAIConversation(routing.category)) {
        continue; // Not an AI conversation, skip
      }

      const source = getAISource(routing.category);
      if (!source) continue;

      // Extract cwd to determine project slug
      const cwdMatch = CWD_PATTERN.exec(content);
      const cwd = cwdMatch ? cwdMatch[1] : '';
      const cwdClass = classifyCwd(cwd);

      // Compute new path
      const fileName = filePath.split('/').pop()!;
      const newDir = `raw/ai-conversations/${source}/${cwdClass.slug}`;
      const newPath = `${newDir}/${fileName}`;

      // Skip if already at the right location
      if (filePath === newPath) {
        result.skipped++;
        continue;
      }

      // Skip if destination already exists
      if (await vault.exists(newPath)) {
        result.skipped++;
        continue;
      }

      // Move: create at new location, source summaries will be updated below
      await vault.ensureFolder(newDir);
      await vault.create(newPath, content);

      // Update any source summaries that reference the old path
      await updateSourceSummaryPaths(vault, filePath, newPath);

      log.info('Migrated session', { from: filePath, to: newPath });
      result.moved++;
    } catch (err) {
      const msg = `Failed to migrate ${filePath}: ${(err as Error).message}`;
      log.warn(msg);
      result.errors.push(msg);
    }
  }

  return result;
}

/**
 * Update source summaries that reference the old path to point to the new path.
 */
async function updateSourceSummaryPaths(
  vault: VaultAdapter,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const summaries = await vault.listMarkdownFiles('outputs/source-summaries');

  for (const summaryPath of summaries) {
    try {
      const content = await vault.read(summaryPath);
      if (!content.includes(oldPath)) continue;

      const { data, body } = parseNote(content);

      let changed = false;

      // Update source_path
      if (data.source_path === oldPath) {
        data.source_path = newPath;
        changed = true;
      }

      // Update source_refs array
      if (Array.isArray(data.source_refs)) {
        const idx = (data.source_refs as string[]).indexOf(oldPath);
        if (idx !== -1) {
          (data.source_refs as string[])[idx] = newPath;
          changed = true;
        }
      }

      if (changed) {
        data.updated_at = nowISO();
        const updatedBody = body.replace(new RegExp(escapeRegExp(oldPath), 'g'), newPath);
        const updated = serializeNote(data, updatedBody);
        await vault.atomicWrite(summaryPath, updated);
      }
    } catch { /* ignore individual failures */ }
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

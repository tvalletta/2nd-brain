// Reusable Cursor-import logic. Shared by:
//   - the `karpathy import-cursor-sessions` CLI (interactive, verbose)
//   - the `karpathy intel tick` scheduled job (silent unless something exports)
//
// Walks `~/.cursor/chats/<workspace>/<session>/store.db` and exports any
// session not already in `state/exported-sessions.json` to the vault's
// `raw/ai-conversations/cursor/<project>/<date>-<id>.md` location.

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KarpathyConfig } from '../config/schema.js';
import { exportCursorSessionToRaw } from './export-cursor-session.js';
import { createLogger } from '../shared/logger.js';
import { layoutFromConfig } from '../vault/paths.js';

const log = createLogger('import-cursor');

export interface ImportCursorOptions {
  /** Override the default `~/.cursor/chats` path (used by tests). */
  chatsDir?: string;
  /** Emit per-session info via stdout. Default false (silent). */
  verbose?: boolean;
}

export interface ImportCursorResult {
  total: number;
  exported: number;
  skipped: number;
  exportedPaths: string[];
}

export async function importNewCursorSessions(
  config: KarpathyConfig,
  stateDir: string,
  options: ImportCursorOptions = {},
): Promise<ImportCursorResult> {
  const verbose = options.verbose ?? false;
  const chatsDir = options.chatsDir ?? join(homedir(), '.cursor', 'chats');

  const result: ImportCursorResult = { total: 0, exported: 0, skipped: 0, exportedPaths: [] };

  let workspaceDirs: string[];
  try {
    workspaceDirs = await readdir(chatsDir);
  } catch {
    log.debug('No Cursor chats directory found, skipping', { chatsDir });
    return result;
  }

  for (const wsHash of workspaceDirs) {
    const wsDir = join(chatsDir, wsHash);
    const wsStat = await stat(wsDir).catch(() => null);
    if (!wsStat?.isDirectory()) continue;

    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(wsDir);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      const dbPath = join(wsDir, sessionId, 'store.db');
      const dbStat = await stat(dbPath).catch(() => null);
      if (!dbStat) continue;

      result.total += 1;
      try {
        const out = await exportCursorSessionToRaw(dbPath, stateDir, {
          minTurns: config.session.minTurns,
          vaultPath: config.vaultPath,
          layout: layoutFromConfig(config),
        });
        if (out.exported && out.stagingPath) {
          result.exported += 1;
          result.exportedPaths.push(out.stagingPath);
          if (verbose) process.stdout.write(`  Exported: ${sessionId} → ${out.stagingPath}\n`);
        } else {
          result.skipped += 1;
          log.debug('Skipped Cursor session', { sessionId, reason: out.reason });
        }
      } catch (err) {
        result.skipped += 1;
        if (verbose) {
          process.stderr.write(`  Failed: ${sessionId}: ${(err as Error).message}\n`);
        }
        log.debug('Cursor session export failed', { sessionId, error: (err as Error).message });
      }
    }
  }

  return result;
}

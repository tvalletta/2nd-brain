import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSessionJSONL } from './jsonl-parser.js';
import { formatSessionMarkdown, sessionExportFilename } from './session-exporter.js';
import { createExportTracker } from './export-tracker.js';
import { atomicWrite, ensureDir } from '../shared/fs-utils.js';
import { computeSessionRawPath } from '../ingest/session-router.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('export-session');

const EXPORTS_DIR = 'exports';
const DEFAULT_MIN_TURNS = 2;

export interface ExportResult {
  sessionId: string;
  exported: boolean;
  /** Absolute path where the file was written (staging or vault) */
  stagingPath?: string;
  /** Vault-relative path for the raw AI conversation (when vaultPath is provided) */
  vaultRawPath?: string;
  reason?: string;
}

export interface ExportConfig {
  minTurns?: number;
  /** If provided, export directly to the vault's ai-conversations directory */
  vaultPath?: string;
  /** Vault layout — controls where ai-conversations land. Defaults to legacy layout. */
  layout?: import('../vault/paths.js').VaultLayout;
}

export async function exportSessionToRaw(
  jsonlPath: string,
  stateDir: string,
  config?: ExportConfig,
): Promise<ExportResult> {
  const minTurns = config?.minTurns ?? DEFAULT_MIN_TURNS;

  // Parse the JSONL
  const session = await parseSessionJSONL(jsonlPath);

  if (!session.sessionId) {
    return { sessionId: '', exported: false, reason: 'no session ID found in JSONL' };
  }

  // Check dedup
  const tracker = createExportTracker(stateDir);
  await tracker.load();

  if (tracker.isExported(session.sessionId)) {
    log.debug('Session already exported', { sessionId: session.sessionId });
    return { sessionId: session.sessionId, exported: false, reason: 'already exported' };
  }

  // Count real turns (user prompts + assistant text, not tool-use)
  const realTurns = session.turns.filter(
    (t) => t.type === 'user-prompt' || t.type === 'assistant-text',
  ).length;

  if (realTurns < minTurns) {
    log.debug('Session too small', { sessionId: session.sessionId, realTurns, minTurns });
    return { sessionId: session.sessionId, exported: false, reason: `too few turns (${realTurns})` };
  }

  // Format as markdown
  const markdown = formatSessionMarkdown(session);
  const sourceHash = createHash('sha256').update(markdown).digest('hex').slice(0, 16);

  let stagingPath: string;
  let vaultRawPath: string | undefined;

  if (config?.vaultPath) {
    // Route to vault's ai-conversations directory structure
    const { rawPath } = computeSessionRawPath(session, 'claude', config?.layout);
    vaultRawPath = rawPath;
    stagingPath = join(config.vaultPath, rawPath);
    const dir = stagingPath.slice(0, stagingPath.lastIndexOf('/'));
    await ensureDir(dir);
  } else {
    // Legacy: write to flat exports/ directory
    const exportsDir = join(stateDir, '..', EXPORTS_DIR);
    await ensureDir(exportsDir);
    const fileName = sessionExportFilename(session);
    stagingPath = join(exportsDir, fileName);
  }

  await atomicWrite(stagingPath, markdown);

  // Mark as exported
  tracker.markExported(session.sessionId, sourceHash);
  await tracker.flush();

  log.info('Session exported', { sessionId: session.sessionId, stagingPath, vaultRawPath, realTurns });
  return { sessionId: session.sessionId, exported: true, stagingPath, vaultRawPath };
}

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCursorChat } from './cursor-parser.js';
import { formatSessionMarkdown, sessionExportFilename } from './session-exporter.js';
import { createExportTracker } from './export-tracker.js';
import { atomicWrite, ensureDir } from '../shared/fs-utils.js';
import { computeSessionRawPath } from '../ingest/session-router.js';
import { createLogger } from '../shared/logger.js';
import type { ExportResult, ExportConfig } from './export-session.js';

const log = createLogger('export-cursor');

const EXPORTS_DIR = 'exports';
const DEFAULT_MIN_TURNS = 2;

export async function exportCursorSessionToRaw(
  dbPath: string,
  stateDir: string,
  config?: ExportConfig,
): Promise<ExportResult> {
  const minTurns = config?.minTurns ?? DEFAULT_MIN_TURNS;

  const session = await parseCursorChat(dbPath);

  if (!session.sessionId) {
    return { sessionId: '', exported: false, reason: 'no session ID found in database' };
  }

  // Check dedup
  const tracker = createExportTracker(stateDir);
  await tracker.load();

  if (tracker.isExported(session.sessionId)) {
    log.debug('Cursor session already exported', { sessionId: session.sessionId });
    return { sessionId: session.sessionId, exported: false, reason: 'already exported' };
  }

  // Count real turns
  const realTurns = session.turns.filter(
    (t) => t.type === 'user-prompt' || t.type === 'assistant-text',
  ).length;

  if (realTurns < minTurns) {
    log.debug('Cursor session too small', { sessionId: session.sessionId, realTurns, minTurns });
    return { sessionId: session.sessionId, exported: false, reason: `too few turns (${realTurns})` };
  }

  // Format as markdown
  const markdown = formatSessionMarkdown(session);
  const sourceHash = createHash('sha256').update(markdown).digest('hex').slice(0, 16);

  let stagingPath: string;
  let vaultRawPath: string | undefined;

  if (config?.vaultPath) {
    // Route to vault's ai-conversations directory structure
    const { rawPath } = computeSessionRawPath(session, 'cursor', config?.layout);
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

  log.info('Cursor session exported', { sessionId: session.sessionId, stagingPath, vaultRawPath, realTurns });
  return { sessionId: session.sessionId, exported: true, stagingPath, vaultRawPath };
}

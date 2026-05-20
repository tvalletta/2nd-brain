// Auto-backfill: detects when an existing vault hasn't yet had time-aware
// frontmatter fields populated and runs the backfill once.
//
// Persists a marker in `.karpathy/state/intel-scheduler.json` (under a
// dedicated key so it shows up alongside scheduled-job state) so the check
// doesn't repeat every tick. The actual backfill is itself idempotent — this
// is just an optimization to avoid scanning the whole vault every tick.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultAdapter } from '../vault/adapter.js';
import { backfillTimeAwareFields } from '../maintenance/backfill-time-aware.js';
import { atomicWrite } from '../shared/fs-utils.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MARKER_FILE = 'intel-scheduler.json';
const MARKER_KEY = 'autoBackfillCompletedAt';

interface MarkerFile {
  lastFire?: Record<string, string>;
  [k: string]: unknown;
}

function readMarker(stateDir: string): MarkerFile {
  const path = join(stateDir, MARKER_FILE);
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as MarkerFile;
  } catch {
    return {};
  }
}

async function writeMarker(stateDir: string, data: MarkerFile): Promise<void> {
  const path = join(stateDir, MARKER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(data, null, 2));
}

export interface AutoBackfillResult {
  ran: boolean;
  reason: string;
  filesUpdated?: number;
  fieldsAdded?: Record<string, number>;
}

export async function maybeRunAutoBackfill(
  vault: VaultAdapter,
  stateDir: string,
  folders?: string[],
): Promise<AutoBackfillResult> {
  const marker = readMarker(stateDir);
  if (typeof marker[MARKER_KEY] === 'string') {
    return { ran: false, reason: 'already-completed' };
  }
  const result = await backfillTimeAwareFields(vault, folders);
  marker[MARKER_KEY] = new Date().toISOString();
  await writeMarker(stateDir, marker);
  return {
    ran: true,
    reason: 'first-run',
    filesUpdated: result.filesUpdated,
    fieldsAdded: result.fieldsAdded,
  };
}

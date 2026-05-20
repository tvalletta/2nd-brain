import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, fileExists, ensureDir } from '../shared/fs-utils.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('export-tracker');

const TRACKER_FILE = 'exported-sessions.json';

interface ExportEntry {
  exportedAt: string;
  sourceHash: string;
}

export interface ExportTracker {
  isExported(sessionId: string): boolean;
  markExported(sessionId: string, sourceHash: string): void;
  load(): Promise<void>;
  flush(): Promise<void>;
}

export function createExportTracker(stateDir: string): ExportTracker {
  const filePath = join(stateDir, TRACKER_FILE);
  let entries: Record<string, ExportEntry> = {};

  return {
    isExported(sessionId) {
      return sessionId in entries;
    },

    markExported(sessionId, sourceHash) {
      entries[sessionId] = { exportedAt: nowISO(), sourceHash };
    },

    async load() {
      if (!(await fileExists(filePath))) {
        entries = {};
        return;
      }
      try {
        const raw = await readFile(filePath, 'utf-8');
        entries = JSON.parse(raw) as Record<string, ExportEntry>;
        log.debug('Loaded export tracker', { count: Object.keys(entries).length });
      } catch {
        log.warn('Failed to load export tracker, starting fresh');
        entries = {};
      }
    },

    async flush() {
      await ensureDir(stateDir);
      await atomicWrite(filePath, JSON.stringify(entries, null, 2));
    },
  };
}

import { readFile } from 'node:fs/promises';
import {
  getProtectedRegion,
  updateProtectedRegion,
} from '../vault/protected-regions.js';
import { atomicWrite, fileExists } from '../shared/fs-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hot-cache');

const MAX_RECENT_SESSIONS = 10;
const MAX_KEY_ENTITIES = 20;

export interface SessionEntry {
  date: string;
  summary: string;
  noteLink: string;
}

export interface EntityEntry {
  name: string;
  link: string;
  description: string;
}

export interface HotCacheManager {
  read(): Promise<string>;
  getRegion(regionId: string): Promise<string | null>;
  updateRegion(regionId: string, content: string): Promise<void>;
  appendSession(entry: SessionEntry): Promise<void>;
  addEntity(entry: EntityEntry): Promise<void>;
  toContext(): Promise<string>;
  flush(): Promise<void>;
}

export function createHotCacheManager(claudeMdPath: string): HotCacheManager {
  let cached: string | null = null;

  async function load(): Promise<string> {
    if (cached !== null) return cached;
    if (await fileExists(claudeMdPath)) {
      cached = await readFile(claudeMdPath, 'utf-8');
    } else {
      cached = '';
    }
    return cached;
  }

  async function save(): Promise<void> {
    if (cached === null) return;
    await atomicWrite(claudeMdPath, cached);
  }

  return {
    async read() {
      return load();
    },

    async getRegion(regionId) {
      const content = await load();
      return getProtectedRegion(content, regionId);
    },

    async updateRegion(regionId, newContent) {
      const content = await load();
      cached = updateProtectedRegion(content, regionId, newContent);
    },

    async appendSession(entry) {
      const content = await load();
      const existing = getProtectedRegion(content, 'recent-sessions') ?? '';
      const lines = existing.split('\n').filter((l) => l.trim().length > 0);
      const newLine = `- ${entry.date}: ${entry.summary} ([[${entry.noteLink}]])`;
      lines.unshift(newLine);
      const trimmed = lines.slice(0, MAX_RECENT_SESSIONS);
      cached = updateProtectedRegion(content, 'recent-sessions', trimmed.join('\n'));
    },

    async addEntity(entry) {
      const content = await load();
      const existing = getProtectedRegion(content, 'key-entities') ?? '';
      const lines = existing.split('\n').filter((l) => l.trim().length > 0);

      // Don't add duplicates
      if (lines.some((l) => l.includes(`[[${entry.link}]]`))) return;

      lines.push(`[[${entry.link}]] — ${entry.description}`);
      const trimmed = lines.slice(-MAX_KEY_ENTITIES);
      cached = updateProtectedRegion(content, 'key-entities', trimmed.join('\n'));
    },

    async toContext() {
      return load();
    },

    async flush() {
      await save();
      log.debug('Hot cache flushed');
    },
  };
}

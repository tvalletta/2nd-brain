import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('digest-cache');

/**
 * A pre-summarized digest of a conversation, stored for token-efficient
 * re-synthesis. Instead of feeding full conversations (~thousands of tokens)
 * to the Opus model during full re-synthesis, we feed digests (~200-500 tokens).
 */
export interface ConversationDigest {
  /** Path to the raw source file in the vault */
  sourcePath: string;
  /** SHA-256 hash of the source content at digest time */
  sourceHash: string;
  /** The condensed digest text (~200-500 tokens) */
  digest: string;
  /** Key entities mentioned */
  entities: string[];
  /** Main topics covered */
  topics: string[];
  /** Decisions made (if any) */
  decisions: string[];
  /** ISO timestamp of when the digest was created */
  createdAt: string;
}

export interface DigestCacheState {
  digests: Record<string, ConversationDigest>;
}

/**
 * Compute a SHA-256 hash of content.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Create a digest cache backed by a JSON file in the state directory.
 * Digests are keyed by source path for efficient lookup.
 */
export function createDigestCache(stateDir: string) {
  const cachePath = join(stateDir, 'digests', 'digest-cache.json');

  async function load(): Promise<DigestCacheState> {
    try {
      const content = await readFile(cachePath, 'utf-8');
      return JSON.parse(content) as DigestCacheState;
    } catch {
      return { digests: {} };
    }
  }

  async function save(state: DigestCacheState): Promise<void> {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  return {
    /**
     * Get a cached digest for a source path.
     * Returns null if no digest exists or if the source has changed
     * (hash mismatch).
     */
    async get(sourcePath: string, currentHash?: string): Promise<ConversationDigest | null> {
      const state = await load();
      const digest = state.digests[sourcePath];
      if (!digest) return null;

      // If a current hash is provided, check freshness
      if (currentHash && digest.sourceHash !== currentHash) {
        log.debug('Digest stale (hash mismatch)', { sourcePath });
        return null;
      }

      return digest;
    },

    /**
     * Store a digest for a source path.
     */
    async set(digest: ConversationDigest): Promise<void> {
      const state = await load();
      state.digests[digest.sourcePath] = digest;
      await save(state);
      log.debug('Digest cached', { sourcePath: digest.sourcePath });
    },

    /**
     * Get all digests for a given project (source paths matching a pattern).
     * Used during full re-synthesis to gather all conversation digests for a project.
     */
    async getForProject(projectSlug: string): Promise<ConversationDigest[]> {
      const state = await load();
      const results: ConversationDigest[] = [];

      for (const [sourcePath, digest] of Object.entries(state.digests)) {
        if (sourcePath.includes(`/${projectSlug}/`)) {
          results.push(digest);
        }
      }

      return results;
    },

    /**
     * Remove a digest entry.
     */
    async remove(sourcePath: string): Promise<boolean> {
      const state = await load();
      if (state.digests[sourcePath]) {
        delete state.digests[sourcePath];
        await save(state);
        return true;
      }
      return false;
    },

    /**
     * Get all digests.
     */
    async getAll(): Promise<DigestCacheState> {
      return load();
    },

    /**
     * Remove digest entries whose source files no longer exist.
     * Returns the number of pruned entries.
     */
    async prune(fileExists: (path: string) => Promise<boolean>): Promise<number> {
      const state = await load();
      const sourcePaths = Object.keys(state.digests);
      let pruned = 0;

      for (const sourcePath of sourcePaths) {
        const exists = await fileExists(sourcePath);
        if (!exists) {
          delete state.digests[sourcePath];
          pruned++;
        }
      }

      if (pruned > 0) {
        await save(state);
        log.info('Digest cache pruned', { pruned, remaining: Object.keys(state.digests).length });
      }

      return pruned;
    },
  };
}

export type DigestCache = ReturnType<typeof createDigestCache>;

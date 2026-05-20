import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDigestCache, hashContent, type ConversationDigest } from '../../src/agent/digest-cache.js';

describe('digest-cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-digest-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('hashContent', () => {
    it('returns a deterministic 16-char hex hash', () => {
      const hash = hashContent('hello world');
      expect(hash).toHaveLength(16);
      expect(hash).toBe(hashContent('hello world'));
    });

    it('returns different hashes for different content', () => {
      expect(hashContent('hello')).not.toBe(hashContent('world'));
    });
  });

  describe('createDigestCache', () => {
    it('returns null for missing digest', async () => {
      const cache = createDigestCache(tempDir);
      const result = await cache.get('nonexistent.md');
      expect(result).toBeNull();
    });

    it('stores and retrieves a digest', async () => {
      const cache = createDigestCache(tempDir);
      const digest: ConversationDigest = {
        sourcePath: 'raw/ai-conversations/claude/my-project/session-001.md',
        sourceHash: 'abc123',
        digest: 'This conversation discussed authentication patterns.',
        entities: ['OAuth', 'JWT'],
        topics: ['authentication', 'security'],
        decisions: ['Use OAuth2 with PKCE flow'],
        createdAt: '2026-01-01T00:00:00Z',
      };

      await cache.set(digest);
      const result = await cache.get(digest.sourcePath);

      expect(result).not.toBeNull();
      expect(result!.digest).toBe(digest.digest);
      expect(result!.entities).toEqual(['OAuth', 'JWT']);
      expect(result!.decisions).toEqual(['Use OAuth2 with PKCE flow']);
    });

    it('returns null when hash mismatches', async () => {
      const cache = createDigestCache(tempDir);
      const digest: ConversationDigest = {
        sourcePath: 'raw/session.md',
        sourceHash: 'abc123',
        digest: 'Some digest.',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      };

      await cache.set(digest);
      const result = await cache.get('raw/session.md', 'different-hash');
      expect(result).toBeNull();
    });

    it('returns digest when hash matches', async () => {
      const cache = createDigestCache(tempDir);
      const digest: ConversationDigest = {
        sourcePath: 'raw/session.md',
        sourceHash: 'abc123',
        digest: 'Some digest.',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      };

      await cache.set(digest);
      const result = await cache.get('raw/session.md', 'abc123');
      expect(result).not.toBeNull();
      expect(result!.digest).toBe('Some digest.');
    });

    it('gets digests for a project slug', async () => {
      const cache = createDigestCache(tempDir);

      await cache.set({
        sourcePath: 'raw/ai-conversations/claude/my-project/s1.md',
        sourceHash: 'h1',
        digest: 'Digest 1',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      });
      await cache.set({
        sourcePath: 'raw/ai-conversations/claude/my-project/s2.md',
        sourceHash: 'h2',
        digest: 'Digest 2',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-02T00:00:00Z',
      });
      await cache.set({
        sourcePath: 'raw/ai-conversations/claude/other-project/s3.md',
        sourceHash: 'h3',
        digest: 'Digest 3',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-03T00:00:00Z',
      });

      const results = await cache.getForProject('my-project');
      expect(results).toHaveLength(2);
      expect(results.map((d) => d.digest).sort()).toEqual(['Digest 1', 'Digest 2']);
    });

    it('removes a digest', async () => {
      const cache = createDigestCache(tempDir);
      await cache.set({
        sourcePath: 'raw/session.md',
        sourceHash: 'h1',
        digest: 'Temp',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      });

      const removed = await cache.remove('raw/session.md');
      expect(removed).toBe(true);

      const result = await cache.get('raw/session.md');
      expect(result).toBeNull();
    });

    it('returns false when removing nonexistent digest', async () => {
      const cache = createDigestCache(tempDir);
      const removed = await cache.remove('nonexistent.md');
      expect(removed).toBe(false);
    });

    it('persists across cache instances', async () => {
      const cache1 = createDigestCache(tempDir);
      await cache1.set({
        sourcePath: 'raw/session.md',
        sourceHash: 'h1',
        digest: 'Persisted',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      });

      const cache2 = createDigestCache(tempDir);
      const result = await cache2.get('raw/session.md');
      expect(result).not.toBeNull();
      expect(result!.digest).toBe('Persisted');
    });

    it('prunes digests for deleted source files', async () => {
      const cache = createDigestCache(tempDir);

      await cache.set({
        sourcePath: 'raw/exists.md',
        sourceHash: 'h1',
        digest: 'Exists',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      });
      await cache.set({
        sourcePath: 'raw/deleted.md',
        sourceHash: 'h2',
        digest: 'Deleted',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-02T00:00:00Z',
      });

      const pruned = await cache.prune(async (path) => path === 'raw/exists.md');
      expect(pruned).toBe(1);

      const remaining = await cache.get('raw/exists.md');
      expect(remaining).not.toBeNull();

      const removed = await cache.get('raw/deleted.md');
      expect(removed).toBeNull();
    });

    it('prune returns 0 when all files exist', async () => {
      const cache = createDigestCache(tempDir);
      await cache.set({
        sourcePath: 'raw/session.md',
        sourceHash: 'h1',
        digest: 'Still here',
        entities: [],
        topics: [],
        decisions: [],
        createdAt: '2026-01-01T00:00:00Z',
      });

      const pruned = await cache.prune(async () => true);
      expect(pruned).toBe(0);
    });
  });
});

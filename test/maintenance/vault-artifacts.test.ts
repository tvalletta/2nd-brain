import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { appendLogEntry, VAULT_LOG_PATH } from '../../src/maintenance/vault-log.js';
import { rebuildVaultIndex, VAULT_INDEX_PATH } from '../../src/maintenance/vault-index.js';
import {
  readResearchQueue,
  writeResearchQueue,
  upsertCandidate,
} from '../../src/maintenance/research-queue.js';

describe('vault root artifacts', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-art-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('vault-log', () => {
    it('appends entries newest-first inside a protected region', async () => {
      await appendLogEntry(vault, { kind: 'ingest', message: 'first', at: '2026-05-01T00:00:00Z' });
      await appendLogEntry(vault, { kind: 'ingest', message: 'second', at: '2026-05-02T00:00:00Z' });
      const content = await vault.read(VAULT_LOG_PATH);
      // Match the entry messages, not the prose header which contains "first".
      const firstIdx = content.indexOf('— first');
      const secondIdx = content.indexOf('— second');
      expect(secondIdx).toBeGreaterThan(-1);
      expect(secondIdx).toBeLessThan(firstIdx);
      expect(content).toContain('%% begin:log-entries %%');
      expect(content).toContain('%% end:log-entries %%');
    });

    it('preserves user content above the region', async () => {
      await vault.create(
        VAULT_LOG_PATH,
        '# Custom header\n\nSome user content.\n\n%% begin:log-entries %%\n- existing\n%% end:log-entries %%\n',
      );
      await appendLogEntry(vault, { kind: 'digest', message: 'weekly', at: '2026-05-02T00:00:00Z' });
      const content = await vault.read(VAULT_LOG_PATH);
      expect(content).toContain('# Custom header');
      expect(content).toContain('Some user content');
      expect(content).toContain('weekly');
      expect(content).toContain('existing');
    });
  });

  describe('vault-index', () => {
    it('lists concepts/topics/projects with TL;DR and sorts by hot_score then date', async () => {
      await vault.ensureFolder('wiki/concepts');
      await vault.ensureFolder('wiki/topics');
      const a = `---
id: a
type: concept
title: FSRS
last_verified: 2026-04-01
hot_score: 0.5
tldr: Spaced repetition algorithm.
---
`;
      const b = `---
id: b
type: topic
title: Recency
last_verified: 2026-05-01
tldr: Time decay in retrieval.
---
`;
      await vault.create('wiki/concepts/fsrs.md', a);
      await vault.create('wiki/topics/recency.md', b);

      const result = await rebuildVaultIndex(vault);
      expect(result.entries).toBe(2);

      const content = await vault.read(VAULT_INDEX_PATH);
      const fIdx = content.indexOf('FSRS');
      const rIdx = content.indexOf('Recency');
      expect(fIdx).toBeGreaterThan(-1);
      expect(rIdx).toBeGreaterThan(-1);
      // FSRS has hot_score 0.5 — should come first.
      expect(fIdx).toBeLessThan(rIdx);
      expect(content).toContain('Spaced repetition algorithm');
    });

    it('skips _index.md files', async () => {
      await vault.ensureFolder('wiki/projects/p');
      await vault.create(
        'wiki/projects/p/_index.md',
        '---\nid: p-i\ntype: index\ntitle: Project\n---\n',
      );
      const result = await rebuildVaultIndex(vault);
      expect(result.entries).toBe(0);
    });
  });

  describe('research-queue', () => {
    const candidate = {
      slug: 'fsrs',
      title: 'FSRS',
      score: 0.84,
      reason: 'mentioned 6× last week',
      suggested: 'medium' as const,
      status: 'pending' as const,
      addedAt: '2026-05-06T00:00:00Z',
    };

    it('reads back what it wrote', async () => {
      await writeResearchQueue(vault, { candidates: [candidate] });
      const round = await readResearchQueue(vault);
      expect(round.candidates).toHaveLength(1);
      expect(round.candidates[0].slug).toBe('fsrs');
      expect(round.candidates[0].score).toBeCloseTo(0.84);
      expect(round.candidates[0].suggested).toBe('medium');
      expect(round.candidates[0].decision).toBeUndefined();
    });

    it('preserves user-set decision on upsert', async () => {
      await writeResearchQueue(vault, { candidates: [candidate] });
      // User edits queue and sets decision.
      const after = await readResearchQueue(vault);
      after.candidates[0].decision = 'heavy';
      await writeResearchQueue(vault, after);
      // System re-proposes — should keep user's decision.
      await upsertCandidate(vault, { ...candidate, score: 0.9 });
      const final = await readResearchQueue(vault);
      expect(final.candidates[0].decision).toBe('heavy');
      expect(final.candidates[0].score).toBeCloseTo(0.9);
    });

    it('returns empty queue when file does not exist', async () => {
      const empty = await readResearchQueue(vault);
      expect(empty.candidates).toEqual([]);
    });
  });
});

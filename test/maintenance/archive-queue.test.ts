import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  readArchiveQueue,
  writeArchiveQueue,
  refreshArchiveQueue,
  resolveArchiveEntry,
  pendingArchiveEntries,
  applyArchiveDecision,
  type ArchiveEntry,
} from '../../src/maintenance/archive-queue.js';
import { serializeNote, parseNote } from '../../src/vault/frontmatter.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });
const layout = config.layout;

describe('archive-queue', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-aq-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder(layout.system);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty queue when file does not exist', async () => {
    const queue = await readArchiveQueue(vault, layout);
    expect(queue.entries).toEqual([]);
  });

  it('round-trips entries through write/read', async () => {
    await writeArchiveQueue(vault, {
      entries: [{
        id: 'abc',
        status: 'pending',
        path: 'wiki/concepts/glossary.md',
        title: 'Concept glossary',
        reason: 'rot-scan: age 9999d, confidence unknown, inbound no',
        ageDays: 9999,
        confidence: 'unknown',
      }],
    }, layout);

    const queue = await readArchiveQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0].id).toBe('abc');
    expect(queue.entries[0].title).toBe('Concept glossary');
    expect(queue.entries[0].status).toBe('pending');
  });

  it('refreshArchiveQueue appends new candidates', async () => {
    const candidates = [{
      path: 'wiki/topics/old-topic.md',
      title: 'Old topic',
      reason: 'rot-scan: age 300d, confidence low, inbound no',
      ageDays: 300,
      confidence: 'low',
    }];

    const added = await refreshArchiveQueue(vault, candidates, layout);
    expect(added).toBe(1);

    const queue = await readArchiveQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0].status).toBe('pending');
  });

  it('refreshArchiveQueue is idempotent — same path not re-added regardless of resolution status', async () => {
    const candidates = [{
      path: 'wiki/projects/dead-project.md',
      title: 'Dead project',
      reason: 'rot-scan: age 500d, confidence low, inbound no',
      ageDays: 500,
      confidence: 'low',
    }];

    const first = await refreshArchiveQueue(vault, candidates, layout);
    expect(first).toBe(1);

    const queue = await readArchiveQueue(vault, layout);
    await resolveArchiveEntry(vault, queue.entries[0].id, 'keep', undefined, layout);

    const second = await refreshArchiveQueue(vault, candidates, layout);
    expect(second).toBe(0);

    const finalQueue = await readArchiveQueue(vault, layout);
    expect(finalQueue.entries).toHaveLength(1);
    expect(finalQueue.entries[0].status).toBe('resolved');
  });

  it('resolveArchiveEntry marks entry resolved with decision', async () => {
    await writeArchiveQueue(vault, {
      entries: [{
        id: 'entry1', status: 'pending', path: 'a.md', title: 'A',
        reason: 'test', ageDays: 100, confidence: 'low',
      }],
    }, layout);

    const resolved = await resolveArchiveEntry(vault, 'entry1', 'archive', undefined, layout);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.decision).toBe('archive');
    expect(resolved!.resolvedAt).toBeDefined();
  });

  it('resolveArchiveEntry marks a skip decision as status: skipped', async () => {
    await writeArchiveQueue(vault, {
      entries: [{
        id: 'entry2', status: 'pending', path: 'b.md', title: 'B',
        reason: 'test', ageDays: 100, confidence: 'low',
      }],
    }, layout);

    const resolved = await resolveArchiveEntry(vault, 'entry2', 'skip', undefined, layout);
    expect(resolved!.status).toBe('skipped');
  });

  it('resolveArchiveEntry returns null for unknown id', async () => {
    await writeArchiveQueue(vault, { entries: [] }, layout);
    const result = await resolveArchiveEntry(vault, 'nonexistent', 'keep', undefined, layout);
    expect(result).toBeNull();
  });

  it('pendingArchiveEntries filters to pending status only', async () => {
    const queue = {
      entries: [
        { id: '1', status: 'pending' as const, path: 'a.md', title: 'A', reason: 'r', ageDays: 1, confidence: 'low' },
        { id: '2', status: 'resolved' as const, path: 'b.md', title: 'B', reason: 'r', ageDays: 1, confidence: 'low', decision: 'archive' as const, resolvedAt: new Date().toISOString() },
        { id: '3', status: 'skipped' as const, path: 'c.md', title: 'C', reason: 'r', ageDays: 1, confidence: 'low' },
      ],
    };
    const pending = pendingArchiveEntries(queue);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('1');
  });

  describe('applyArchiveDecision', () => {
    async function makeEntry(path: string, type = 'concept'): Promise<ArchiveEntry> {
      // NOTE: `id` (and thus the serialized frontmatter+body string) must be
      // unique per call — gray-matter's `matter()` caches parsed results
      // keyed by the raw content string when no options are passed
      // (confirmed directly: parsing byte-identical content twice, after
      // mutating the first parse's `data` in place, returns the same
      // mutated object on the second parse). Byte-identical fixture notes
      // across different `it()` blocks would otherwise leak
      // `applyArchiveDecision` mutations from one test's note into another
      // test's unrelated note of the same shape.
      await vault.create(
        path,
        serializeNote(
          { id: path, type, title: 'Target', status: 'draft', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
          '# Target\n',
        ),
      );
      await refreshArchiveQueue(vault, [{
        path, title: 'Target', reason: 'rot-scan: age 400d, confidence low, inbound no', ageDays: 400, confidence: 'low',
      }], layout);
      const queue = await readArchiveQueue(vault, layout);
      return queue.entries[0];
    }

    it('"archive" sets status: archived, archived_at, archived_reason (from entry.reason) on the target note', async () => {
      const entry = await makeEntry('wiki/concepts/target.md');
      const resolved = await applyArchiveDecision(vault, entry, 'archive', undefined, layout);
      expect(resolved!.status).toBe('resolved');
      expect(resolved!.decision).toBe('archive');

      const { data } = parseNote(await vault.read('wiki/concepts/target.md'));
      expect(data.status).toBe('archived');
      expect(data.archived_at).toBeDefined();
      expect(data.archived_reason).toBe(entry.reason);
    });

    it('"archive" also sets project_status: archived when the target note is type: project (G4)', async () => {
      const entry = await makeEntry('wiki/projects/target-project.md', 'project');
      await applyArchiveDecision(vault, entry, 'archive', undefined, layout);

      const { data } = parseNote(await vault.read('wiki/projects/target-project.md'));
      expect(data.status).toBe('archived');
      expect(data.project_status).toBe('archived');
    });

    it('"supersede" archives the note and appends supersededByPath to superseded_by, deduped across repeat calls (G4)', async () => {
      const entry = await makeEntry('wiki/concepts/old.md');
      await vault.create(
        'wiki/concepts/new.md',
        serializeNote(
          { id: 'x2', type: 'concept', title: 'New', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
          '# New\n',
        ),
      );

      const resolved = await applyArchiveDecision(vault, entry, 'supersede', 'wiki/concepts/new.md', layout);
      expect(resolved!.decision).toBe('supersede');
      expect(resolved!.supersededByPath).toBe('wiki/concepts/new.md');

      const { data } = parseNote(await vault.read('wiki/concepts/old.md'));
      expect(data.status).toBe('archived');
      expect(data.archived_reason).toBe('superseded');
      expect(data.superseded_by).toEqual(['wiki/concepts/new.md']);

      // Repeat call with the same entry/path (e.g. a retried job, or a second
      // resolution attempt against a still-stale in-memory `entry` object) —
      // `superseded_by`'s Set-based merge in `applyArchiveDecision` must not
      // duplicate the entry on a second write to the same target note.
      await applyArchiveDecision(vault, entry, 'supersede', 'wiki/concepts/new.md', layout);
      const { data: dataAfterRepeat } = parseNote(await vault.read('wiki/concepts/old.md'));
      expect(dataAfterRepeat.superseded_by).toEqual(['wiki/concepts/new.md']);
    });

    it('"keep" resolves the queue entry without touching the note', async () => {
      const entry = await makeEntry('wiki/concepts/keep-me.md');
      await applyArchiveDecision(vault, entry, 'keep', undefined, layout);

      const { data } = parseNote(await vault.read('wiki/concepts/keep-me.md'));
      expect(data.status).toBe('draft');

      const queue = await readArchiveQueue(vault, layout);
      expect(queue.entries[0].status).toBe('resolved');
      expect(queue.entries[0].decision).toBe('keep');
    });

    it('"skip" resolves the queue entry as skipped without touching the note', async () => {
      const entry = await makeEntry('wiki/concepts/skip-me.md');
      await applyArchiveDecision(vault, entry, 'skip', undefined, layout);

      const { data } = parseNote(await vault.read('wiki/concepts/skip-me.md'));
      expect(data.status).toBe('draft');

      const queue = await readArchiveQueue(vault, layout);
      expect(queue.entries[0].status).toBe('skipped');
    });
  });
});

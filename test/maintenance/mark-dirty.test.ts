import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { markDirty, clearPendingEvidence, MAX_PENDING_EVIDENCE } from '../../src/maintenance/mark-dirty.js';
import { parseNote, serializeNote } from '../../src/vault/frontmatter.js';

const FIXTURE = serializeNote(
  {
    id: 'concept-fsrs',
    type: 'concept',
    title: 'FSRS',
    status: 'active',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
  },
  'FSRS body.',
);

describe('markDirty', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  const notePath = 'wiki/concepts/fsrs.md';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-mark-dirty-'));
    vault = createFsAdapter(dir);
    await vault.create(notePath, FIXTURE);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends the first evidence and bumps count', async () => {
    const result = await markDirty(vault, { notePath, ref: 'sources/2026-05-07-paper.md' });
    expect(result.added).toBe(true);
    expect(result.pendingCount).toBe(1);

    const { data } = parseNote(await vault.read(notePath));
    expect(data.pending_evidence_count).toBe(1);
    const pending = data.pending_evidence as { ref: string; at: string }[];
    expect(pending[0].ref).toBe('sources/2026-05-07-paper.md');
    expect(typeof pending[0].at).toBe('string');
  });

  it('is idempotent on (notePath, ref)', async () => {
    await markDirty(vault, { notePath, ref: 'sources/a.md' });
    const second = await markDirty(vault, { notePath, ref: 'sources/a.md' });
    expect(second.added).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(second.pendingCount).toBe(1);
  });

  it('returns missing when the note does not exist', async () => {
    const result = await markDirty(vault, { notePath: 'wiki/missing.md', ref: 'x' });
    expect(result.added).toBe(false);
    expect(result.reason).toBe('missing');
  });

  it('caps pending_evidence at MAX_PENDING_EVIDENCE (oldest evicted)', async () => {
    for (let i = 0; i < MAX_PENDING_EVIDENCE + 5; i++) {
      await markDirty(vault, { notePath, ref: `sources/r${i}.md` });
    }
    const { data } = parseNote(await vault.read(notePath));
    const pending = data.pending_evidence as { ref: string }[];
    expect(pending).toHaveLength(MAX_PENDING_EVIDENCE);
    // Oldest (r0..r4) should have been evicted; newest should be present.
    expect(pending[pending.length - 1].ref).toBe(
      `sources/r${MAX_PENDING_EVIDENCE + 4}.md`,
    );
    expect(pending[0].ref).not.toBe('sources/r0.md');
  });

  it('clearPendingEvidence empties the queue and stamps last_verified', async () => {
    await markDirty(vault, { notePath, ref: 'sources/a.md', reason: 'new evidence' });
    await markDirty(vault, { notePath, ref: 'sources/b.md' });

    const cleared = await clearPendingEvidence(vault, notePath);
    expect(cleared).toHaveLength(2);

    const { data } = parseNote(await vault.read(notePath));
    expect(data.pending_evidence_count).toBe(0);
    expect((data.pending_evidence as unknown[])).toEqual([]);
    expect(typeof data.last_verified).toBe('string');
  });

  it('clearPendingEvidence on a missing note returns []', async () => {
    expect(await clearPendingEvidence(vault, 'wiki/missing.md')).toEqual([]);
  });
});

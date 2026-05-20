import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  readReconciliationQueue,
  writeReconciliationQueue,
  refreshQueue,
  resolveEntry,
  pendingEntries,
} from '../../src/maintenance/reconciliation-queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });
const layout = config.layout;

describe('reconciliation-queue', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-rq-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder(layout.system);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty queue when file does not exist', async () => {
    const queue = await readReconciliationQueue(vault, layout);
    expect(queue.entries).toEqual([]);
  });

  it('round-trips entries through write/read', async () => {
    await writeReconciliationQueue(vault, {
      entries: [
        {
          id: 'abc',
          status: 'pending',
          sourcePath: 'wiki/entities/people/alice.md',
          targetPath: 'wiki/entities/people/alice-smith.md',
          sourceName: 'Alice',
          targetName: 'Alice Smith',
          reason: 'Substring match with shared sources',
          confidence: 0.87,
        },
      ],
    }, layout);

    const queue = await readReconciliationQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0].id).toBe('abc');
    expect(queue.entries[0].sourceName).toBe('Alice');
    expect(queue.entries[0].status).toBe('pending');
  });

  it('refreshQueue appends new candidates', async () => {
    const candidates = [
      {
        sourcePath: 'wiki/entities/people/bob.md',
        targetPath: 'wiki/entities/people/bob-jones.md',
        sourceName: 'Bob',
        targetName: 'Bob Jones',
        reason: 'Similar names',
        confidence: 0.82,
      },
    ];

    const added = await refreshQueue(vault, candidates, layout);
    expect(added).toBe(1);

    const queue = await readReconciliationQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0].status).toBe('pending');
  });

  it('refreshQueue is idempotent — same pair not added twice', async () => {
    const candidates = [
      {
        sourcePath: 'wiki/entities/people/carol.md',
        targetPath: 'wiki/entities/people/carol-white.md',
        sourceName: 'Carol',
        targetName: 'Carol White',
        reason: 'Similar names',
        confidence: 0.9,
      },
    ];

    const first = await refreshQueue(vault, candidates, layout);
    const second = await refreshQueue(vault, candidates, layout);
    expect(first).toBe(1);
    expect(second).toBe(0);

    const queue = await readReconciliationQueue(vault, layout);
    expect(queue.entries).toHaveLength(1);
  });

  it('refreshQueue deduplicates regardless of pair order', async () => {
    const candidatesAB = [{
      sourcePath: 'wiki/a.md',
      targetPath: 'wiki/b.md',
      sourceName: 'A',
      targetName: 'B',
      reason: 'test',
      confidence: 0.8,
    }];
    const candidatesBA = [{
      sourcePath: 'wiki/b.md',
      targetPath: 'wiki/a.md',
      sourceName: 'B',
      targetName: 'A',
      reason: 'test reversed',
      confidence: 0.8,
    }];

    await refreshQueue(vault, candidatesAB, layout);
    const added = await refreshQueue(vault, candidatesBA, layout);
    expect(added).toBe(0);
  });

  it('resolveEntry marks entry resolved with decision', async () => {
    await writeReconciliationQueue(vault, {
      entries: [{
        id: 'entry1',
        status: 'pending',
        sourcePath: 'wiki/a.md',
        targetPath: 'wiki/b.md',
        sourceName: 'A',
        targetName: 'B',
        reason: 'test',
        confidence: 0.8,
      }],
    }, layout);

    const resolved = await resolveEntry(vault, 'entry1', 'merge', undefined, layout);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.decision).toBe('merge');
    expect(resolved!.resolvedAt).toBeDefined();
  });

  it('resolveEntry returns null for unknown id', async () => {
    await writeReconciliationQueue(vault, { entries: [] }, layout);
    const result = await resolveEntry(vault, 'nonexistent', 'skip', undefined, layout);
    expect(result).toBeNull();
  });

  it('pendingEntries filters to pending status only', async () => {
    const queue = {
      entries: [
        { id: '1', status: 'pending' as const, sourcePath: 'a', targetPath: 'b', sourceName: 'A', targetName: 'B', reason: 'r', confidence: 0.8 },
        { id: '2', status: 'resolved' as const, sourcePath: 'c', targetPath: 'd', sourceName: 'C', targetName: 'D', reason: 'r', confidence: 0.9, decision: 'merge' as const, resolvedAt: new Date().toISOString() },
        { id: '3', status: 'skipped' as const, sourcePath: 'e', targetPath: 'f', sourceName: 'E', targetName: 'F', reason: 'r', confidence: 0.7 },
      ],
    };
    const pending = pendingEntries(queue);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('1');
  });
});

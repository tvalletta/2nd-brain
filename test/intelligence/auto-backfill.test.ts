import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { maybeRunAutoBackfill } from '../../src/intelligence/auto-backfill.js';
import { parseNote } from '../../src/vault/frontmatter.js';

describe('auto-backfill', () => {
  let dir: string;
  let stateDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-ab-'));
    stateDir = join(dir, '.karpathy/state');
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs once on first call, then skips', async () => {
    await vault.create(
      'wiki/concepts/x.md',
      `---
id: x
type: concept
title: X
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
---
A meaningful sentence about X spans more than thirty characters.`,
    );
    const first = await maybeRunAutoBackfill(vault, stateDir);
    expect(first.ran).toBe(true);
    expect(first.filesUpdated).toBe(1);

    const { data } = parseNote(await vault.read('wiki/concepts/x.md'));
    expect(data.last_verified).toBeDefined();

    const second = await maybeRunAutoBackfill(vault, stateDir);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('already-completed');
  });

  it('handles empty vault gracefully', async () => {
    const result = await maybeRunAutoBackfill(vault, stateDir);
    expect(result.ran).toBe(true);
    expect(result.filesUpdated).toBe(0);
  });
});

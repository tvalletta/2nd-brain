import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
import { crossLinkPages } from '../../src/compilation/cross-linker.js';

describe('crossLinkPages', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-cross-linker-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('links a bare mention to an entity under a custom layout', async () => {
    const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      '---\nid: e1\ntype: entity\ntitle: Jordan Ellis\ncanonical_name: Jordan Ellis\nentity_kind: person\naliases: []\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Jordan Ellis\n',
    );
    await vault.ensureFolder('Curated/wiki/decisions');
    await vault.create(
      'Curated/wiki/decisions/some-decision.md',
      '---\ntitle: Some Decision\ncanonical_name: Some Decision\n---\nDiscussed with Jordan Ellis about scope.',
    );

    const result = await crossLinkPages(['Curated/wiki/decisions/some-decision.md'], {
      vault,
      layout: customLayout,
    });

    expect(result.linksInserted).toBeGreaterThan(0);
    const content = await vault.read('Curated/wiki/decisions/some-decision.md');
    expect(content).toContain('[[jordan-ellis');
  });
});

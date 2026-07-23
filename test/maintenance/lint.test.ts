import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
import { lintWiki } from '../../src/maintenance/lint.js';

describe('lintWiki', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-lint-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds an orphan page under a custom layout (proves buildGraph sees the right folders)', async () => {
    const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    await vault.ensureFolder('Curated/wiki/concepts');
    await vault.create(
      'Curated/wiki/concepts/orphan-topic.md',
      '---\nid: c1\ntype: concept\ntitle: Orphan Topic\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Orphan Topic\nNo other page links here.\n',
    );

    const result = await lintWiki(vault, { layout: customLayout });

    expect(result.scanned).toBe(1);
    const orphanIssues = result.issues.filter((i) => i.type === 'orphan');
    expect(orphanIssues).toHaveLength(1);
    expect(orphanIssues[0].path).toBe('Curated/wiki/concepts/orphan-topic.md');
  });

  it('finds a duplicate-candidate entity pair under a custom layout (proves buildEntityIndex sees the right folders)', async () => {
    const customLayout: VaultLayout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      '---\nid: e1\ntype: entity\ntitle: Jordan Ellis\ncanonical_name: Jordan Ellis\nentity_kind: person\naliases: []\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Jordan Ellis\n',
    );
    await vault.create(
      'Curated/wiki/entities/jordan-ellys.md',
      '---\nid: e2\ntype: entity\ntitle: Jordan Ellys\ncanonical_name: Jordan Ellys\nentity_kind: person\naliases: []\ncreated_at: 2025-01-01T00:00:00Z\nupdated_at: 2025-01-01T00:00:00Z\n---\n# Jordan Ellys\n',
    );

    const result = await lintWiki(vault, { layout: customLayout });

    const dupIssues = result.issues.filter((i) => i.type === 'duplicate-candidate');
    expect(dupIssues).toHaveLength(1);
  });
});

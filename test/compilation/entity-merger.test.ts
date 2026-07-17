import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
import { mergeEntities } from '../../src/compilation/entity-merger.js';

describe('entity-merger', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-entity-merger-'));
    vault = createFsAdapter(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('mergeEntities with the default layout', () => {
    it('finds and rewrites wikilinks under the default wiki content folders', async () => {
      await vault.ensureFolder('wiki/entities');
      await vault.ensureFolder('wiki/decisions');
      await vault.atomicWrite(
        'wiki/entities/source-entity.md',
        '---\ncanonical_name: Source Entity\n---\nBody.',
      );
      await vault.atomicWrite(
        'wiki/entities/target-entity.md',
        '---\ncanonical_name: Target Entity\n---\nBody.',
      );
      await vault.atomicWrite(
        'wiki/decisions/some-decision.md',
        '---\ntitle: Some Decision\n---\nSee [[source-entity]] for context.',
      );

      const result = await mergeEntities(
        'wiki/entities/source-entity.md',
        'wiki/entities/target-entity.md',
        vault,
      );

      expect(result.wikilinksRewritten).toBe(1);
      const decisionContent = await vault.read('wiki/decisions/some-decision.md');
      expect(decisionContent).toContain('[[target-entity]]');
      expect(decisionContent).not.toContain('[[source-entity]]');
    });
  });

  describe('mergeEntities with a non-default layout', () => {
    it('finds and rewrites wikilinks under a custom wiki content folder, not the DEFAULT_LAYOUT default', async () => {
      const customLayout: VaultLayout = {
        ...DEFAULT_LAYOUT,
        wiki: 'Curated/wiki',
      };

      await vault.ensureFolder('Curated/wiki/entities');
      await vault.ensureFolder('Curated/wiki/decisions');
      await vault.atomicWrite(
        'Curated/wiki/entities/source-entity.md',
        '---\ncanonical_name: Source Entity\n---\nBody.',
      );
      await vault.atomicWrite(
        'Curated/wiki/entities/target-entity.md',
        '---\ncanonical_name: Target Entity\n---\nBody.',
      );
      await vault.atomicWrite(
        'Curated/wiki/decisions/some-decision.md',
        '---\ntitle: Some Decision\n---\nSee [[source-entity]] for context.',
      );

      const result = await mergeEntities(
        'Curated/wiki/entities/source-entity.md',
        'Curated/wiki/entities/target-entity.md',
        vault,
        customLayout,
      );

      expect(result.wikilinksRewritten).toBe(1);
      const decisionContent = await vault.read('Curated/wiki/decisions/some-decision.md');
      expect(decisionContent).toContain('[[target-entity]]');
      expect(decisionContent).not.toContain('[[source-entity]]');
    });

    it('does NOT rewrite wikilinks if it only scans the DEFAULT_LAYOUT folders (regression guard)', async () => {
      // Sanity check that a vault laid out under a non-default `wiki` root has
      // nothing under the DEFAULT_LAYOUT's `wiki/` folder at all — proving that
      // if mergeEntities silently fell back to DEFAULT_LAYOUT, it would find 0
      // files and rewrite 0 links.
      const customLayout: VaultLayout = {
        ...DEFAULT_LAYOUT,
        wiki: 'Curated/wiki',
      };

      await vault.ensureFolder('Curated/wiki/entities');
      await vault.ensureFolder('Curated/wiki/decisions');
      await vault.atomicWrite(
        'Curated/wiki/entities/source-entity.md',
        '---\ncanonical_name: Source Entity\n---\nBody.',
      );
      await vault.atomicWrite(
        'Curated/wiki/entities/target-entity.md',
        '---\ncanonical_name: Target Entity\n---\nBody.',
      );
      await vault.atomicWrite(
        'Curated/wiki/decisions/some-decision.md',
        '---\ntitle: Some Decision\n---\nSee [[source-entity]] for context.',
      );

      const resultWithDefaultLayout = await mergeEntities(
        'Curated/wiki/entities/source-entity.md',
        'Curated/wiki/entities/target-entity.md',
        vault,
        DEFAULT_LAYOUT,
      );

      expect(resultWithDefaultLayout.wikilinksRewritten).toBe(0);
    });
  });
});

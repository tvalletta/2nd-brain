import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../src/vault/paths.js';
import { mergeEntities, detectMergeCandidates, AUTO_MERGE_THRESHOLD } from '../../src/compilation/entity-merger.js';
import { serializeNote, parseNote } from '../../src/vault/frontmatter.js';

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

describe('mergeEntities — external_ids and identity_uncertain (B2c)', () => {
  it('unions external_ids and clears identity_uncertain on the target regardless of prior state', async () => {
    const tempDir2 = await (await import('node:fs/promises')).mkdtemp(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'karpathy-merger-b2c-'),
    );
    const vault2 = createFsAdapter(tempDir2);
    await vault2.ensureFolder('wiki/entities');
    await vault2.atomicWrite(
      'wiki/entities/bryan.md',
      serializeNote(
        { canonical_name: 'Bryan', external_ids: ['slack:U01FZCB8X29'], identity_uncertain: true, aliases: [] },
        'Body.',
      ),
    );
    await vault2.atomicWrite(
      'wiki/entities/bryan-pino.md',
      serializeNote(
        { canonical_name: 'Bryan Pino', external_ids: [], identity_uncertain: false, aliases: ['pino'] },
        'Body.',
      ),
    );

    const { mergeEntities } = await import('../../src/compilation/entity-merger.js');
    await mergeEntities('wiki/entities/bryan.md', 'wiki/entities/bryan-pino.md', vault2);

    const { data } = parseNote(await vault2.read('wiki/entities/bryan-pino.md'));
    expect(data.external_ids).toEqual(['slack:U01FZCB8X29']);
    expect(data.identity_uncertain).toBe(false);

    await (await import('node:fs/promises')).rm(tempDir2, { recursive: true, force: true });
  });
});

describe('detectMergeCandidates — person name-variant tier (B2c)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-merger-tier4-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/entities');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects a person pair with zero shared source_refs (the Bryan/Pino regression fixture)', async () => {
    await vault.atomicWrite(
      'wiki/entities/bryan.md',
      serializeNote(
        { canonical_name: 'Bryan', aliases: [], source_refs: ['outputs/source-summaries/doc-a.md'] },
        'Body.',
      ),
    );
    await vault.atomicWrite(
      'wiki/entities/bryan-pino.md',
      serializeNote(
        { canonical_name: 'Bryan Pino', aliases: ['pino'], source_refs: ['outputs/source-summaries/doc-b.md'] },
        'Body.',
      ),
    );

    const candidates = await detectMergeCandidates(vault);
    const found = candidates.find(
      (c) => [c.sourceName, c.targetName].includes('Bryan') && [c.sourceName, c.targetName].includes('Bryan Pino'),
    );
    expect(found).toBeDefined();
    expect(found!.confidence).toBeLessThan(AUTO_MERGE_THRESHOLD);
  });

  it('does not detect a same-shaped pair for a non-person kind (person-only scope)', async () => {
    await vault.ensureFolder('wiki/concepts');
    await vault.atomicWrite(
      'wiki/concepts/bryan.md',
      serializeNote({ canonical_name: 'Bryan', aliases: [], source_refs: ['outputs/source-summaries/doc-a.md'] }, 'Body.'),
    );
    await vault.atomicWrite(
      'wiki/concepts/bryan-pino.md',
      serializeNote({ canonical_name: 'Bryan Pino', aliases: [], source_refs: ['outputs/source-summaries/doc-b.md'] }, 'Body.'),
    );

    const candidates = await detectMergeCandidates(vault);
    expect(candidates).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveCurrentSpec, updateSpec, listSupersededVersions } from '../../src/specs/versioner.js';

describe('spec versioner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-versioner-'));
    await mkdir(join(tempDir, 'specs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('archiveCurrentSpec', () => {
    it('returns null when no spec exists', async () => {
      const result = await archiveCurrentSpec(tempDir);
      expect(result).toBeNull();
    });

    it('archives the current spec to superseded/', async () => {
      await writeFile(join(tempDir, 'specs', 'specification.md'), '# My Spec\nContent here.');

      const result = await archiveCurrentSpec(tempDir, 'Phase 6 update');
      expect(result).not.toBeNull();
      expect(result).toContain('superseded');
      expect(result).toContain('specification-v1-');

      const archived = await readFile(result!, 'utf-8');
      expect(archived).toContain('Superseded version 1');
      expect(archived).toContain('Phase 6 update');
      expect(archived).toContain('# My Spec');
      expect(archived).toContain('Content here.');
    });

    it('increments version numbers', async () => {
      await writeFile(join(tempDir, 'specs', 'specification.md'), '# V1');
      await archiveCurrentSpec(tempDir);

      await writeFile(join(tempDir, 'specs', 'specification.md'), '# V2');
      const result = await archiveCurrentSpec(tempDir);

      expect(result).toContain('specification-v2-');
    });
  });

  describe('updateSpec', () => {
    it('archives old spec and writes new content', async () => {
      await writeFile(join(tempDir, 'specs', 'specification.md'), '# Old Spec');

      const { archivedPath, specPath } = await updateSpec(
        tempDir,
        '# New Spec\nUpdated content.',
        'Major rewrite',
      );

      expect(archivedPath).not.toBeNull();
      const newContent = await readFile(specPath, 'utf-8');
      expect(newContent).toBe('# New Spec\nUpdated content.');
    });

    it('works when no previous spec exists', async () => {
      const { archivedPath, specPath } = await updateSpec(tempDir, '# Brand New Spec');

      expect(archivedPath).toBeNull();
      const content = await readFile(specPath, 'utf-8');
      expect(content).toBe('# Brand New Spec');
    });
  });

  describe('listSupersededVersions', () => {
    it('returns empty array when no superseded dir', async () => {
      const versions = await listSupersededVersions(tempDir);
      expect(versions).toEqual([]);
    });

    it('lists versions sorted by number', async () => {
      const supersededDir = join(tempDir, 'specs', 'superseded');
      await mkdir(supersededDir, { recursive: true });
      await writeFile(join(supersededDir, 'specification-v2-2026-04-14.md'), 'v2');
      await writeFile(join(supersededDir, 'specification-v1-2026-04-10.md'), 'v1');
      await writeFile(join(supersededDir, 'specification-v3-2026-04-15.md'), 'v3');

      const versions = await listSupersededVersions(tempDir);
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(3);
      expect(versions[0].date).toBe('2026-04-10');
    });

    it('ignores non-matching files', async () => {
      const supersededDir = join(tempDir, 'specs', 'superseded');
      await mkdir(supersededDir, { recursive: true });
      await writeFile(join(supersededDir, 'specification-v1-2026-04-10.md'), 'v1');
      await writeFile(join(supersededDir, 'notes.md'), 'not a version');

      const versions = await listSupersededVersions(tempDir);
      expect(versions).toHaveLength(1);
    });
  });
});

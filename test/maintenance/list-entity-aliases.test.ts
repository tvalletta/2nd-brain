import { describe, it, expect } from 'vitest';
import { listEntitiesNeedingAliases, writeAliases } from '../../src/maintenance/list-entity-aliases.js';
import type { VaultAdapter } from '../../src/vault/adapter.js';

function fakeVault(files: Record<string, string>): VaultAdapter {
  const store = { ...files };
  return {
    async ensureFolder() {},
    async listMarkdownFiles(folder: string) {
      return Object.keys(store).filter((p) => p.startsWith(folder));
    },
    async listFiles(folder: string) {
      return Object.keys(store).filter((p) => p.startsWith(folder));
    },
    async read(path: string) {
      return store[path];
    },
    async write(path: string, content: string) {
      store[path] = content;
    },
    async create(path: string, content: string) {
      store[path] = content;
    },
    async exists(path: string) {
      return path in store;
    },
    async getModifiedTime() {
      return Date.now();
    },
    async atomicWrite(path: string, content: string) {
      store[path] = content;
    },
    async delete(path: string) {
      delete store[path];
    },
  };
}

describe('listEntitiesNeedingAliases', () => {
  it('lists every entity note with its canonical name and current (possibly empty) aliases', async () => {
    const vault = fakeVault({
      'Curated/wiki/entities/alice.md':
        '---\ntitle: Alice\ntype: entity\nentity_kind: person\ncanonical_name: Alice Smith\naliases: []\n---\nBody text.',
      'Curated/wiki/entities/bob.md':
        '---\ntitle: Bob\ntype: entity\nentity_kind: person\ncanonical_name: Bob Jones\naliases: ["Bobby"]\n---\nBody text.',
    });
    const result = await listEntitiesNeedingAliases(vault, 'Curated/wiki/entities');
    expect(result.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'Curated/wiki/entities/alice.md', canonicalName: 'Alice Smith', currentAliases: [] },
      { path: 'Curated/wiki/entities/bob.md', canonicalName: 'Bob Jones', currentAliases: ['Bobby'] },
    ]);
  });

  it('skips the entities folder _index.md file', async () => {
    const vault = fakeVault({
      'Curated/wiki/entities/_index.md': '---\ntitle: Entities Index\ntype: index\n---\nAuto-generated.',
      'Curated/wiki/entities/carol.md':
        '---\ntitle: Carol\ntype: entity\nentity_kind: person\ncanonical_name: Carol Lee\naliases: []\n---\nBody.',
    });
    const result = await listEntitiesNeedingAliases(vault, 'Curated/wiki/entities');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('Curated/wiki/entities/carol.md');
  });
});

describe('writeAliases', () => {
  it('writes new aliases into frontmatter while preserving the rest of the note', async () => {
    const vault = fakeVault({
      'Curated/wiki/entities/dan.md':
        '---\ntitle: Dan\ntype: entity\nentity_kind: person\ncanonical_name: Dan Park\naliases: []\nstatus: active\n---\nSome body content that must survive.',
    });
    await writeAliases(vault, 'Curated/wiki/entities/dan.md', ['Danny', '@dpark']);
    const updated = await vault.read('Curated/wiki/entities/dan.md');
    expect(updated).toContain('Some body content that must survive.');
    expect(updated).toMatch(/aliases:\s*\n?\s*-\s*Danny/);
    expect(updated).toMatch(/@dpark/);
    expect(updated).toContain('status: active');
  });
});

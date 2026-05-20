import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { serializeNote } from '../../src/vault/frontmatter.js';
import {
  buildEntityIndex,
  resolveEntity,
  resolveEntities,
  normalizeName,
  levenshtein,
  type EntityKind,
} from '../../src/ingest/entity-resolver.js';

describe('entity-resolver', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-resolver-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/entities');
    await vault.ensureFolder('wiki/projects');
    await vault.ensureFolder('wiki/concepts');
    await vault.ensureFolder('wiki/decisions');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createEntityFile(path: string, data: Record<string, unknown>) {
    const content = serializeNote(data, `\n# ${data.title}\n\nContent.\n`);
    await vault.create(path, content);
  }

  describe('normalizeName', () => {
    it('lowercases', () => {
      expect(normalizeName('John Smith')).toBe('john smith');
    });

    it('strips leading articles', () => {
      expect(normalizeName('The Unity Project')).toBe('unity project');
      expect(normalizeName('A Concept')).toBe('concept');
      expect(normalizeName('An Idea')).toBe('idea');
    });

    it('collapses whitespace', () => {
      expect(normalizeName('  John   Smith  ')).toBe('john smith');
    });
  });

  describe('levenshtein', () => {
    it('returns 0 for identical strings', () => {
      expect(levenshtein('abc', 'abc')).toBe(0);
    });

    it('returns correct distance for substitution', () => {
      expect(levenshtein('cat', 'car')).toBe(1);
    });

    it('returns correct distance for insertion', () => {
      expect(levenshtein('cat', 'cats')).toBe(1);
    });

    it('returns correct distance for deletion', () => {
      expect(levenshtein('cats', 'cat')).toBe(1);
    });

    it('returns string length for empty vs non-empty', () => {
      expect(levenshtein('', 'abc')).toBe(3);
      expect(levenshtein('abc', '')).toBe(3);
    });
  });

  describe('buildEntityIndex', () => {
    it('indexes entities from wiki folders', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: ['J. Smith', 'Johnny'],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      await createEntityFile('wiki/projects/unity.md', {
        id: '2',
        type: 'project',
        title: 'Unity',
        canonical_name: 'Unity',
        project_key: 'unity',
        project_status: 'active',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);

      expect(index.bySlug.get('john-smith')).toBe('wiki/entities/john-smith.md');
      expect(index.bySlug.get('unity')).toBe('wiki/projects/unity.md');
      expect(index.byCanonicalName.get('john smith')).toBe('wiki/entities/john-smith.md');
      expect(index.byAlias.get('j. smith')).toBe('wiki/entities/john-smith.md');
      expect(index.byAlias.get('johnny')).toBe('wiki/entities/john-smith.md');
      expect(index.allEntries).toHaveLength(2);
    });

    it('handles empty folders gracefully', async () => {
      const index = await buildEntityIndex(vault);
      expect(index.allEntries).toHaveLength(0);
    });
  });

  describe('resolveEntity', () => {
    it('matches by exact slug', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      const result = resolveEntity({ name: 'John Smith', kind: 'person' }, index);

      expect(result.status).toBe('matched');
      expect(result.matchedPath).toBe('wiki/entities/john-smith.md');
      expect(result.confidence).toBe(1.0);
    });

    it('matches by canonical name', async () => {
      await createEntityFile('wiki/entities/jsmith.md', {
        id: '1',
        type: 'entity',
        title: 'J. Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      const result = resolveEntity({ name: 'John Smith', kind: 'person' }, index);

      expect(result.status).toBe('matched');
      expect(result.matchedPath).toBe('wiki/entities/jsmith.md');
      // Slug match on canonical_name fires first (slugify('John Smith') = 'john-smith' = slug in index)
      expect(result.confidence).toBe(1.0);
    });

    it('matches by alias', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: ['Johnny', 'J. Smith'],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      const result = resolveEntity({ name: 'Johnny', kind: 'person' }, index);

      expect(result.status).toBe('matched');
      expect(result.matchedPath).toBe('wiki/entities/john-smith.md');
      expect(result.confidence).toBe(0.9);
    });

    it('matches word-order-independently (Smith, John -> John Smith)', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      const result = resolveEntity({ name: 'Smith, John', kind: 'person' }, index);

      expect(result.status).toBe('matched');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('matches with fuzzy (Levenshtein) distance', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      // "John Smth" is Levenshtein distance 1 from "John Smith"
      const result = resolveEntity({ name: 'John Smth', kind: 'person' }, index);

      expect(result.status).toBe('matched');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('returns new for unmatched entities', async () => {
      const index = await buildEntityIndex(vault);
      const result = resolveEntity({ name: 'Jane Doe', kind: 'person' }, index);

      expect(result.status).toBe('new');
      expect(result.suggestedPath).toBe('wiki/entities/jane-doe.md');
      expect(result.confidence).toBe(0);
    });

    it('returns ambiguous when multiple fuzzy matches exist', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      await createEntityFile('wiki/entities/john-smyth.md', {
        id: '2',
        type: 'entity',
        title: 'John Smyth',
        canonical_name: 'John Smyth',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      // "John Smih" is distance 2 from "John Smith" and distance 2 from "John Smyth"
      const result = resolveEntity({ name: 'John Smih', kind: 'person' }, index);

      expect(result.status).toBe('ambiguous');
      expect(result.candidates).toBeDefined();
      expect(result.candidates!.length).toBeGreaterThanOrEqual(2);
    });

    it('resolves projects in the correct folder', async () => {
      await createEntityFile('wiki/projects/unity.md', {
        id: '1',
        type: 'project',
        title: 'Unity',
        canonical_name: 'Unity',
        project_key: 'unity',
        project_status: 'active',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      const result = resolveEntity({ name: 'Unity', kind: 'project' }, index);

      expect(result.status).toBe('matched');
      expect(result.matchedPath).toBe('wiki/projects/unity.md');
    });
  });

  describe('resolveEntities', () => {
    it('resolves multiple entities', async () => {
      await createEntityFile('wiki/entities/john-smith.md', {
        id: '1',
        type: 'entity',
        title: 'John Smith',
        canonical_name: 'John Smith',
        entity_kind: 'person',
        aliases: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });

      const index = await buildEntityIndex(vault);
      const results = resolveEntities(
        [
          { name: 'John Smith', kind: 'person' as EntityKind },
          { name: 'Jane Doe', kind: 'person' as EntityKind },
          { name: 'Project X', kind: 'project' as EntityKind },
        ],
        index,
      );

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('matched');
      expect(results[1].status).toBe('new');
      expect(results[2].status).toBe('new');
    });
  });
});

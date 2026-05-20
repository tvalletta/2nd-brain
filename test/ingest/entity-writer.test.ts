import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { getProtectedRegion } from '../../src/vault/protected-regions.js';
import {
  createEntityPage,
  mergeEntityPage,
  formatMention,
  type ExtractedEntityInfo,
} from '../../src/ingest/entity-writer.js';
import type { EntityResolution } from '../../src/ingest/entity-resolver.js';

describe('entity-writer', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-writer-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/entities');
    await vault.ensureFolder('wiki/projects');
    await vault.ensureFolder('wiki/concepts');
    await vault.ensureFolder('wiki/decisions');
    await vault.ensureFolder('outputs/source-summaries');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('formatMention', () => {
    it('formats a mention with context and chunk refs', () => {
      const result = formatMention('outputs/source-summaries/meeting.md', 'Led the team', ['c1', 'c2']);
      expect(result).toBe('- [[meeting]] (chunks: c1, c2): "Led the team"');
    });

    it('formats without chunk refs', () => {
      const result = formatMention('outputs/source-summaries/meeting.md', 'Led the team', []);
      expect(result).toBe('- [[meeting]]: "Led the team"');
    });

    it('formats without context', () => {
      const result = formatMention('outputs/source-summaries/meeting.md', '', ['c1']);
      expect(result).toBe('- [[meeting]] (chunks: c1)');
    });

    it('truncates long context', () => {
      const longContext = 'x'.repeat(300);
      const result = formatMention('outputs/source-summaries/meeting.md', longContext, []);
      expect(result.length).toBeLessThan(300);
      expect(result).toContain('...');
    });
  });

  describe('createEntityPage', () => {
    it('creates a person page', async () => {
      const info: ExtractedEntityInfo = {
        name: 'Alice Johnson',
        kind: 'person',
        role: 'Engineering Lead',
        context: 'Works on the backend team',
        chunkRefs: ['c1'],
      };
      const resolution: EntityResolution = {
        entityName: 'Alice Johnson',
        entityKind: 'person',
        status: 'new',
        suggestedPath: 'wiki/entities/alice-johnson.md',
        confidence: 0,
      };

      const path = await createEntityPage(vault, resolution, info, 'outputs/source-summaries/meeting.md');

      expect(path).toBe('wiki/entities/alice-johnson.md');
      const content = await vault.read(path);
      const { data, body } = parseNote(content);

      expect(data.type).toBe('entity');
      expect(data.entity_kind).toBe('person');
      expect(data.canonical_name).toBe('Alice Johnson');
      expect(data.title).toBe('Alice Johnson');
      expect(data.source_refs).toContain('outputs/source-summaries/meeting.md');

      // Summary should contain role/context
      const summary = getProtectedRegion(body, 'summary');
      expect(summary).toContain('Engineering Lead');
      expect(summary).toContain('Works on the backend team');

      // Timeline should cite source (person entities use 'timeline' region)
      const timeline = getProtectedRegion(body, 'timeline');
      expect(timeline).toContain('[[meeting]]');
    });

    it('creates a project hub', async () => {
      const info: ExtractedEntityInfo = {
        name: 'Phoenix',
        kind: 'project',
        status: 'active',
        context: 'Migration to new platform',
        chunkRefs: [],
      };
      const resolution: EntityResolution = {
        entityName: 'Phoenix',
        entityKind: 'project',
        status: 'new',
        suggestedPath: 'wiki/projects/phoenix.md',
        confidence: 0,
      };

      const path = await createEntityPage(vault, resolution, info, 'outputs/source-summaries/meeting.md');

      // Should create a hub _index.md, not a flat file
      expect(path).toBe('wiki/projects/phoenix/_index.md');

      const content = await vault.read(path);
      const { data, body } = parseNote(content);

      expect(data.type).toBe('project');
      expect(data.project_key).toBe('phoenix');
      expect(data.project_status).toBe('active');
      expect(data.source_refs).toContain('outputs/source-summaries/meeting.md');

      // Hub has overview and specs regions
      const overview = getProtectedRegion(body, 'overview');
      expect(overview).toBeTruthy();
      const specs = getProtectedRegion(body, 'specs');
      expect(specs).not.toBeNull();
    });

    it('creates a concept page', async () => {
      const info: ExtractedEntityInfo = {
        name: 'Microservices',
        kind: 'concept',
        definition: 'Distributed architecture pattern',
        chunkRefs: ['c3'],
      };
      const resolution: EntityResolution = {
        entityName: 'Microservices',
        entityKind: 'concept',
        status: 'new',
        suggestedPath: 'wiki/concepts/microservices.md',
        confidence: 0,
      };

      const path = await createEntityPage(vault, resolution, info, 'outputs/source-summaries/doc.md');

      const content = await vault.read(path);
      const { data, body } = parseNote(content);

      expect(data.type).toBe('concept');
      const def = getProtectedRegion(body, 'definition');
      expect(def).toContain('Distributed architecture pattern');
    });

    it('handles path collision', async () => {
      // Create an existing file at the suggested path
      await vault.create('wiki/entities/alice.md', 'existing');

      const info: ExtractedEntityInfo = {
        name: 'Alice',
        kind: 'person',
        chunkRefs: [],
      };
      const resolution: EntityResolution = {
        entityName: 'Alice',
        entityKind: 'person',
        status: 'new',
        suggestedPath: 'wiki/entities/alice.md',
        confidence: 0,
      };

      const path = await createEntityPage(vault, resolution, info, 'outputs/source-summaries/meeting.md');

      // Should use a collision-avoiding path
      expect(path).not.toBe('wiki/entities/alice.md');
      expect(path).toContain('wiki/entities/alice');
    });
  });

  describe('mergeEntityPage', () => {
    async function createTestEntityPage(): Promise<string> {
      const info: ExtractedEntityInfo = {
        name: 'Alice',
        kind: 'person',
        role: 'Engineer',
        context: 'Backend developer',
        chunkRefs: ['c1'],
      };
      const resolution: EntityResolution = {
        entityName: 'Alice',
        entityKind: 'person',
        status: 'new',
        suggestedPath: 'wiki/entities/alice.md',
        confidence: 0,
      };
      return createEntityPage(vault, resolution, info, 'outputs/source-summaries/first.md');
    }

    it('adds new source reference and mention', async () => {
      const path = await createTestEntityPage();

      const newInfo: ExtractedEntityInfo = {
        name: 'Alice',
        kind: 'person',
        context: 'Promoted to team lead',
        chunkRefs: ['c5'],
      };

      const result = await mergeEntityPage(vault, path, newInfo, 'outputs/source-summaries/second.md');

      expect(result.changed).toBe(true);
      expect(result.fieldsUpdated).toContain('source_refs');
      expect(result.fieldsUpdated).toContain('timeline');

      const content = await vault.read(path);
      const { data, body } = parseNote(content);

      expect(data.source_refs).toContain('outputs/source-summaries/first.md');
      expect(data.source_refs).toContain('outputs/source-summaries/second.md');

      const timeline = getProtectedRegion(body, 'timeline');
      expect(timeline).toContain('[[first]]');
      expect(timeline).toContain('[[second]]');
    });

    it('is idempotent — skips duplicate source', async () => {
      const path = await createTestEntityPage();

      const newInfo: ExtractedEntityInfo = {
        name: 'Alice',
        kind: 'person',
        context: 'Backend developer',
        chunkRefs: ['c1'],
      };

      // Same source as creation
      const result = await mergeEntityPage(vault, path, newInfo, 'outputs/source-summaries/first.md');

      expect(result.changed).toBe(false);
      expect(result.fieldsUpdated).toHaveLength(0);
    });

    it('adds alias for new name variant', async () => {
      const path = await createTestEntityPage();

      const newInfo: ExtractedEntityInfo = {
        name: 'Alice Johnson',
        kind: 'person',
        context: 'Full name mentioned in interview',
        chunkRefs: [],
      };

      const result = await mergeEntityPage(vault, path, newInfo, 'outputs/source-summaries/interview.md');

      expect(result.fieldsUpdated).toContain('aliases');

      const content = await vault.read(path);
      const { data } = parseNote(content);
      expect(data.aliases).toContain('Alice Johnson');
    });

    it('appends to summary with citation', async () => {
      const path = await createTestEntityPage();

      const newInfo: ExtractedEntityInfo = {
        name: 'Alice',
        kind: 'person',
        context: 'Now managing three direct reports',
        chunkRefs: [],
      };

      const result = await mergeEntityPage(vault, path, newInfo, 'outputs/source-summaries/update.md');

      expect(result.fieldsUpdated).toContain('summary');

      const content = await vault.read(path);
      const { body } = parseNote(content);
      const summary = getProtectedRegion(body, 'summary');
      expect(summary).toContain('Per [[update]]');
      expect(summary).toContain('Now managing three direct reports');
    });
  });
});

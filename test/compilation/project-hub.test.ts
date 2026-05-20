import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { getProtectedRegion } from '../../src/vault/protected-regions.js';
import {
  getOrCreateProjectHub,
  listProjectSpecs,
  createProjectSpec,
  updateProjectSpec,
  isProjectHub,
} from '../../src/compilation/project-hub.js';

describe('project-hub', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-hub-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/projects');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getOrCreateProjectHub', () => {
    it('creates a new hub with _index.md', async () => {
      const hub = await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');

      expect(hub.created).toBe(true);
      expect(hub.indexPath).toBe('wiki/projects/auth-redesign/_index.md');
      expect(hub.specPaths).toHaveLength(0);
      expect(hub.projectSlug).toBe('auth-redesign');

      const content = await vault.read(hub.indexPath);
      const { data, body } = parseNote(content);

      expect(data.type).toBe('project');
      expect(data.project_key).toBe('auth-redesign');
      expect(data.title).toBe('Auth Redesign');
      expect(data.project_status).toBe('active');
      expect(data.protected_regions).toContain('overview');
      expect(data.protected_regions).toContain('specs');

      const overview = getProtectedRegion(body, 'overview');
      expect(overview).toContain('Pending enrichment.');
    });

    it('returns existing hub without recreating', async () => {
      const first = await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      expect(first.created).toBe(true);

      const second = await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      expect(second.created).toBe(false);
      expect(second.indexPath).toBe(first.indexPath);
    });

    it('stores source_refs from sourcePath', async () => {
      const hub = await getOrCreateProjectHub(
        vault,
        'phoenix',
        'Phoenix',
        'outputs/source-summaries/meeting.md',
      );

      const content = await vault.read(hub.indexPath);
      const { data } = parseNote(content);
      expect(data.source_refs).toContain('outputs/source-summaries/meeting.md');
    });

    it('detects legacy single-page project without migrating', async () => {
      // Create a legacy single-page project
      await vault.atomicWrite(
        'wiki/projects/old-project.md',
        '---\ntype: project\ntitle: Old Project\n---\n# Old Project\n',
      );

      const hub = await getOrCreateProjectHub(vault, 'old-project', 'Old Project');

      expect(hub.created).toBe(false);
      expect(hub.indexPath).toBe('wiki/projects/old-project.md');
      expect(hub.specPaths).toHaveLength(0);
    });
  });

  describe('createProjectSpec', () => {
    it('creates a sub-spec page', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');

      const specPath = await createProjectSpec(
        vault,
        'auth-redesign',
        'technical',
        'Auth Redesign - Technical',
        'Uses OAuth 2.0 with PKCE flow.',
        'outputs/source-summaries/session-001.md',
      );

      expect(specPath).toBe('wiki/projects/auth-redesign/technical.md');

      const content = await vault.read(specPath);
      const { data, body } = parseNote(content);

      expect(data.type).toBe('project_spec');
      expect(data.project_key).toBe('auth-redesign');
      expect(data.spec_type).toBe('technical');
      expect(data.reinforcement_count).toBe(1);
      expect(data.conversations_since_update).toBe(0);
      expect(data.stale_threshold).toBe(10);
      expect(data.source_refs).toContain('outputs/source-summaries/session-001.md');

      const specContent = getProtectedRegion(body, 'content');
      expect(specContent).toContain('OAuth 2.0 with PKCE flow');
    });

    it('updates hub specs list when creating a spec', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      await createProjectSpec(vault, 'auth-redesign', 'technical', 'Technical Spec', 'Stack info');

      const indexContent = await vault.read('wiki/projects/auth-redesign/_index.md');
      const { body } = parseNote(indexContent);
      const specsRegion = getProtectedRegion(body, 'specs');

      expect(specsRegion).toContain('[[technical]]');
      expect(specsRegion).toContain('Technical Spec');
    });
  });

  describe('listProjectSpecs', () => {
    it('returns empty for hub with no specs', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      const specs = await listProjectSpecs(vault, 'auth-redesign');
      expect(specs).toHaveLength(0);
    });

    it('returns all sub-specs', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      await createProjectSpec(vault, 'auth-redesign', 'technical', 'Technical', 'Stack');
      await createProjectSpec(vault, 'auth-redesign', 'product', 'Product', 'Features');

      const specs = await listProjectSpecs(vault, 'auth-redesign');
      expect(specs).toHaveLength(2);

      const types = specs.map((s) => s.specType).sort();
      expect(types).toEqual(['product', 'technical']);
    });
  });

  describe('updateProjectSpec', () => {
    it('updates content and reinforcement tracking', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      const specPath = await createProjectSpec(
        vault,
        'auth-redesign',
        'technical',
        'Technical',
        'Initial content',
      );

      await updateProjectSpec(vault, specPath, 'Updated architecture details.');

      const content = await vault.read(specPath);
      const { data, body } = parseNote(content);

      const specContent = getProtectedRegion(body, 'content');
      expect(specContent).toContain('Updated architecture details.');

      expect(data.reinforcement_count).toBe(2); // 1 from create + 1 from update
      expect(data.conversations_since_update).toBe(0);
    });

    it('skips reinforcement when reinforced=false', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      const specPath = await createProjectSpec(
        vault,
        'auth-redesign',
        'technical',
        'Technical',
        'Initial content',
      );

      await updateProjectSpec(vault, specPath, 'Minor tweak.', false);

      const content = await vault.read(specPath);
      const { data } = parseNote(content);

      expect(data.reinforcement_count).toBe(1); // Only from create
    });

    it('adds new source_ref on update', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      const specPath = await createProjectSpec(
        vault,
        'auth-redesign',
        'technical',
        'Technical',
        'Initial',
        'outputs/source-summaries/s1.md',
      );

      await updateProjectSpec(
        vault,
        specPath,
        'More details.',
        true,
        'outputs/source-summaries/s2.md',
      );

      const content = await vault.read(specPath);
      const { data } = parseNote(content);
      expect(data.source_refs).toContain('outputs/source-summaries/s1.md');
      expect(data.source_refs).toContain('outputs/source-summaries/s2.md');
    });
  });

  describe('isProjectHub', () => {
    it('returns true for hub directories', async () => {
      await getOrCreateProjectHub(vault, 'auth-redesign', 'Auth Redesign');
      expect(await isProjectHub(vault, 'auth-redesign')).toBe(true);
    });

    it('returns false for non-existent projects', async () => {
      expect(await isProjectHub(vault, 'nonexistent')).toBe(false);
    });

    it('returns false for legacy single-page projects', async () => {
      await vault.atomicWrite(
        'wiki/projects/old-project.md',
        '---\ntype: project\ntitle: Old Project\n---\n# Old Project\n',
      );
      expect(await isProjectHub(vault, 'old-project')).toBe(false);
    });
  });
});

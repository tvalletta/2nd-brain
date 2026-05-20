import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote, serializeNote } from '../../src/vault/frontmatter.js';
import { getProtectedRegion } from '../../src/vault/protected-regions.js';
import { migrateProjectsToHubs } from '../../src/migration/migrate-project-hubs.js';

describe('migrate-project-hubs', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-migrate-hubs-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/projects');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeLegacyProject(slug: string, title: string): string {
    const data: Record<string, unknown> = {
      id: `test-${slug}`,
      type: 'project',
      title,
      project_key: slug,
      project_status: 'active',
      status: 'active',
      confidence: 'medium',
      review_state: 'unreviewed',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      source_refs: ['outputs/source-summaries/s1.md'],
      derived_from: [],
      aliases: [],
      links: [],
      change_origin: 'extraction',
      protected_regions: ['overview', 'people', 'decisions', 'concepts', 'sessions', 'sources', 'backlinks'],
    };

    const body = `
# ${title}

## Overview
%% begin:overview %%
A cool project.
%% end:overview %%

## Key People
%% begin:people %%
- [[alice]]
%% end:people %%

## Decisions
%% begin:decisions %%
%% end:decisions %%

## Related Concepts
%% begin:concepts %%
%% end:concepts %%

## Sessions
%% begin:sessions %%
%% end:sessions %%

## Source References
%% begin:sources %%
%% end:sources %%

## Backlinks
%% begin:backlinks %%
%% end:backlinks %%
`;

    return serializeNote(data, body);
  }

  it('migrates a legacy project to hub model', async () => {
    await vault.atomicWrite('wiki/projects/phoenix.md', makeLegacyProject('phoenix', 'Phoenix'));

    const result = await migrateProjectsToHubs(vault);

    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0]).toContain('phoenix');
    expect(result.errors).toHaveLength(0);

    // Legacy file should be deleted
    expect(await vault.exists('wiki/projects/phoenix.md')).toBe(false);

    // Hub _index.md should exist
    expect(await vault.exists('wiki/projects/phoenix/_index.md')).toBe(true);

    const content = await vault.read('wiki/projects/phoenix/_index.md');
    const { data, body } = parseNote(content);

    expect(data.type).toBe('project');
    expect(data.project_key).toBe('phoenix');

    // Content should be preserved
    const overview = getProtectedRegion(body, 'overview');
    expect(overview).toContain('A cool project.');

    const people = getProtectedRegion(body, 'people');
    expect(people).toContain('[[alice]]');

    // Specs region should be injected
    const specs = getProtectedRegion(body, 'specs');
    expect(specs).not.toBeNull();

    // Protected regions should include hub regions
    expect(data.protected_regions).toContain('specs');
    expect(data.protected_regions).toContain('overview');
  });

  it('migrates multiple projects', async () => {
    await vault.atomicWrite('wiki/projects/phoenix.md', makeLegacyProject('phoenix', 'Phoenix'));
    await vault.atomicWrite('wiki/projects/atlas.md', makeLegacyProject('atlas', 'Atlas'));

    const result = await migrateProjectsToHubs(vault);

    expect(result.migrated).toHaveLength(2);
    expect(await vault.exists('wiki/projects/phoenix/_index.md')).toBe(true);
    expect(await vault.exists('wiki/projects/atlas/_index.md')).toBe(true);
  });

  it('skips existing hubs', async () => {
    // Create both a legacy page and a hub — hub should take precedence
    await vault.ensureFolder('wiki/projects/phoenix');
    await vault.atomicWrite(
      'wiki/projects/phoenix/_index.md',
      '---\ntype: project\ntitle: Phoenix\n---\n# Phoenix\n',
    );

    // No legacy .md file to migrate, so nothing happens
    const result = await migrateProjectsToHubs(vault);
    expect(result.migrated).toHaveLength(0);
  });

  it('does not touch files inside subdirectories', async () => {
    // Create a hub with a sub-spec — the sub-spec should NOT be treated as a legacy page
    await vault.ensureFolder('wiki/projects/phoenix');
    await vault.atomicWrite(
      'wiki/projects/phoenix/_index.md',
      '---\ntype: project\ntitle: Phoenix\n---\n# Phoenix\n',
    );
    await vault.atomicWrite(
      'wiki/projects/phoenix/technical.md',
      '---\ntype: project_spec\ntitle: Technical\n---\n# Technical\n',
    );

    const result = await migrateProjectsToHubs(vault);

    expect(result.migrated).toHaveLength(0);
    // Sub-spec should still exist
    expect(await vault.exists('wiki/projects/phoenix/technical.md')).toBe(true);
  });

  it('returns empty result when no wiki/projects exists', async () => {
    // Remove the projects dir
    const emptyTempDir = await mkdtemp(join(tmpdir(), 'karpathy-empty-'));
    const emptyVault = createFsAdapter(emptyTempDir);

    const result = await migrateProjectsToHubs(emptyVault);
    expect(result.migrated).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    await rm(emptyTempDir, { recursive: true, force: true });
  });

  it('does not migrate _index.md files', async () => {
    // The wiki/projects/_index.md is the category index, not a project
    await vault.atomicWrite(
      'wiki/projects/_index.md',
      '---\ntype: index\ntitle: Projects Index\n---\n# Projects\n',
    );

    const result = await migrateProjectsToHubs(vault);
    expect(result.migrated).toHaveLength(0);

    // _index.md should still be there
    expect(await vault.exists('wiki/projects/_index.md')).toBe(true);
  });
});

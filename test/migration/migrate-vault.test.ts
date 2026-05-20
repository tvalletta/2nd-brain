import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { migrateVault, inferCanonicalName } from '../../src/migration/migrate-vault.js';
import { parseNote } from '../../src/vault/frontmatter.js';

describe('inferCanonicalName', () => {
  it('strips .md extension', () => {
    expect(inferCanonicalName('Ben Robbins.md')).toBe('Ben Robbins');
  });

  it('strips " - About" suffix', () => {
    expect(inferCanonicalName('Craig Mathis - About.md')).toBe('Craig Mathis');
  });

  it('strips " - Notes" suffix', () => {
    expect(inferCanonicalName('Arevik Katunyan - Notes.md')).toBe('Arevik Katunyan');
  });

  it('handles "Last, First Extra" pattern', () => {
    expect(inferCanonicalName('Kubicki, Irek 2025 Q3 Check-in.md')).toBe('Irek Kubicki');
  });

  it('handles simple names', () => {
    expect(inferCanonicalName('Amplify.md')).toBe('Amplify');
  });

  it('handles names with multiple words', () => {
    expect(inferCanonicalName('AI Agent Memory.md')).toBe('AI Agent Memory');
  });

  it('does not flip commas in dates or non-name patterns', () => {
    expect(inferCanonicalName('Project Unity Working Session - Jan 8, 2026.md'))
      .toBe('Project Unity Working Session - Jan 8, 2026');
  });
});

describe('migrateVault', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-migrate-'));
    vault = createFsAdapter(tempDir);

    // Set up vault structure
    await vault.ensureFolder('outputs/source-summaries');
    await vault.ensureFolder('wiki/entities');
    await vault.ensureFolder('wiki/projects');
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('deletes all source-summaries', async () => {
    // Create some stub source-summaries
    await vault.create('outputs/source-summaries/test-1.md', '---\nid: x\n---\nstub');
    await vault.create('outputs/source-summaries/test-2.md', '---\nid: y\n---\nstub');

    const result = await migrateVault(vault);

    expect(result.sourceSummariesDeleted).toBe(2);
    expect(await vault.exists('outputs/source-summaries/test-1.md')).toBe(false);
    expect(await vault.exists('outputs/source-summaries/test-2.md')).toBe(false);
  });

  it('backfills entity frontmatter on pages without it', async () => {
    await vault.create(
      'wiki/entities/Ben Robbins.md',
      '# Ben Robbins\n\nSome notes about Ben.',
    );

    const result = await migrateVault(vault);

    expect(result.entitiesBackfilled).toBe(1);

    const content = await readFile(join(tempDir, 'wiki/entities/Ben Robbins.md'), 'utf-8');
    const { data, body } = parseNote(content);
    expect(data.type).toBe('entity');
    expect(data.entity_kind).toBe('person');
    expect(data.canonical_name).toBe('Ben Robbins');
    expect(data.curation_policy).toBe('curated');
    expect(data.status).toBe('active');
    expect(body).toContain('# Ben Robbins');
    expect(body).toContain('Some notes about Ben.');
  });

  it('handles " - About" suffix in entity names', async () => {
    await vault.create(
      'wiki/entities/Craig Mathis - About.md',
      '# Craig Mathis\n\nAbout Craig.',
    );

    const result = await migrateVault(vault);

    expect(result.entitiesBackfilled).toBe(1);

    const content = await readFile(join(tempDir, 'wiki/entities/Craig Mathis - About.md'), 'utf-8');
    const { data } = parseNote(content);
    expect(data.canonical_name).toBe('Craig Mathis');
    expect(data.aliases).toContain('Craig Mathis - About');
  });

  it('backfills project frontmatter', async () => {
    await vault.create('wiki/projects/Amplify.md', '# Amplify\n\nProject notes.');

    const result = await migrateVault(vault);

    expect(result.projectsBackfilled).toBe(1);

    const content = await readFile(join(tempDir, 'wiki/projects/Amplify.md'), 'utf-8');
    const { data, body } = parseNote(content);
    expect(data.type).toBe('project');
    expect(data.project_key).toBe('amplify');
    expect(data.curation_policy).toBe('curated');
    expect(body).toContain('# Amplify');
  });

  it('backfills concept frontmatter', async () => {
    await vault.create(
      'wiki/concepts/Promotion Packet.md',
      '# TECHNICAL\n\nSome content.',
    );

    const result = await migrateVault(vault);

    expect(result.conceptsBackfilled).toBe(1);

    const content = await readFile(join(tempDir, 'wiki/concepts/Promotion Packet.md'), 'utf-8');
    const { data } = parseNote(content);
    expect(data.type).toBe('concept');
    expect(data.title).toBe('Promotion Packet');
    expect(data.curation_policy).toBe('curated');
  });

  it('skips pages that already have frontmatter', async () => {
    const existing = '---\nid: existing-id\ntype: entity\ntitle: Test\n---\n\n# Test';
    await vault.create('wiki/entities/Test.md', existing);

    const result = await migrateVault(vault);

    expect(result.entitiesBackfilled).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain('already has frontmatter');
  });

  it('skips non-entity pages like My Team', async () => {
    await vault.create(
      'wiki/entities/My Team.md',
      '- [[Craig Mathis]]\n- [[Ben Robbins]]\n',
    );

    const result = await migrateVault(vault);

    expect(result.entitiesBackfilled).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain('non-entity page');
  });

  it('handles empty folders gracefully', async () => {
    const result = await migrateVault(vault);

    expect(result.sourceSummariesDeleted).toBe(0);
    expect(result.entitiesBackfilled).toBe(0);
    expect(result.projectsBackfilled).toBe(0);
    expect(result.conceptsBackfilled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('preserves original content when adding frontmatter', async () => {
    const originalContent = `# Check-in
- Craig is a software architect
- Craig has been at Adobe for 15 years

## Accomplishments
- Led the initial POC implementation
`;
    await vault.create('wiki/entities/Craig Mathis.md', originalContent);

    await migrateVault(vault);

    const content = await readFile(join(tempDir, 'wiki/entities/Craig Mathis.md'), 'utf-8');
    const { body } = parseNote(content);
    expect(body).toContain('# Check-in');
    expect(body).toContain('Craig is a software architect');
    expect(body).toContain('## Accomplishments');
    expect(body).toContain('Led the initial POC implementation');
  });
});

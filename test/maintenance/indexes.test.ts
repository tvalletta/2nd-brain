import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { rebuildWikiIndex, rebuildAllIndexes, rebuildCategoryIndex } from '../../src/maintenance/indexes.js';

function makeNote(fields: Record<string, string | string[]>, body = ''): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  if (body) lines.push('', body);
  return lines.join('\n') + '\n';
}

describe('rebuildWikiIndex (backward compat)', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-idx-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/entities');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates index page listing all wiki pages', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      '---\ntitle: Alice\ntype: entity\nstatus: active\n---\n# Alice\n',
    );
    await vault.create(
      'wiki/entities/bob.md',
      '---\ntitle: Bob\ntype: entity\nstatus: draft\n---\n# Bob\n',
    );

    const count = await rebuildWikiIndex(vault);
    expect(count).toBe(2);

    const index = await vault.read('wiki/_index.md');
    expect(index).toContain('[[alice]]');
    expect(index).toContain('[[bob]]');
    // Master index groups by category heading, not by note type
    expect(index).toContain('## People');
  });

  it('handles empty wiki gracefully', async () => {
    const count = await rebuildWikiIndex(vault);
    expect(count).toBe(0);

    const index = await vault.read('wiki/_index.md');
    expect(index).toContain('No pages yet.');
  });

  it('is idempotent', async () => {
    await vault.create(
      'wiki/entities/test.md',
      '---\ntitle: Test\ntype: entity\nstatus: active\n---\n# Test\n',
    );

    await rebuildWikiIndex(vault);
    const content1 = await vault.read('wiki/_index.md');

    await rebuildWikiIndex(vault);
    const content2 = await vault.read('wiki/_index.md');

    expect(content1).toBe(content2);
  });
});

describe('multi-category indexes', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-midx-'));
    vault = createFsAdapter(tempDir);
    for (const folder of [
      'wiki/entities',
      'wiki/projects',
      'wiki/concepts',
      'wiki/topics',
      'wiki/decisions',
      'wiki/tools',
      'wiki/organizations',
      'outputs/source-summaries',
    ]) {
      await vault.ensureFolder(folder);
    }
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds master index organized by category', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      makeNote({ title: 'Alice Chen', type: 'entity', status: 'active', entity_kind: 'person', canonical_name: 'Alice Chen' }),
    );
    await vault.create(
      'wiki/projects/auth-redesign.md',
      makeNote({ title: 'Auth Redesign', type: 'project', status: 'active', project_key: 'auth', project_status: 'active' }),
    );
    await vault.create(
      'wiki/concepts/zero-trust.md',
      makeNote({ title: 'Zero Trust', type: 'concept', status: 'active' }),
    );

    const count = await rebuildAllIndexes(vault);
    expect(count).toBe(3);

    const master = await vault.read('wiki/_index.md');
    expect(master).toContain('## People');
    expect(master).toContain('[[alice]]');
    expect(master).toContain('## Projects');
    expect(master).toContain('[[auth-redesign]]');
    expect(master).toContain('## Concepts');
    expect(master).toContain('[[zero-trust]]');
  });

  it('builds entity category index with project links', async () => {
    const body = [
      '# Alice Chen',
      '',
      '## Projects',
      '%% begin:projects %%',
      '- [[auth-redesign]] — Auth system overhaul',
      '%% end:projects %%',
    ].join('\n');

    await vault.create(
      'wiki/entities/alice.md',
      makeNote(
        { title: 'Alice Chen', type: 'entity', status: 'active', entity_kind: 'person', canonical_name: 'Alice Chen' },
        body,
      ),
    );

    await rebuildCategoryIndex(vault, 'wiki/entities');

    const idx = await vault.read('wiki/entities/_index.md');
    expect(idx).toContain('[[alice]]');
    expect(idx).toContain('Alice Chen');
    expect(idx).toContain('[[auth-redesign]]');
  });

  it('builds project category index grouped by status', async () => {
    await vault.create(
      'wiki/projects/alpha.md',
      makeNote({ title: 'Alpha', type: 'project', status: 'active', project_key: 'alpha', project_status: 'active' }),
    );
    await vault.create(
      'wiki/projects/beta.md',
      makeNote({ title: 'Beta', type: 'project', status: 'active', project_key: 'beta', project_status: 'completed' }),
    );
    await vault.create(
      'wiki/projects/gamma.md',
      makeNote({ title: 'Gamma', type: 'project', status: 'archived', project_key: 'gamma', project_status: 'archived' }),
    );

    await rebuildCategoryIndex(vault, 'wiki/projects');

    const idx = await vault.read('wiki/projects/_index.md');
    expect(idx).toContain('## Active');
    expect(idx).toContain('## Completed');
    expect(idx).toContain('## Archived');
    expect(idx).toContain('[[alpha]]');
    expect(idx).toContain('[[beta]]');
    expect(idx).toContain('[[gamma]]');
  });

  it('builds project index with people links from protected regions', async () => {
    const body = [
      '# Auth Redesign',
      '',
      '## Key People',
      '%% begin:people %%',
      '- [[alice-chen]] — Senior Engineer',
      '- [[bob-martinez]] — Product Manager',
      '%% end:people %%',
    ].join('\n');

    await vault.create(
      'wiki/projects/auth-redesign.md',
      makeNote(
        { title: 'Auth Redesign', type: 'project', status: 'active', project_key: 'auth', project_status: 'active' },
        body,
      ),
    );

    await rebuildCategoryIndex(vault, 'wiki/projects');

    const idx = await vault.read('wiki/projects/_index.md');
    expect(idx).toContain('People: [[alice-chen]], [[bob-martinez]]');
  });

  it('builds decisions index sorted by date descending', async () => {
    await vault.create(
      'wiki/decisions/early.md',
      makeNote({ title: 'Early Decision', type: 'decision', status: 'active', decision_status: 'accepted', decision_date: '2024-01-15' }),
    );
    await vault.create(
      'wiki/decisions/late.md',
      makeNote({ title: 'Late Decision', type: 'decision', status: 'active', decision_status: 'proposed', decision_date: '2024-06-20' }),
    );

    await rebuildCategoryIndex(vault, 'wiki/decisions');

    const idx = await vault.read('wiki/decisions/_index.md');
    // Late should come before Early since sorted descending by date
    const latePos = idx.indexOf('[[late]]');
    const earlyPos = idx.indexOf('[[early]]');
    expect(latePos).toBeLessThan(earlyPos);
    expect(idx).toContain('[accepted]');
    expect(idx).toContain('[proposed]');
    expect(idx).toContain('(2024-06-20)');
  });

  it('builds tools category index with category annotation', async () => {
    await vault.create(
      'wiki/tools/docker.md',
      makeNote({ title: 'Docker', type: 'tool', status: 'active', tool_category: 'containerization' }),
    );

    await rebuildCategoryIndex(vault, 'wiki/tools');

    const idx = await vault.read('wiki/tools/_index.md');
    expect(idx).toContain('[[docker]]');
    expect(idx).toContain('[containerization]');
  });

  it('builds organizations category index', async () => {
    await vault.create(
      'wiki/organizations/acme.md',
      makeNote({ title: 'Acme Corp', type: 'organization', status: 'active', org_type: 'company' }),
    );

    await rebuildCategoryIndex(vault, 'wiki/organizations');

    const idx = await vault.read('wiki/organizations/_index.md');
    expect(idx).toContain('[[acme]]');
    expect(idx).toContain('[company]');
  });

  it('builds source-summaries index sorted by date', async () => {
    await vault.create(
      'outputs/source-summaries/old-doc.md',
      makeNote({
        title: 'Old Document',
        type: 'source_summary',
        status: 'active',
        source_type: 'pdf',
        source_path: '/docs/old.pdf',
        ingest_status: 'linked',
        created_at: '2024-01-01T00:00:00Z',
      }),
    );
    await vault.create(
      'outputs/source-summaries/new-doc.md',
      makeNote({
        title: 'New Document',
        type: 'source_summary',
        status: 'active',
        source_type: 'markdown',
        source_path: '/docs/new.md',
        ingest_status: 'summarized',
        created_at: '2024-06-01T00:00:00Z',
      }),
    );

    await rebuildCategoryIndex(vault, 'outputs/source-summaries');

    const idx = await vault.read('outputs/source-summaries/_index.md');
    expect(idx).toContain('[[new-doc]]');
    expect(idx).toContain('[[old-doc]]');
    expect(idx).toContain('[pdf]');
    expect(idx).toContain('[markdown]');
    // New should be before old
    const newPos = idx.indexOf('[[new-doc]]');
    const oldPos = idx.indexOf('[[old-doc]]');
    expect(newPos).toBeLessThan(oldPos);
  });

  it('returns 0 for unknown folder', async () => {
    const count = await rebuildCategoryIndex(vault, 'wiki/nonexistent');
    expect(count).toBe(0);
  });

  it('rebuildAllIndexes builds master + all category indexes', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      makeNote({ title: 'Alice', type: 'entity', status: 'active', entity_kind: 'person', canonical_name: 'Alice' }),
    );
    await vault.create(
      'wiki/projects/proj.md',
      makeNote({ title: 'Project X', type: 'project', status: 'active', project_key: 'x', project_status: 'active' }),
    );

    const total = await rebuildAllIndexes(vault);
    expect(total).toBe(2);

    // Master index exists with sections
    const master = await vault.read('wiki/_index.md');
    expect(master).toContain('## People');
    expect(master).toContain('## Projects');

    // Category indexes exist
    const entityIdx = await vault.read('wiki/entities/_index.md');
    expect(entityIdx).toContain('[[alice]]');

    const projIdx = await vault.read('wiki/projects/_index.md');
    expect(projIdx).toContain('[[proj]]');
  });

  it('master index omits empty categories', async () => {
    // Only add one entity, no projects, concepts, etc.
    await vault.create(
      'wiki/entities/solo.md',
      makeNote({ title: 'Solo', type: 'entity', status: 'active', entity_kind: 'person', canonical_name: 'Solo' }),
    );

    await rebuildAllIndexes(vault);

    const master = await vault.read('wiki/_index.md');
    expect(master).toContain('## People');
    expect(master).not.toContain('## Projects');
    expect(master).not.toContain('## Concepts');
  });

  it('category indexes are idempotent', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      makeNote({ title: 'Alice', type: 'entity', status: 'active', entity_kind: 'person', canonical_name: 'Alice' }),
    );

    await rebuildCategoryIndex(vault, 'wiki/entities');
    const first = await vault.read('wiki/entities/_index.md');

    await rebuildCategoryIndex(vault, 'wiki/entities');
    const second = await vault.read('wiki/entities/_index.md');

    expect(first).toBe(second);
  });
});

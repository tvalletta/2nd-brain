import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';
import { upsertActionItem } from '../../src/maintenance/action-items.js';

describe('action-items', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-action-items-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a per-project action-items.md and the rollup on first item', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Investigate root cause', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });

    const projectPath = 'wiki/projects/2nd-brain/action-items.md';
    const rollupPath = 'wiki/_system/action-items.md';
    expect(await vault.exists(projectPath)).toBe(true);
    expect(await vault.exists(rollupPath)).toBe(true);

    const projectContent = await vault.read(projectPath);
    expect(projectContent).toContain('- [ ] Investigate root cause');
    expect(projectContent).toContain('[[s1]]');

    const rollupContent = await vault.read(rollupPath);
    expect(rollupContent).toContain('- [ ] Investigate root cause');
    expect(rollupContent).toContain('`project:2nd-brain`');
  });

  it('routes _general and _discovery project slugs to the rollup only', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Some ad-hoc task', sourceRef: 'sources/s2.md', projectSlug: '_general',
    });

    expect(await vault.exists('wiki/projects/_general/action-items.md')).toBe(false);
    const rollupContent = await vault.read('wiki/_system/action-items.md');
    expect(rollupContent).toContain('Some ad-hoc task');
  });

  it('preserves a hand-toggled [x] checkbox across a re-run that adds a new item', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'First task', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });

    // Simulate Tom checking the box in Obsidian.
    const projectPath = 'wiki/projects/2nd-brain/action-items.md';
    const content = await vault.read(projectPath);
    await vault.write(projectPath, content.replace('- [ ] First task', '- [x] First task'));

    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Second task', sourceRef: 'sources/s2.md', projectSlug: '2nd-brain',
    });

    const updated = await vault.read(projectPath);
    expect(updated).toContain('- [x] First task');
    expect(updated).toContain('- [ ] Second task');
  });

  it('is idempotent on the same (task, sourceRef) pair', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Repeat task', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Repeat task', sourceRef: 'sources/s1.md', projectSlug: '2nd-brain',
    });

    const content = await vault.read('wiki/projects/2nd-brain/action-items.md');
    const matches = content.split('\n').filter((l) => l.includes('Repeat task'));
    expect(matches).toHaveLength(1);
  });

  it('round-trips a task containing parentheses in the rollup without corrupting the project slug', async () => {
    await upsertActionItem(vault, DEFAULT_LAYOUT, {
      task: 'Fix (urgent) bug', sourceRef: 'sources/s3.md', projectSlug: '2nd-brain',
    });
    const rollupContent = await vault.read('wiki/_system/action-items.md');
    expect(rollupContent).toContain('Fix (urgent) bug');
    expect(rollupContent).toContain('`project:2nd-brain`');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';
import { upsertConceptMention } from '../../src/maintenance/concept-glossary.js';

describe('concept-glossary', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-glossary-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the glossary file on first mention', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency',
      gloss: 'A benchmark for evaluating audit findings.',
      sourceRef: 'wiki/topics/architectural-best-practices.md',
    });

    const path = 'wiki/concepts/glossary.md';
    expect(await vault.exists(path)).toBe(true);
    const content = await vault.read(path);
    expect(content).toContain('## Efficiency');
    expect(content).toContain('A benchmark for evaluating audit findings.');
    expect(content).toContain('[[architectural-best-practices]]');
  });

  it('appends a second mention of the same concept under the same heading', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'First gloss.', sourceRef: 'wiki/topics/a.md',
    });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'Second gloss.', sourceRef: 'wiki/topics/b.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    const headingCount = (content.match(/^## Efficiency$/gm) ?? []).length;
    expect(headingCount).toBe(1);
    expect(content).toContain('First gloss.');
    expect(content).toContain('Second gloss.');
  });

  it('is idempotent on the same (name, sourceRef) pair', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'First gloss.', sourceRef: 'wiki/topics/a.md',
    });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'First gloss (reworded).', sourceRef: 'wiki/topics/a.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    const mentionLines = content.split('\n').filter((l) => l.includes('[[a]]'));
    expect(mentionLines).toHaveLength(1);
  });

  it('normalizes concept name casing to avoid duplicate headings', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Efficiency', gloss: 'From source A.', sourceRef: 'wiki/topics/a.md',
    });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'efficiency', gloss: 'From source B.', sourceRef: 'wiki/topics/b.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    const headingCount = (content.match(/^## Efficiency$/gim) ?? []).length;
    expect(headingCount).toBe(1);
  });

  it('survives a multi-line gloss across a real reparse cycle without dropping the mention', async () => {
    const multiLineGloss = 'First paragraph of a definition.\n\nSecond paragraph with more detail.';
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Cascading Curation', gloss: multiLineGloss, sourceRef: 'wiki/topics/a.md',
    });
    // Force a real reparse of the file that was just written, by upserting a
    // *different* concept — this exercises parseGlossary against the line
    // the first call rendered, not just that call's raw output. Mirrors the
    // "force a real reparse" pattern in test/maintenance/action-items.test.ts's
    // parentheses regression test.
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'Unrelated Concept', gloss: 'Some other gloss.', sourceRef: 'wiki/topics/b.md',
    });

    const content = await vault.read('wiki/concepts/glossary.md');
    expect(content).toContain('## Cascading Curation');
    // The gloss must have been collapsed to a single line — no embedded
    // newlines that would break the per-line mention regex.
    expect(content).toContain('First paragraph of a definition. Second paragraph with more detail.');
    expect(content).not.toMatch(/First paragraph of a definition\.\n\n/);
    expect(content).toContain('## Unrelated Concept');
    expect(content).toContain('Some other gloss.');
  });
});

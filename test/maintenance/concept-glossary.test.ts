import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';
import { upsertConceptMention, synthesizeConceptEntry } from '../../src/maintenance/concept-glossary.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

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

  function fakeSynthesisLLM(text: string): LLMClient {
    return {
      async complete() { return ''; },
      async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
        return schema.parse({ synthesis: text });
      },
    };
  }

  it('skips a mention with identical gloss text from a different sourceRef (content-aware dedup)', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'RCAs', gloss: 'A structured investigation into the root cause of an incident.', sourceRef: 'wiki/topics/a.md',
    });
    const result = await upsertConceptMention(vault, DEFAULT_LAYOUT, {
      name: 'RCAs', gloss: 'A structured investigation into the root cause of an incident.', sourceRef: 'wiki/topics/b.md',
    });

    expect(result.mentionCount).toBe(1);
    const content = await vault.read('wiki/concepts/glossary.md');
    const mentionLines = content.split('\n').filter((l) => l.startsWith('- "'));
    expect(mentionLines).toHaveLength(1);
  });

  it('crossedSynthesisThreshold fires at the threshold, resets, and fires again a full threshold later', async () => {
    const opts = { synthesisThreshold: 3 };
    const r1 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g1', sourceRef: 'a.md' }, opts);
    expect(r1.crossedSynthesisThreshold).toBe(false);
    const r2 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g2', sourceRef: 'b.md' }, opts);
    expect(r2.crossedSynthesisThreshold).toBe(false);
    const r3 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g3', sourceRef: 'c.md' }, opts);
    expect(r3.crossedSynthesisThreshold).toBe(true);

    await synthesizeConceptEntry(vault, DEFAULT_LAYOUT, 'X', fakeSynthesisLLM('Rollup after 3 mentions.'));

    const r4 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g4', sourceRef: 'd.md' }, opts);
    expect(r4.crossedSynthesisThreshold).toBe(false); // 4 mentions, +1 since synthesis at 3
    const r5 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g5', sourceRef: 'e.md' }, opts);
    expect(r5.crossedSynthesisThreshold).toBe(false); // 5 mentions, +2 since synthesis at 3
    const r6 = await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'X', gloss: 'g6', sourceRef: 'f.md' }, opts);
    expect(r6.crossedSynthesisThreshold).toBe(true); // 6 mentions, +3 since synthesis at 3
  });

  it('synthesizeConceptEntry adds a synthesis line above the mention list without altering mentions', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g2', sourceRef: 'b.md' });

    await synthesizeConceptEntry(vault, DEFAULT_LAYOUT, 'Efficiency', fakeSynthesisLLM('A benchmark used across audits.'));

    const content = await vault.read('wiki/concepts/glossary.md');
    expect(content).toContain('*A benchmark used across audits. (as of 2 mentions)*');
    expect(content).toContain('"g1"');
    expect(content).toContain('"g2"');
  });

  it('parseGlossary round-trips a synthesis line through a real reparse cycle', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    await synthesizeConceptEntry(vault, DEFAULT_LAYOUT, 'Efficiency', fakeSynthesisLLM('A recurring benchmark.'));

    // Force a real reparse by upserting a different concept afterward.
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Unrelated', gloss: 'g2', sourceRef: 'b.md' });

    const content = await vault.read('wiki/concepts/glossary.md');
    expect(content).toContain('*A recurring benchmark. (as of 1 mentions)*');

    // synthesizedAtCount (1) must have round-tripped through the reparse:
    // growing to 2 mentions with threshold 2 is only +1 since synthesis, not +2.
    const result = await upsertConceptMention(
      vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g3', sourceRef: 'c.md' }, { synthesisThreshold: 2 },
    );
    expect(result.crossedSynthesisThreshold).toBe(false);
  });
});

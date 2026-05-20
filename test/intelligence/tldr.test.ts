import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { updateTldr, postprocessTldr, buildCoDPrompt } from '../../src/intelligence/tldr.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function fakeLLM(responses: string[]): LLMClient {
  let i = 0;
  return {
    async complete() {
      return responses[i++ % responses.length];
    },
    async extractStructured() {
      throw new Error('not used');
    },
  };
}

describe('TL;DR (CoD)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-tldr-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('postprocessTldr', () => {
    it('strips code fences, quotes, and TL;DR prefix', () => {
      expect(postprocessTldr('```\n"TL;DR: hello world"\n```', 50)).toBe('hello world');
    });

    it('truncates and ellipses long output', () => {
      const long = 'a '.repeat(200);
      const out = postprocessTldr(long, 30);
      expect(out.length).toBeLessThanOrEqual(30);
      expect(out.endsWith('…')).toBe(true);
    });

    it('collapses whitespace', () => {
      expect(postprocessTldr('hello\n\nworld\t\tfoo', 50)).toBe('hello world foo');
    });
  });

  it('buildCoDPrompt embeds title, body, and pass count', () => {
    const p = buildCoDPrompt({ noteTitle: 'FSRS', body: 'A spaced repetition algorithm.', passes: 3, maxChars: 100 });
    expect(p).toContain('Title: FSRS');
    expect(p).toContain('A spaced repetition algorithm.');
    expect(p).toContain('3 Chain of Density passes');
    expect(p).toContain('≤100');
  });

  it('writes TL;DR to frontmatter and a protected region', async () => {
    const note = `---
id: c1
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# FSRS

FSRS (Free Spaced Repetition Scheduler) models retention with a stability
parameter. Each card has stability S and difficulty D; retrievability decays
exponentially as exp(-Δt / S). After a successful recall, S increases.
`;
    await vault.create('wiki/concepts/fsrs.md', note);

    const llm = fakeLLM(['FSRS — modern spaced-repetition scheduler that models stability and difficulty.']);
    const result = await updateTldr({ vault, llm, notePath: 'wiki/concepts/fsrs.md' });

    expect(result.updated).toBe(true);
    expect(result.tldr).toContain('FSRS');

    const updated = await vault.read('wiki/concepts/fsrs.md');
    const { data, body } = parseNote(updated);
    expect(data.tldr).toContain('FSRS');
    expect(data.tldr_updated_at).toBeDefined();
    expect(body).toContain('%% begin:tldr %%');
    expect(body).toContain('%% end:tldr %%');
    expect(body).toContain('TL;DR');
    expect(Array.isArray(data.protected_regions) && (data.protected_regions as string[]).includes('tldr')).toBe(true);
  });

  it('respects cooldown', async () => {
    const note = `---
id: c2
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
tldr: existing summary that already exists in frontmatter
tldr_updated_at: 2026-05-06T00:00:00Z
---
# FSRS
A long enough body that would otherwise trigger the rewrite. ${'word '.repeat(40)}
`;
    await vault.create('wiki/concepts/fsrs.md', note);
    const llm = fakeLLM(['Should not be called']);
    const nowMs = Date.parse('2026-05-06T06:00:00Z'); // 6 hours later, < 1 day cooldown
    const result = await updateTldr({ vault, llm, notePath: 'wiki/concepts/fsrs.md', nowMs });
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  it('skips when body is too short', async () => {
    await vault.create(
      'wiki/concepts/x.md',
      `---
id: x
type: concept
title: X
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
short.`,
    );
    const llm = fakeLLM(['nope']);
    const result = await updateTldr({ vault, llm, notePath: 'wiki/concepts/x.md' });
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('no-body');
  });

  it('updates existing tldr region in place on rewrite', async () => {
    const note = `---
id: c3
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---
# FSRS

%% begin:tldr %%
> **TL;DR** — old summary
%% end:tldr %%

FSRS body content. ${'word '.repeat(40)}
`;
    await vault.create('wiki/concepts/fsrs.md', note);
    const llm = fakeLLM(['New denser summary mentioning stability difficulty retrievability and spacing.']);
    const result = await updateTldr({ vault, llm, notePath: 'wiki/concepts/fsrs.md' });

    expect(result.updated).toBe(true);
    const updated = await vault.read('wiki/concepts/fsrs.md');
    expect(updated).not.toContain('old summary');
    expect(updated).toContain('New denser summary');
    // Only one tldr region.
    expect((updated.match(/%% begin:tldr %%/g) ?? []).length).toBe(1);
  });
});

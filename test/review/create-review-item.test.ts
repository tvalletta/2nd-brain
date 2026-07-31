import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { createReviewItem } from '../../src/review/create-review-item.js';

describe('createReviewItem', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-review-item-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a review note under review/ with the expected frontmatter', async () => {
    const path = await createReviewItem(vault, {
      slug: 'test-item',
      title: 'Uncertain: Zephyr Protocol (concept)',
      claimA: 'claim A',
      claimB: 'claim B',
      sourceRefs: ['sources/s1.md'],
      links: ['wiki/concepts/zephyr-protocol.md'],
      conflictType: 'uncertain_entity_drop',
      body: '\n# Uncertain: Zephyr Protocol\n\nBody text.\n',
    });

    expect(path).toBe('review/test-item.md');
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    expect(data.type).toBe('contradiction');
    expect(data.conflict_type).toBe('uncertain_entity_drop');
    expect(data.review_state).toBe('unreviewed');
    expect(data.resolution_state).toBe('open');
    expect(data.source_refs).toEqual(['sources/s1.md']);
    expect(data.links).toEqual(['wiki/concepts/zephyr-protocol.md']);
    expect(body).toContain('Body text.');
  });

  it('overwrites an existing review note with the same slug', async () => {
    await createReviewItem(vault, {
      slug: 'test-item',
      title: 'First',
      claimA: 'a',
      claimB: 'b',
      sourceRefs: [],
      links: [],
      conflictType: 'x',
      body: 'first body',
    });
    await createReviewItem(vault, {
      slug: 'test-item',
      title: 'Second',
      claimA: 'a2',
      claimB: 'b2',
      sourceRefs: [],
      links: [],
      conflictType: 'x',
      body: 'second body',
    });
    const { data, body } = parseNote(await vault.read('review/test-item.md'));
    expect(data.title).toBe('Second');
    expect(body).toContain('second body');
  });

  it('defaults confidence to low when omitted (regression)', async () => {
    const path = await createReviewItem(vault, {
      slug: 'no-confidence', title: 'T', claimA: 'a', claimB: 'b',
      sourceRefs: [], links: [], conflictType: 'potential_factual', body: 'body',
    });
    const { data } = parseNote(await vault.read(path));
    expect(data.confidence).toBe('low');
  });

  it('uses the provided confidence bucket when given', async () => {
    const path = await createReviewItem(vault, {
      slug: 'high-confidence', title: 'T', claimA: 'a', claimB: 'b',
      sourceRefs: [], links: [], conflictType: 'potential_factual', body: 'body', confidence: 'high',
    });
    const { data } = parseNote(await vault.read(path));
    expect(data.confidence).toBe('high');
  });
});

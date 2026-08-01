import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { detectContradictions, writeContradictionReview } from '../../src/review/contradiction-detector.js';
import { detectDuplicates, writeDuplicateReview } from '../../src/review/duplicate-detector.js';
import { listReviewItems, approveReviewItem, rejectReviewItem } from '../../src/review/review-queue.js';
import { createReviewItem } from '../../src/review/create-review-item.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { parseNote } from '../../src/vault/frontmatter.js';

vi.mock('../../src/review/generate-review-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/generate-review-analysis.js')>();
  return { ...actual, generateReviewAnalysis: vi.fn() };
});

import { generateReviewAnalysis } from '../../src/review/generate-review-analysis.js';

describe('Contradiction detection', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-review-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/decisions');
    await vault.ensureFolder('review');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('detects contradiction between pages with conflicting claims', async () => {
    await vault.create(
      'wiki/decisions/deadline-a.md',
      '---\ntitle: Deadline A\ntype: decision\n---\n# Deadline A\n\nWe decided the deadline must be March 1.\n',
    );
    await vault.create(
      'wiki/decisions/deadline-b.md',
      '---\ntitle: Deadline B\ntype: decision\n---\n# Deadline B\n\nWe decided the deadline will not be March but April.\n',
    );

    const candidates = await detectContradictions(vault);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    if (candidates.length > 0) {
      expect(candidates[0].conflictType).toBe('potential_factual');
    }
  });

  it('detects contradiction between pages with conflicting dates', async () => {
    await vault.create(
      'wiki/decisions/launch-a.md',
      '---\ntitle: Launch Date A\ntype: decision\n---\n# Launch A\n\nWe decided the launch deadline is 2026-03-15.\n',
    );
    await vault.create(
      'wiki/decisions/launch-b.md',
      '---\ntitle: Launch Date B\ntype: decision\n---\n# Launch B\n\nWe decided the launch deadline is 2026-04-30.\n',
    );

    const candidates = await detectContradictions(vault);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('detects contradiction between pages with conflicting numbers', async () => {
    await vault.create(
      'wiki/decisions/budget-a.md',
      '---\ntitle: Budget A\ntype: decision\n---\n# Budget A\n\nWe confirmed the project budget must be $50,000.\n',
    );
    await vault.create(
      'wiki/decisions/budget-b.md',
      '---\ntitle: Budget B\ntype: decision\n---\n# Budget B\n\nWe confirmed the project budget must be $120,000.\n',
    );

    const candidates = await detectContradictions(vault);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('writes contradiction review note with the generated analysis', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'genuine_conflict', reasoning: 'These claims directly conflict on the deadline date.', confidence: 0.85, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({ vaultPath: tempDir });
    const candidate = {
      pageA: 'wiki/decisions/a.md',
      pageB: 'wiki/decisions/b.md',
      claimA: 'Deadline is March',
      claimB: 'Deadline is not March',
      conflictType: 'potential_factual',
      reviewPath: 'review/test-contradiction.md',
    };

    const path = await writeContradictionReview(vault, config, tempDir, candidate);
    expect(await vault.exists(path)).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain('Contradiction');
    expect(content).toContain('Deadline is March');
    expect(content).toContain('unreviewed');
    expect(content).toContain('These claims directly conflict on the deadline date.');
    expect(content).toContain('genuine_conflict');

    const { data } = parseNote(content);
    expect(data.confidence).toBe('high');
  });
});

describe('Duplicate detection', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-dup-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/entities');
    await vault.ensureFolder('review');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('detects duplicate pages with high word overlap', async () => {
    const sharedContent = 'Alice is a senior engineer working on the authentication system redesign project at Acme Corp.';
    await vault.create(
      'wiki/entities/alice.md',
      `---\ntitle: Alice\ntype: entity\n---\n# Alice\n\n${sharedContent}\n`,
    );
    await vault.create(
      'wiki/entities/alice-smith.md',
      `---\ntitle: Alice Smith\ntype: entity\n---\n# Alice Smith\n\n${sharedContent} She leads the team.\n`,
    );

    const candidates = await detectDuplicates(vault);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].similarity).toBeGreaterThan(60);
  });

  it('boosts similarity for matching entity_kind and shared aliases', async () => {
    // These pages have moderate word overlap but share entity_kind and aliases
    await vault.create(
      'wiki/entities/auth-module.md',
      '---\ntitle: Auth Module\ntype: entity\nentity_kind: concept\naliases:\n  - authentication\n  - auth-service\nsource_refs:\n  - raw/design-doc.md\n---\n# Auth Module\n\nThe authentication module handles user login.\n',
    );
    await vault.create(
      'wiki/entities/authentication-service.md',
      '---\ntitle: Authentication Service\ntype: entity\nentity_kind: concept\naliases:\n  - authentication\nsource_refs:\n  - raw/design-doc.md\n---\n# Authentication Service\n\nThe authentication service manages user sessions and login flow.\n',
    );

    const candidates = await detectDuplicates(vault);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // Should have higher similarity than just Jaccard alone
    if (candidates.length > 0) {
      expect(candidates[0].similarity).toBeGreaterThan(60);
    }
  });

  it('does not flag very different pages', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      '---\ntitle: Alice\ntype: entity\n---\n# Alice\n\nAlice is an engineer.\n',
    );
    await vault.create(
      'wiki/entities/kubernetes.md',
      '---\ntitle: Kubernetes\ntype: entity\n---\n# Kubernetes\n\nContainer orchestration platform for microservices.\n',
    );

    const candidates = await detectDuplicates(vault);
    expect(candidates).toHaveLength(0);
  });

  it('writes duplicate review note with the generated analysis', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'same_entity', reasoning: 'Both describe the same engineer; Alice Smith is more complete.', confidence: 0.3, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({ vaultPath: tempDir });
    const candidate = {
      pathA: 'wiki/entities/alice.md',
      pathB: 'wiki/entities/alice-smith.md',
      titleA: 'Alice',
      titleB: 'Alice Smith',
      excerptA: 'Alice is a senior engineer.',
      excerptB: 'Alice Smith is a senior engineer who leads the team.',
      similarity: 85,
      reviewPath: 'review/duplicate-alice.md',
    };

    const path = await writeDuplicateReview(vault, config, tempDir, candidate);
    expect(await vault.exists(path)).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain('85%');
    expect(content).toContain('Alice');
    expect(content).toContain('Alice Smith is more complete.');

    const { data } = parseNote(content);
    expect(data.confidence).toBe('low');
  });
});

describe('Review queue', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-rq-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('review');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Fixtures below are produced via the real createReviewItem() entry point
  // (not hand-typed YAML) so these tests exercise the actual on-disk shape:
  // createReviewItem serializes frontmatter as `key: JSON.stringify(value)`,
  // which quotes every scalar (e.g. `status: "draft"`). A prior version of
  // approveReviewItem/rejectReviewItem mutated frontmatter via regex like
  // `/status: \w+/`, which can never match a quoted value — silently
  // no-op'ing on real review items. Building fixtures with createReviewItem
  // ensures this bug class can't resurface undetected.
  async function createRealReviewItem(slug: string, title: string): Promise<string> {
    return createReviewItem(vault, {
      slug,
      title,
      claimA: 'Claim A',
      claimB: 'Claim B',
      sourceRefs: [],
      links: [],
      conflictType: 'potential_factual',
      body: '# Test\n\n## Analysis\n%% begin:analysis %%\nPending.\n%% end:analysis %%\n',
    });
  }

  it('lists review items', async () => {
    await createRealReviewItem('test-item', 'Test Item');

    const items = await listReviewItems(vault);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Test Item');
    expect(items[0].reviewState).toBe('unreviewed');
  });

  it('approves a review item', async () => {
    const path = await createRealReviewItem('approve-me', 'Approve Me');
    // Extract the primitive immediately: gray-matter caches parsed results
    // keyed by the raw content string and returns the same (not deep-cloned)
    // `data` object on a repeat parse of identical content. approveReviewItem
    // parses this exact same on-disk string internally and mutates its
    // `data` object in place, so holding onto the whole parsed object here
    // (instead of the primitive value) would observe that later mutation too.
    const beforeUpdatedAt = parseNote(await vault.read(path)).data.updated_at as string;

    // Pin the clock for the mutation itself: the sandbox's real clock
    // resolution isn't reliably fine-grained enough to guarantee two
    // `nowISO()` calls a few ms apart produce distinct timestamps.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-06-15T12:00:00.000Z'));
      await approveReviewItem(vault, path);
    } finally {
      vi.useRealTimers();
    }

    const content = await vault.read(path);
    const { data } = parseNote(content);

    expect(data.review_state).toBe('approved');
    expect(content).toContain('**Approved**');
    expect(data.updated_at).toBe('2027-06-15T12:00:00.000Z');
    expect(data.updated_at).not.toBe(beforeUpdatedAt);
  });

  it('rejects a review item', async () => {
    const path = await createRealReviewItem('reject-me', 'Reject Me');
    const beforeUpdatedAt = parseNote(await vault.read(path)).data.updated_at as string;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-06-15T12:00:00.000Z'));
      await rejectReviewItem(vault, path);
    } finally {
      vi.useRealTimers();
    }

    const content = await vault.read(path);
    const { data } = parseNote(content);

    expect(data.review_state).toBe('rejected');
    expect(data.resolution_state).toBe('dismissed');
    expect(content).toContain('**Rejected**');
    expect(data.updated_at).toBe('2027-06-15T12:00:00.000Z');
    expect(data.updated_at).not.toBe(beforeUpdatedAt);
  });

  it('approving a review item sets status: active (Sub-project C, G5)', async () => {
    const path = await createRealReviewItem('approve-status', 'Approve Status');
    // createReviewItem always writes status: draft — confirm the real starting point.
    expect(parseNote(await vault.read(path)).data.status).toBe('draft');

    await approveReviewItem(vault, path);
    const { data } = parseNote(await vault.read(path));

    expect(data.review_state).toBe('approved');
    expect(data.status).toBe('active');
  });

  it('rejecting a review item sets status: rejected (Sub-project C, G5 — NoteStatus\'s 4th enum value, first real producer)', async () => {
    const path = await createRealReviewItem('reject-status', 'Reject Status');
    expect(parseNote(await vault.read(path)).data.status).toBe('draft');

    await rejectReviewItem(vault, path);
    const { data } = parseNote(await vault.read(path));

    expect(data.review_state).toBe('rejected');
    expect(data.resolution_state).toBe('dismissed');
    expect(data.status).toBe('rejected');
  });
});

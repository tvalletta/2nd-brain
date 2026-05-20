import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { detectContradictions, writeContradictionReview } from '../../src/review/contradiction-detector.js';
import { detectDuplicates, writeDuplicateReview } from '../../src/review/duplicate-detector.js';
import { listReviewItems, approveReviewItem, rejectReviewItem } from '../../src/review/review-queue.js';

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

  it('writes contradiction review note', async () => {
    const candidate = {
      pageA: 'wiki/decisions/a.md',
      pageB: 'wiki/decisions/b.md',
      claimA: 'Deadline is March',
      claimB: 'Deadline is not March',
      conflictType: 'potential_factual',
      reviewPath: 'review/test-contradiction.md',
    };

    const path = await writeContradictionReview(vault, candidate);
    expect(await vault.exists(path)).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain('Contradiction');
    expect(content).toContain('Deadline is March');
    expect(content).toContain('unreviewed');
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

  it('writes duplicate review note', async () => {
    const candidate = {
      pathA: 'wiki/entities/alice.md',
      pathB: 'wiki/entities/alice-smith.md',
      titleA: 'Alice',
      titleB: 'Alice Smith',
      similarity: 85,
      reviewPath: 'review/duplicate-alice.md',
    };

    const path = await writeDuplicateReview(vault, candidate);
    expect(await vault.exists(path)).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain('85%');
    expect(content).toContain('Alice');
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

  it('lists review items', async () => {
    await vault.create(
      'review/test-item.md',
      '---\ntitle: Test Item\ntype: contradiction\nreview_state: unreviewed\ncreated_at: "2026-04-11T00:00:00.000Z"\n---\n# Test\n',
    );

    const items = await listReviewItems(vault);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Test Item');
    expect(items[0].reviewState).toBe('unreviewed');
  });

  it('approves a review item', async () => {
    await vault.create(
      'review/approve-me.md',
      '---\ntitle: Approve Me\nreview_state: unreviewed\nupdated_at: "2026-04-11T00:00:00.000Z"\n---\n# Test\n\n## Analysis\n%% begin:analysis %%\nPending.\n%% end:analysis %%\n',
    );

    await approveReviewItem(vault, 'review/approve-me.md');
    const content = await vault.read('review/approve-me.md');
    expect(content).toContain('review_state: approved');
    expect(content).toContain('**Approved**');
  });

  it('rejects a review item', async () => {
    await vault.create(
      'review/reject-me.md',
      '---\ntitle: Reject Me\nreview_state: unreviewed\nresolution_state: open\nupdated_at: "2026-04-11T00:00:00.000Z"\n---\n# Test\n\n## Analysis\n%% begin:analysis %%\nPending.\n%% end:analysis %%\n',
    );

    await rejectReviewItem(vault, 'review/reject-me.md');
    const content = await vault.read('review/reject-me.md');
    expect(content).toContain('review_state: rejected');
    expect(content).toContain('resolution_state: dismissed');
    expect(content).toContain('**Rejected**');
  });
});

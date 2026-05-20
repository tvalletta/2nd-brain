import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { runDecayScan } from '../../src/intelligence/decay-scan.js';
import { runRotScan } from '../../src/intelligence/rot-scan.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { readResearchQueue } from '../../src/maintenance/research-queue.js';
import type { JobCreateInput } from '../../src/jobs/types.js';

describe('decay-scan (C1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-decay-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('enqueues refresh for stale concept and surfaces a research candidate', async () => {
    await vault.create(
      'wiki/concepts/old.md',
      `---
id: c1
type: concept
title: Old concept
created_at: 2025-01-01T00:00:00Z
updated_at: 2025-01-01T00:00:00Z
last_verified: 2025-01-01T00:00:00Z
stability: 30
half_life_domain: concept
confidence: low
---
body content for old concept.`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault,
      config,
      enqueue: async (i) => {
        enqueued.push(i);
        return {} as never;
      },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.scanned).toBe(1);
    expect(result.refreshEnqueued).toBe(1);
    expect(enqueued[0].type).toBe('topic-refresh');
    expect(enqueued[0].targetPath).toBe('wiki/concepts/old.md');
    expect(result.researchCandidates).toBe(1);

    // Retrievability stamped on the note.
    const updated = await vault.read('wiki/concepts/old.md');
    const { data } = parseNote(updated);
    expect(typeof data.retrievability).toBe('number');
    expect(data.retrievability_checked_at).toBeDefined();

    // Research queue populated.
    const queue = await readResearchQueue(vault);
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0].slug).toBe('old');
  });

  it('does not enqueue refresh for fresh notes', async () => {
    const today = new Date().toISOString();
    await vault.create(
      'wiki/concepts/fresh.md',
      `---
id: c2
type: concept
title: Fresh
created_at: ${today}
updated_at: ${today}
last_verified: ${today}
stability: 60
half_life_domain: concept
---
body.`,
    );
    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault,
      config,
      enqueue: async (i) => {
        enqueued.push(i);
        return {} as never;
      },
    });
    expect(result.refreshEnqueued).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe('rot-scan (C2)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-rot-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags stale + orphan + low-confidence as candidates', async () => {
    await vault.create(
      'wiki/concepts/dead.md',
      `---
id: x
type: concept
title: Dead
created_at: 2024-01-01T00:00:00Z
updated_at: 2024-01-01T00:00:00Z
confidence: low
---
body.`,
    );
    await vault.create(
      'wiki/concepts/healthy.md',
      `---
id: y
type: concept
title: Healthy
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
body.

%% begin:backlinks %%
- [[wiki/something]]
%% end:backlinks %%`,
    );
    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));
    expect(result.scanned).toBe(2);
    expect(result.candidates.map((c) => c.path)).toContain('wiki/concepts/dead.md');
    expect(result.candidates.map((c) => c.path)).not.toContain('wiki/concepts/healthy.md');

    const report = await vault.read(result.reportPath);
    expect(report).toContain('Vault health');
    expect(report).toContain('Dead');
  });
});

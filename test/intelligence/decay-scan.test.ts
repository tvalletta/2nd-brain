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
%% begin:current-understanding %%
A substantial, well-formed understanding of this concept that comfortably exceeds the thin-content character floor.
%% end:current-understanding %%

%% begin:related-concepts %%
- [[wiki/concepts/other.md]]
%% end:related-concepts %%`,
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

  it('a thin (placeholder outcome) decision note above the retrievability threshold still enqueues, via thin-content', async () => {
    await vault.ensureFolder('wiki/decisions');
    const today = new Date().toISOString();
    await vault.create(
      'wiki/decisions/thin.md',
      `---
id: d1
type: decision
title: Thin decision
created_at: ${today}
updated_at: ${today}
last_verified: ${today}
stability: 365
half_life_domain: decisions
---
## Context
%% begin:context %%
Some context.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.thinContentEnqueued).toBe(1);
    expect(result.refreshEnqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].trigger).toBe('thin-content');
    expect(enqueued[0].priority).toBe(80);
  });

  it('a thin note that is ALSO below the retrievability threshold enqueues exactly once', async () => {
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/decisions/thin-and-stale.md',
      `---
id: d2
type: decision
title: Thin and stale
created_at: 2025-01-01T00:00:00Z
updated_at: 2025-01-01T00:00:00Z
last_verified: 2025-01-01T00:00:00Z
stability: 30
half_life_domain: decisions
---
## Outcome
%% begin:outcome %%
%% end:outcome %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(enqueued).toHaveLength(1);
    expect(result.thinContentEnqueued).toBe(1);
    expect(result.refreshEnqueued).toBe(1);
  });

  it('a stale project_spec note is scored but does NOT enqueue topic-refresh (no REFRESH_TARGETS entry)', async () => {
    await vault.ensureFolder('wiki/projects/proj-a');
    await vault.create(
      'wiki/projects/proj-a/technical.md',
      `---
id: s1
type: project_spec
title: proj-a technical
created_at: 2025-01-01T00:00:00Z
updated_at: 2025-01-01T00:00:00Z
last_verified: 2025-01-01T00:00:00Z
stability: 30
---
%% begin:content %%
Agent-authored content.
%% end:content %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(enqueued).toHaveLength(0);
    expect(result.refreshEnqueued).toBe(0);
    const { data } = parseNote(await vault.read('wiki/projects/proj-a/technical.md'));
    expect(typeof data.retrievability).toBe('number'); // still scored
  });

  it('a topic with rich current-understanding but an empty related-concepts region is still flagged thin', async () => {
    await vault.ensureFolder('wiki/topics');
    const today = new Date().toISOString();
    await vault.create(
      'wiki/topics/rich.md',
      `---
id: t1
type: topic
title: Rich topic
created_at: ${today}
updated_at: ${today}
last_verified: ${today}
stability: 365
half_life_domain: topic
---
%% begin:current-understanding %%
${'A'.repeat(200)}
%% end:current-understanding %%

%% begin:related-concepts %%
%% end:related-concepts %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault, config,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.thinContentEnqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it('respects intelligence.richness.enabled: false — a thin note above the retrievability threshold no longer force-enqueues (regression for config-wiring gap)', async () => {
    const richnessDisabledConfig = KarpathyConfigSchema.parse({
      vaultPath: '/tmp',
      intelligence: { richness: { enabled: false } },
    });
    await vault.ensureFolder('wiki/decisions');
    const today = new Date().toISOString();
    await vault.create(
      'wiki/decisions/thin-disabled.md',
      `---
id: d3
type: decision
title: Thin decision, richness disabled
created_at: ${today}
updated_at: ${today}
last_verified: ${today}
stability: 365
half_life_domain: decisions
---
## Context
%% begin:context %%
Some context.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault,
      config: richnessDisabledConfig,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    // Above the retrievability threshold AND thin — but richness is
    // disabled, so the thin-content backfill (G2) must not fire. Falls
    // back to pre-B2b behavior: no enqueue at all for a fresh, non-decayed
    // note, regardless of placeholder content.
    expect(result.thinContentEnqueued).toBe(0);
    expect(result.refreshEnqueued).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('intelligence.richness.enabled: false does not suppress retrievability-driven refresh (only the thin-content force-enqueue)', async () => {
    const richnessDisabledConfig = KarpathyConfigSchema.parse({
      vaultPath: '/tmp',
      intelligence: { richness: { enabled: false } },
    });
    await vault.create(
      'wiki/concepts/old-disabled.md',
      `---
id: c3
type: concept
title: Old concept, richness disabled
created_at: 2025-01-01T00:00:00Z
updated_at: 2025-01-01T00:00:00Z
last_verified: 2025-01-01T00:00:00Z
stability: 30
half_life_domain: concept
---
body content for old concept.`,
    );

    const enqueued: JobCreateInput[] = [];
    const result = await runDecayScan({
      vault,
      config: richnessDisabledConfig,
      enqueue: async (i) => { enqueued.push(i); return {} as never; },
      nowMs: Date.parse('2026-05-06T00:00:00Z'),
    });

    expect(result.refreshEnqueued).toBe(1);
    expect(result.thinContentEnqueued).toBe(0);
    expect(enqueued[0].trigger).toBe('cascade');
    expect(enqueued[0].priority).toBe(75);
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

  it('flags a note with a placeholder primary region as thin content, in a separate table from rot candidates', async () => {
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/decisions/thin-decision.md',
      `---
id: d1
type: decision
title: Thin decision
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
## Outcome
%% begin:outcome %%
%% end:outcome %%

%% begin:backlinks %%
- [[wiki/something]]
%% end:backlinks %%`,
    );

    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));

    expect(result.thinCandidates.map((c) => c.path)).toContain('wiki/decisions/thin-decision.md');
    expect(result.thinCandidates.find((c) => c.path === 'wiki/decisions/thin-decision.md')?.region).toBe('outcome');
    // Fresh + high-confidence + has an inbound marker → NOT a rot candidate.
    expect(result.candidates.map((c) => c.path)).not.toContain('wiki/decisions/thin-decision.md');

    const report = await vault.read(result.reportPath);
    expect(report).toContain('Thin content');
    expect(report).toContain('thin-decision');
  });

  it('does not flag a note with a substantial outcome as thin', async () => {
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/decisions/resolved-decision.md',
      `---
id: d2
type: decision
title: Resolved decision
created_at: 2026-04-01T00:00:00Z
updated_at: 2026-04-01T00:00:00Z
confidence: high
---
## Outcome
%% begin:outcome %%
Shipped in v2 and adopted by all downstream consumers.
%% end:outcome %%`,
    );

    const result = await runRotScan(vault, Date.parse('2026-05-06T00:00:00Z'));
    expect(result.thinCandidates.map((c) => c.path)).not.toContain('wiki/decisions/resolved-decision.md');
  });
});

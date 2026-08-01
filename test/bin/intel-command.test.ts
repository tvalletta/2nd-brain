import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { writeResearchQueue, readResearchQueue } from '../../src/maintenance/research-queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

// `loadConfig()` (src/config/loader.ts) always reads the real global config
// at `${os.homedir()}/.karpathy/config.json`. `GLOBAL_CONFIG_PATH`
// (src/config/defaults.ts) is a MODULE-LEVEL CONSTANT computed once from
// `homedir()` at import time -- not re-evaluated per call. Setting
// `process.env.HOME` in a per-test `beforeEach` would be too late: by then
// `intel-command.js` (and the `config/defaults.js` it transitively imports)
// would already have been evaluated via this file's top-level static
// imports, freezing GLOBAL_CONFIG_PATH to the REAL ~/.karpathy/config.json
// before any test body ever runs.
//
// Fix: redirect HOME in a file-scoped `beforeAll`, BEFORE dynamically
// import()-ing intel-command.js for the first time, so GLOBAL_CONFIG_PATH
// gets computed fresh against the redirected HOME. This relies on Vitest's
// default per-test-FILE module isolation (vitest.config.ts sets no
// `isolate` override, so the default `true` applies) so this redirect can't
// leak into any other test file. HOME (and thus GLOBAL_CONFIG_PATH) stays
// fixed for this whole file; per-test isolation instead comes from
// rewriting the config file's CONTENT (vaultPath) in each test's own
// beforeEach -- readGlobalConfig() re-reads that file fresh on every call.
let intelCommand: typeof import('../../src/bin/intel-command.js')['intelCommand'];
let fakeHome: string;

describe('karpathy intel queue/approve/status — non-default layout (G0)', () => {
  let vaultDir: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'karpathy-home-'));
    process.env.HOME = fakeHome;
    ({ intelCommand } = await import('../../src/bin/intel-command.js'));
  });

  afterAll(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'karpathy-vault-'));
    await mkdir(join(fakeHome, '.karpathy'), { recursive: true });
    await writeFile(
      join(fakeHome, '.karpathy', 'config.json'),
      JSON.stringify({
        defaults: { vaultPath: vaultDir, layout: { system: 'Curated/_system' } },
        projects: {},
      }),
      'utf-8',
    );

    const config = KarpathyConfigSchema.parse({ vaultPath: vaultDir, layout: { system: 'Curated/_system' } });
    const vault = createFsAdapter(vaultDir);
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'test candidate', suggested: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    }, config.layout);

    writes = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('"queue" finds the real candidate at the configured Curated/_system layout path (regression: used to always print "queue is empty")', async () => {
    await intelCommand(['queue']);
    const output = writes.join('');
    expect(output).not.toContain('Research queue is empty');
    // NB: research-queue.ts's markdown table has no Title column -- only
    // `slug` round-trips through read/write (readResearchQueue derives
    // `title` from the slug cell, m[1].trim()). So the persisted/displayed
    // title is the lowercase slug ("fsrs"), not the fixture's original
    // mixed-case "FSRS". This is pre-existing behavior unrelated to the G0
    // layout fix under test here.
    expect(output).toContain('fsrs');
  });

  it('"status" reports the real pending count (regression: used to always report 0 pending)', async () => {
    await intelCommand(['status']);
    const output = writes.join('');
    expect(output).toContain('research queue:');
    expect(output).toContain('1 pending');
  });

  it('"approve" applies a decision to the real queue at the configured layout path and prints the real path (regression: used to always print "queue is empty" and the legacy wiki/_system path)', async () => {
    await intelCommand(['approve', '1 heavy']);
    const output = writes.join('');
    expect(output).not.toContain('Queue is empty');
    // See note above re: title not round-tripping -- displayed as the
    // lowercase slug "fsrs", not the fixture's original mixed-case "FSRS".
    expect(output).toContain('fsrs → heavy');
    expect(output).toContain('Curated/_system/research-queue.md');
    expect(output).not.toContain('wiki/_system/research-queue.md');

    const vault = createFsAdapter(vaultDir);
    const config = KarpathyConfigSchema.parse({ vaultPath: vaultDir, layout: { system: 'Curated/_system' } });
    const queue = await readResearchQueue(vault, config.layout);
    expect(queue.candidates[0].decision).toBe('heavy');
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// `runDaemon` calls `createMCPContext()`, which goes through `loadConfig()`
// (src/config/loader.ts) -- it always reads the REAL global config at
// `${os.homedir()}/.karpathy/config.json`, which on a real developer
// machine points at the real production vault. `GLOBAL_CONFIG_PATH`
// (src/config/defaults.ts) is a MODULE-LEVEL CONSTANT computed once from
// `homedir()` at import time -- not re-evaluated per call. Setting
// `process.env.HOME` in a per-test `beforeEach` would be too late: by then
// `daemon.js` (and the `config/defaults.js` it transitively imports) would
// already have been evaluated via a static import, freezing
// `GLOBAL_CONFIG_PATH` to the real path before any test body runs.
//
// Fix (same pattern as test/bin/intel-command.test.ts): redirect HOME in a
// file-scoped `beforeAll`, BEFORE dynamically import()-ing daemon.js for
// the first time, so `GLOBAL_CONFIG_PATH` gets computed fresh against the
// redirected HOME. Per-test isolation then comes from rewriting the fake
// global config file's content (vaultPath) in each test's own setup --
// `readGlobalConfig()` re-reads that file fresh on every call.
let runDaemon: (typeof import('../../src/mcp/daemon.js'))['runDaemon'];
let runTeardownSteps: (typeof import('../../src/mcp/daemon.js'))['runTeardownSteps'];
let fakeHome: string;

describe('runDaemon', () => {
  let handles: { close(): Promise<void> }[];
  let dirsToClean: string[];

  beforeAll(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'karpathy-daemon-home-'));
    process.env.HOME = fakeHome;
    ({ runDaemon, runTeardownSteps } = await import('../../src/mcp/daemon.js'));
  });

  afterAll(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    handles = [];
    dirsToClean = [];
  });

  afterEach(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
    await Promise.all(dirsToClean.map((d) => rm(d, { recursive: true, force: true })));
  });

  /**
   * Creates a fresh project root + vault dir pair and (re)writes the fake
   * global config to point at the new vault. `ingest.watchEnabled` is left
   * at its schema default (`false`), so `startVaultWatcher` short-circuits
   * without touching the filesystem -- this test is only exercising the
   * HTTP transport + single-instance lock, both of which are independent
   * of the watcher (covered separately by test/mcp/vault-watcher.test.ts).
   */
  async function makeProjectRoot(): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'karpathy-daemon-project-'));
    const vaultDir = await mkdtemp(join(tmpdir(), 'karpathy-daemon-vault-'));
    dirsToClean.push(projectRoot, vaultDir);

    await mkdir(join(fakeHome, '.karpathy'), { recursive: true });
    await writeFile(
      join(fakeHome, '.karpathy', 'config.json'),
      JSON.stringify({ defaults: { vaultPath: vaultDir }, projects: {} }),
      'utf-8',
    );

    return projectRoot;
  }

  it('boots the daemon over HTTP, serves tools to a real MCP client, executes a real tool call end-to-end, and close() releases the port', async () => {
    const projectRoot = await makeProjectRoot();
    const h = await runDaemon({ projectRoot, port: 0 });
    handles.push(h);

    expect(h.port).toBeGreaterThan(0);
    expect(h.url).toBe(`http://127.0.0.1:${h.port}/mcp`);

    const healthRes = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe('ok');

    const client = new Client({ name: 'daemon-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    // Important 3: prove a real tool *executes* end-to-end through the
    // daemon (HTTP -> session routing -> createMcpServer(ctx) -> handler
    // -> JSON-RPC result), not just that the tool list is served.
    // `vault_status` is cheap, side-effect-free, and takes no arguments --
    // safe against the empty temp vault.
    const result = await client.callTool({ name: 'vault_status', arguments: {} });
    expect(result.isError).not.toBe(true);
    const first = result.content[0];
    if (!first || first.type !== 'text') {
      throw new Error(`expected a text content block, got: ${JSON.stringify(first)}`);
    }
    const parsed = JSON.parse(first.text);
    expect(parsed).toHaveProperty('total_notes');
    expect(parsed).toHaveProperty('review_queue_size');

    await client.close().catch(() => {});

    await h.close();
    handles = handles.filter((x) => x !== h);

    // Port released: nothing is listening there anymore.
    await expect(fetch(`http://127.0.0.1:${h.port}/health`)).rejects.toThrow();
  });

  it('close() is idempotent', async () => {
    const projectRoot = await makeProjectRoot();
    const h = await runDaemon({ projectRoot, port: 0 });
    handles.push(h);

    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
    handles = handles.filter((x) => x !== h);
  });

  it('a second runDaemon call while the first holds the lock does not bind a second server', async () => {
    const projectRoot = await makeProjectRoot();

    const h1 = await runDaemon({ projectRoot, port: 0 });
    handles.push(h1);
    expect(h1.port).toBeGreaterThan(0);

    // Second call against the same project root races the same
    // `mcp-daemon` file lock. It must not bind a port or start anything --
    // it should come back as the no-op "already running" handle instead.
    const h2 = await runDaemon({ projectRoot, port: 0 });
    handles.push(h2);
    expect(h2.port).toBe(-1);
    expect(h2.url).toBe('');
    await expect(h2.close()).resolves.toBeUndefined();

    // The first daemon is completely unaffected.
    const r = await fetch(`http://127.0.0.1:${h1.port}/health`);
    expect(r.status).toBe(200);
  });

  // Important 2: a startup failure between lock-acquire and returning the
  // handle (e.g. EADDRINUSE from a port collision) must not leak the
  // `mcp-daemon` file lock -- otherwise every subsequent `runDaemon` call
  // against this project root would be permanently refused until someone
  // manually deleted the stale lock file.
  it('a startup failure (EADDRINUSE) releases the daemon lock instead of leaking it', async () => {
    const projectRoot = await makeProjectRoot();

    // Occupy a real port so startHttpMcpServer's own listen() call fails.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const address = blocker.address();
    const blockedPort = address && typeof address === 'object' ? address.port : 0;
    expect(blockedPort).toBeGreaterThan(0);

    await expect(runDaemon({ projectRoot, port: blockedPort, host: '127.0.0.1' })).rejects.toThrow();

    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    // The daemon lock must not have been leaked: a fresh runDaemon against
    // the same project root can now acquire it and actually start (not
    // come back as the no-op "already running" handle).
    const h = await runDaemon({ projectRoot, port: 0 });
    handles.push(h);
    expect(h.port).toBeGreaterThan(0);
    const r = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(r.status).toBe(200);
  });

  // Important 1: teardown must run every cleanup step independently -- a
  // rejection in one (e.g. http.close()) must never prevent the others
  // (in particular, releasing the daemon lock and the watcher lock) from
  // running. Covered directly against the exported `runTeardownSteps`
  // helper rather than by forcing a failure inside the real
  // `startHttpMcpServer`/watcher/lock dependencies -- those are
  // themselves written to swallow their own errors defensively (see
  // src/jobs/lock.ts's release function), so they can't be forced to
  // reject without brittle module mocking that would also compromise the
  // real end-to-end coverage above.
  describe('runTeardownSteps (Important 1 coverage)', () => {
    it('a rejecting step does not prevent the other steps from running', async () => {
      const calls: string[] = [];
      const steps = [
        () => {
          calls.push('http.close');
          throw new Error('boom: forced http.close() failure for test');
        },
        () => {
          calls.push('vw.stop');
        },
        async () => {
          calls.push('vw.release');
        },
        async () => {
          calls.push('releaseLock');
        },
      ];

      await expect(runTeardownSteps(steps)).rejects.toThrow(/boom/);
      // Every step ran despite the first one throwing -- the locks
      // ("vw.release", "releaseLock") were freed regardless.
      expect(calls.sort()).toEqual(['http.close', 'releaseLock', 'vw.release', 'vw.stop']);
    });

    it('aggregates multiple failures but still runs every step exactly once', async () => {
      const calls: string[] = [];
      const steps = [
        () => {
          calls.push('a');
          throw new Error('fail a');
        },
        () => {
          calls.push('b');
        },
        () => {
          calls.push('c');
          throw new Error('fail c');
        },
      ];

      await expect(runTeardownSteps(steps)).rejects.toThrow(AggregateError);
      expect(calls).toHaveLength(3);
    });

    it('resolves cleanly when every step succeeds', async () => {
      const calls: string[] = [];
      await expect(
        runTeardownSteps([
          () => {
            calls.push('a');
          },
          async () => {
            calls.push('b');
          },
        ]),
      ).resolves.toBeUndefined();
      expect(calls).toEqual(['a', 'b']);
    });
  });
});

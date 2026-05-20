import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { handleSessionStart } from '../../src/hooks/session-start.js';
import { handleUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { handlePostToolUse } from '../../src/hooks/post-tool-use.js';
import { handlePostCompact } from '../../src/hooks/post-compact.js';
import { handleStop } from '../../src/hooks/stop.js';
import type { HookContext } from '../../src/hooks/dispatch.js';
import type { KarpathyConfig } from '../../src/config/schema.js';
import type { JobQueue } from '../../src/jobs/queue.js';

const SAMPLE_CLAUDE_MD = `# Karpathy Second Memory

## Recent Sessions
%% begin:recent-sessions %%
%% end:recent-sessions %%

## Key Entities
%% begin:key-entities %%
%% end:key-entities %%
`;

describe('Hook handlers', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let ctx: HookContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-hooks-'));
    vault = createFsAdapter(tempDir);

    // Set up vault structure
    await vault.ensureFolder('outputs/session-summaries');
    await vault.ensureFolder('wiki');
    const claudeMdPath = join(tempDir, 'CLAUDE.md');
    await writeFile(claudeMdPath, SAMPLE_CLAUDE_MD, 'utf-8');

    const sessionLog = createSessionLogManager(vault);
    const hotCache = createHotCacheManager(claudeMdPath);

    const config: KarpathyConfig = {
      vaultPath: tempDir,
      projectRoot: tempDir,
      hotCachePath: 'CLAUDE.md',
      stateDir: '.karpathy/state',
      lockDir: '.karpathy/locks',
      logDir: '.karpathy/logs',
      llm: { provider: 'bedrock', region: 'us-west-2', model: 'test', maxTokens: 100 },
      ingest: { watchEnabled: false, watchPaths: [], debounceMs: 0 },
      session: { exportToRaw: false, minTurns: 2 },
      maintenance: { autoBacklinks: false, autoIndexes: false, reviewEnabled: false },
      enrichment: { enabled: true, maxChunkSize: 12000, chunkOverlap: 1000, autoCreateEntities: true, autoMergeEntities: true, contradictionDetection: false },
    };

    const mockQueue = {
      enqueue: async () => ({} as any),
      dequeue: async () => null,
      peek: async () => null,
      complete: async () => {},
      fail: async () => {},
      cancel: async () => {},
      list: async () => [],
      size: () => 0,
      flush: async () => {},
      load: async () => {},
    } satisfies JobQueue;

    ctx = {
      config,
      vault,
      sessionLog,
      hotCache,
      queue: mockQueue,
      backgroundDrain: vi.fn(),
      runDeterministicJobs: async () => 0,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('session-start returns additionalContext', async () => {
    const result = await handleSessionStart(
      {
        hook_event_name: 'SessionStart',
        session_id: 'test-session-1',
        cwd: '/tmp/test',
      },
      ctx,
    );

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('Karpathy Second Memory');
  });

  it('session-start creates session note', async () => {
    await handleSessionStart(
      {
        hook_event_name: 'SessionStart',
        session_id: 'test-session-2',
        cwd: '/tmp/test',
      },
      ctx,
    );

    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    expect(files.length).toBe(1);
  });

  it('user-prompt-submit captures prompt', async () => {
    // First create the session
    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-prompt', cwd: '/tmp' },
      ctx,
    );

    await handleUserPromptSubmit(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-prompt',
        cwd: '/tmp',
        prompt: 'Help me fix the login bug',
      },
      ctx,
    );

    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    const content = await vault.read(files[0]);
    expect(content).toContain('Help me fix the login bug');
  });

  it('post-tool-use captures Write tool', async () => {
    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-tool', cwd: '/tmp' },
      ctx,
    );

    await handlePostToolUse(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-tool',
        cwd: '/tmp',
        tool_name: 'Write',
        tool_input: { file_path: '/src/app.ts' },
      },
      ctx,
    );

    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    const content = await vault.read(files[0]);
    expect(content).toContain('/src/app.ts');
  });

  it('post-tool-use captures Bash tool', async () => {
    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-bash', cwd: '/tmp' },
      ctx,
    );

    await handlePostToolUse(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-bash',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
      ctx,
    );

    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    const content = await vault.read(files[0]);
    expect(content).toContain('npm test');
  });

  it('post-tool-use ignores Read tool', async () => {
    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-read', cwd: '/tmp' },
      ctx,
    );

    const result = await handlePostToolUse(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-read',
        cwd: '/tmp',
        tool_name: 'Read',
        tool_input: { file_path: '/src/app.ts' },
      },
      ctx,
    );

    expect(result.continue).toBe(true);
    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    const content = await vault.read(files[0]);
    // Tool activity should be empty since Read is not tracked
    expect(content).not.toContain('/src/app.ts');
  });

  it('post-compact saves compact summary', async () => {
    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-compact', cwd: '/tmp' },
      ctx,
    );

    await handlePostCompact(
      {
        hook_event_name: 'PostCompact',
        session_id: 'sess-compact',
        cwd: '/tmp',
        compact_summary: 'Built the job queue system with dedup.',
      },
      ctx,
    );

    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    const content = await vault.read(files[0]);
    expect(content).toContain('Built the job queue system');
  });

  it('stop finalizes session and updates hot cache', async () => {
    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-stop', cwd: '/tmp' },
      ctx,
    );

    await handleStop(
      {
        hook_event_name: 'Stop',
        session_id: 'sess-stop',
        cwd: '/tmp',
        last_assistant_message: 'All tests passing. Build complete.',
      },
      ctx,
    );

    // Session note should have final output
    const files = await vault.listMarkdownFiles('outputs/session-summaries');
    const sessionContent = await vault.read(files[0]);
    expect(sessionContent).toContain('All tests passing');

    // Hot cache should have new session entry (uses last_assistant_message summary)
    const claudeMd = await vault.read('CLAUDE.md');
    expect(claudeMd).toContain('All tests passing');
  });

  it('stop spawns background drain instead of running jobs synchronously', async () => {
    const runJobsSpy = vi.fn(async () => 0);
    ctx.runDeterministicJobs = runJobsSpy;

    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-bg', cwd: '/tmp' },
      ctx,
    );

    await handleStop(
      {
        hook_event_name: 'Stop',
        session_id: 'sess-bg',
        cwd: '/tmp',
        last_assistant_message: 'Done.',
      },
      ctx,
    );

    expect(ctx.backgroundDrain).toHaveBeenCalledOnce();
    expect(runJobsSpy).not.toHaveBeenCalled();
  });

  it('post-compact spawns background drain instead of running jobs synchronously', async () => {
    const runJobsSpy = vi.fn(async () => 0);
    ctx.runDeterministicJobs = runJobsSpy;

    await handleSessionStart(
      { hook_event_name: 'SessionStart', session_id: 'sess-compact-bg', cwd: '/tmp' },
      ctx,
    );

    await handlePostCompact(
      {
        hook_event_name: 'PostCompact',
        session_id: 'sess-compact-bg',
        cwd: '/tmp',
        compact_summary: 'Compacted context.',
      },
      ctx,
    );

    expect(ctx.backgroundDrain).toHaveBeenCalledOnce();
    expect(runJobsSpy).not.toHaveBeenCalled();
  });
});

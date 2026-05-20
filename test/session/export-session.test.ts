import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportSessionToRaw } from '../../src/session/export-session.js';
import { formatSessionMarkdown, sessionExportFilename } from '../../src/session/session-exporter.js';
import { createExportTracker } from '../../src/session/export-tracker.js';
import type { ParsedSession } from '../../src/session/jsonl-parser.js';

describe('Session Exporter', () => {
  const session: ParsedSession = {
    sessionId: 'abc12345-0000-0000-0000-000000000000',
    cwd: '/tmp/test-project',
    gitBranch: 'feature-branch',
    startedAt: '2026-04-11T14:30:00.000Z',
    endedAt: '2026-04-11T15:45:00.000Z',
    version: '2.1.101',
    turns: [
      { timestamp: '2026-04-11T14:30:00.000Z', type: 'user-prompt', content: 'Fix the login bug' },
      { timestamp: '2026-04-11T14:30:05.000Z', type: 'assistant-text', content: 'Let me investigate.' },
      { timestamp: '2026-04-11T14:30:10.000Z', type: 'tool-use', content: '**Read** — src/auth.ts', toolName: 'Read' },
      { timestamp: '2026-04-11T14:30:15.000Z', type: 'assistant-text', content: 'Found the issue in the token validation.' },
    ],
  };

  it('formats markdown with header and turns', () => {
    const md = formatSessionMarkdown(session);
    expect(md).toContain('# Claude Code Session: 2026-04-11 (abc12345)');
    expect(md).toContain('**Session ID:** abc12345-0000-0000-0000-000000000000');
    expect(md).toContain('**Working directory:** `/tmp/test-project`');
    expect(md).toContain('**Git branch:** feature-branch');
    expect(md).toContain('**Source:** 2.1.101');
    expect(md).toContain('## Conversation');
    expect(md).toContain('### Turn 1 — User (14:30:00)');
    expect(md).toContain('Fix the login bug');
    expect(md).toContain('### Turn 2 — Assistant (14:30:05)');
    expect(md).toContain('### Turn 3 — Tool (14:30:10)');
    expect(md).toContain('### Turn 4 — Assistant (14:30:15)');
  });

  it('generates correct filename', () => {
    const name = sessionExportFilename(session);
    expect(name).toBe('claude-session-2026-04-11-abc12345.md');
  });

  it('handles session with no git branch', () => {
    const noGit: ParsedSession = { ...session, gitBranch: undefined };
    const md = formatSessionMarkdown(noGit);
    expect(md).not.toContain('**Git branch:**');
  });
});

describe('Export Tracker', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-tracker-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('tracks exported sessions', async () => {
    const tracker = createExportTracker(tempDir);
    await tracker.load();

    expect(tracker.isExported('session-1')).toBe(false);
    tracker.markExported('session-1', 'hash123');
    expect(tracker.isExported('session-1')).toBe(true);

    await tracker.flush();

    // Reload and verify persistence
    const tracker2 = createExportTracker(tempDir);
    await tracker2.load();
    expect(tracker2.isExported('session-1')).toBe(true);
    expect(tracker2.isExported('session-2')).toBe(false);
  });

  it('loads from missing file without error', async () => {
    const tracker = createExportTracker(join(tempDir, 'nonexistent'));
    await tracker.load();
    expect(tracker.isExported('anything')).toBe(false);
  });
});

describe('exportSessionToRaw', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-export-'));
    stateDir = join(tempDir, 'state');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function writeJSONL(records: unknown[]): Promise<string> {
    const path = join(tempDir, 'session.jsonl');
    const content = records.map((r) => JSON.stringify(r)).join('\n');
    return writeFile(path, content, 'utf-8').then(() => path);
  }

  const userRecord = {
    type: 'user',
    message: { role: 'user', content: 'Help me with this' },
    timestamp: '2026-04-11T14:30:00.000Z',
    sessionId: 'test-session-123',
    cwd: '/tmp/project',
    version: '2.1.101',
  };

  const assistantRecord = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Sure, let me help.' }],
    },
    timestamp: '2026-04-11T14:30:05.000Z',
    sessionId: 'test-session-123',
  };

  it('exports a valid session', async () => {
    const jsonlPath = await writeJSONL([userRecord, assistantRecord]);
    const result = await exportSessionToRaw(jsonlPath, stateDir);

    expect(result.exported).toBe(true);
    expect(result.sessionId).toBe('test-session-123');
    expect(result.stagingPath).toBeDefined();

    // Verify the staging file exists and contains expected content
    const content = await readFile(result.stagingPath!, 'utf-8');
    expect(content).toContain('Claude Code Session');
    expect(content).toContain('Help me with this');
    expect(content).toContain('Sure, let me help.');
  });

  it('skips already exported sessions', async () => {
    const jsonlPath = await writeJSONL([userRecord, assistantRecord]);

    const result1 = await exportSessionToRaw(jsonlPath, stateDir);
    expect(result1.exported).toBe(true);

    const result2 = await exportSessionToRaw(jsonlPath, stateDir);
    expect(result2.exported).toBe(false);
    expect(result2.reason).toBe('already exported');
  });

  it('skips trivial sessions with too few turns', async () => {
    // Only one user prompt, no assistant response
    const jsonlPath = await writeJSONL([userRecord]);
    const result = await exportSessionToRaw(jsonlPath, stateDir);

    expect(result.exported).toBe(false);
    expect(result.reason).toContain('too few turns');
  });

  it('respects custom minTurns', async () => {
    const jsonlPath = await writeJSONL([userRecord, assistantRecord]);

    // Require 5 real turns — this session only has 2
    const result = await exportSessionToRaw(jsonlPath, stateDir, { minTurns: 5 });
    expect(result.exported).toBe(false);
    expect(result.reason).toContain('too few turns');
  });

  it('handles sessions with no session ID', async () => {
    const noIdRecord = { ...userRecord, sessionId: undefined };
    const jsonlPath = await writeJSONL([noIdRecord]);
    const result = await exportSessionToRaw(jsonlPath, stateDir);

    expect(result.exported).toBe(false);
    expect(result.reason).toContain('no session ID');
  });
});

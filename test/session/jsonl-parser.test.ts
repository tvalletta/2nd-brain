import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSessionJSONL } from '../../src/session/jsonl-parser.js';

describe('JSONL Parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-jsonl-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function writeJSONL(filename: string, records: unknown[]): Promise<string> {
    const path = join(tempDir, filename);
    const content = records.map((r) => JSON.stringify(r)).join('\n');
    return writeFile(path, content, 'utf-8').then(() => path);
  }

  const baseUserRecord = {
    type: 'user',
    message: { role: 'user', content: 'Hello, help me fix a bug' },
    timestamp: '2026-04-11T14:30:00.000Z',
    sessionId: 'abc12345-0000-0000-0000-000000000000',
    cwd: '/tmp/test-project',
    gitBranch: 'main',
    version: '2.1.101',
  };

  const baseAssistantRecord = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me investigate that bug for you.' },
      ],
    },
    timestamp: '2026-04-11T14:30:05.000Z',
    sessionId: 'abc12345-0000-0000-0000-000000000000',
  };

  it('parses a minimal valid session', async () => {
    const path = await writeJSONL('session.jsonl', [baseUserRecord, baseAssistantRecord]);
    const session = await parseSessionJSONL(path);

    expect(session.sessionId).toBe('abc12345-0000-0000-0000-000000000000');
    expect(session.cwd).toBe('/tmp/test-project');
    expect(session.gitBranch).toBe('main');
    expect(session.version).toBe('2.1.101');
    expect(session.startedAt).toBe('2026-04-11T14:30:00.000Z');
    expect(session.endedAt).toBe('2026-04-11T14:30:05.000Z');
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].type).toBe('user-prompt');
    expect(session.turns[0].content).toBe('Hello, help me fix a bug');
    expect(session.turns[1].type).toBe('assistant-text');
    expect(session.turns[1].content).toBe('Let me investigate that bug for you.');
  });

  it('skips file-history-snapshot records', async () => {
    const path = await writeJSONL('session.jsonl', [
      { type: 'file-history-snapshot', snapshot: {}, messageId: 'x' },
      baseUserRecord,
      baseAssistantRecord,
    ]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
  });

  it('skips system records', async () => {
    const path = await writeJSONL('session.jsonl', [
      baseUserRecord,
      { type: 'system', subtype: 'local_command', content: 'output', timestamp: '2026-04-11T14:30:01.000Z' },
      baseAssistantRecord,
    ]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
  });

  it('skips isMeta user records', async () => {
    const path = await writeJSONL('session.jsonl', [
      { ...baseUserRecord, isMeta: true, message: { role: 'user', content: 'meta stuff' } },
      baseUserRecord,
      baseAssistantRecord,
    ]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].content).toBe('Hello, help me fix a bug');
  });

  it('skips sidechain records', async () => {
    const path = await writeJSONL('session.jsonl', [
      baseUserRecord,
      { ...baseAssistantRecord, isSidechain: true },
      baseAssistantRecord,
    ]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
  });

  it('skips thinking blocks from assistant content', async () => {
    const assistantWithThinking = {
      ...baseAssistantRecord,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think about this very carefully...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    };
    const path = await writeJSONL('session.jsonl', [baseUserRecord, assistantWithThinking]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
    expect(session.turns[1].content).toBe('Here is my answer.');
  });

  it('extracts tool_use as summary lines', async () => {
    const assistantWithTool = {
      ...baseAssistantRecord,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          { type: 'text', text: 'I found the issue.' },
        ],
      },
    };
    const path = await writeJSONL('session.jsonl', [baseUserRecord, assistantWithTool]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(3);
    expect(session.turns[1].type).toBe('tool-use');
    expect(session.turns[1].toolName).toBe('Read');
    expect(session.turns[1].content).toContain('/src/app.ts');
    expect(session.turns[2].type).toBe('assistant-text');
  });

  it('skips /clear command records', async () => {
    const clearRecord = {
      ...baseUserRecord,
      message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' },
    };
    const path = await writeJSONL('session.jsonl', [clearRecord, baseUserRecord, baseAssistantRecord]);
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
  });

  it('caps user prompt content at 2000 chars', async () => {
    const longPrompt = 'x'.repeat(5000);
    const longRecord = {
      ...baseUserRecord,
      message: { role: 'user', content: longPrompt },
    };
    const path = await writeJSONL('session.jsonl', [longRecord, baseAssistantRecord]);
    const session = await parseSessionJSONL(path);
    expect(session.turns[0].content.length).toBe(2000);
  });

  it('handles empty JSONL file', async () => {
    const path = join(tempDir, 'empty.jsonl');
    await writeFile(path, '', 'utf-8');
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(0);
    expect(session.sessionId).toBe('');
  });

  it('handles malformed lines gracefully', async () => {
    const content = [
      JSON.stringify(baseUserRecord),
      'this is not valid json{{{',
      JSON.stringify(baseAssistantRecord),
    ].join('\n');
    const path = join(tempDir, 'malformed.jsonl');
    await writeFile(path, content, 'utf-8');
    const session = await parseSessionJSONL(path);
    expect(session.turns).toHaveLength(2);
  });

  it('summarizes Bash tool input with command', async () => {
    const assistantWithBash = {
      ...baseAssistantRecord,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
        ],
      },
    };
    const path = await writeJSONL('session.jsonl', [baseUserRecord, assistantWithBash]);
    const session = await parseSessionJSONL(path);
    expect(session.turns[1].content).toContain('pnpm test');
  });

  it('applies size budget on very large sessions', async () => {
    // Create a session with many turns that exceed 100KB
    const records: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      records.push({
        ...baseUserRecord,
        timestamp: `2026-04-11T14:${String(i).padStart(2, '0')}:00.000Z`,
        message: { role: 'user', content: 'A'.repeat(1500) },
      });
      records.push({
        ...baseAssistantRecord,
        timestamp: `2026-04-11T14:${String(i).padStart(2, '0')}:05.000Z`,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'B'.repeat(1500) }],
        },
      });
    }
    const path = await writeJSONL('large.jsonl', records);
    const session = await parseSessionJSONL(path);
    // Should have first 20 + omission marker + last 20 = 41 turns
    expect(session.turns.length).toBe(41);
    expect(session.turns[20].content).toContain('omitted for brevity');
  });
});

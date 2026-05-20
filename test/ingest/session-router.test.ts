import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { computeSessionRawPath } from '../../src/ingest/session-router.js';
import type { ParsedSession } from '../../src/session/jsonl-parser.js';

const HOME = homedir();

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: 'abc12345-def6-7890-abcd-ef1234567890',
    cwd: `${HOME}/dev/auth-redesign`,
    startedAt: '2026-04-13T10:00:00Z',
    endedAt: '2026-04-13T11:00:00Z',
    version: 'Claude Code 1.0',
    turns: [],
    ...overrides,
  };
}

describe('computeSessionRawPath', () => {
  it('routes Claude session to project directory', () => {
    const session = makeSession();
    const result = computeSessionRawPath(session, 'claude');
    expect(result.rawPath).toBe('raw/ai-conversations/claude/auth-redesign/2026-04-13-abc12345.md');
    expect(result.cwdClassification.category).toBe('project');
    expect(result.cwdClassification.slug).toBe('auth-redesign');
  });

  it('routes Cursor session to project directory', () => {
    const session = makeSession({
      cwd: `${HOME}/dev/frontend-app`,
      version: 'Cursor',
    });
    const result = computeSessionRawPath(session, 'cursor');
    expect(result.rawPath).toBe('raw/ai-conversations/cursor/frontend-app/2026-04-13-abc12345.md');
  });

  it('routes home directory sessions to _general', () => {
    const session = makeSession({ cwd: HOME });
    const result = computeSessionRawPath(session, 'claude');
    expect(result.rawPath).toContain('/_general/');
    expect(result.cwdClassification.category).toBe('general');
  });

  it('routes tmp directory sessions to _discovery', () => {
    const session = makeSession({ cwd: '/tmp/quick-test' });
    const result = computeSessionRawPath(session, 'claude');
    expect(result.rawPath).toContain('/_discovery/');
    expect(result.cwdClassification.category).toBe('discovery');
  });

  it('uses session start date in path', () => {
    const session = makeSession({ startedAt: '2026-01-15T08:30:00Z' });
    const result = computeSessionRawPath(session, 'claude');
    expect(result.rawPath).toContain('/2026-01-15-');
  });

  it('uses short session ID in filename', () => {
    const session = makeSession({
      sessionId: 'xyz78901-abc2-3456-defg-hi7890123456',
    });
    const result = computeSessionRawPath(session, 'cursor');
    expect(result.rawPath).toContain('-xyz78901.md');
  });

  it('handles empty cwd gracefully', () => {
    const session = makeSession({ cwd: '' });
    const result = computeSessionRawPath(session, 'claude');
    expect(result.rawPath).toBeDefined();
  });
});

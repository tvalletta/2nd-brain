import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { routeContent, isAIConversation, getAISource } from '../../src/ingest/content-router.js';

// Sample Claude Code session content
const CLAUDE_SESSION = `# Claude Code Session: 2026-04-13 (abc12345)

**Session ID:** abc12345-def6-7890-abcd-ef1234567890
**Date:** 2026-04-13T10:00:00Z — 2026-04-13T11:00:00Z
**Working directory:** \`/home/testuser/dev/auth-redesign\`
**Git branch:** main
**Source:** Claude Code 1.0

## Conversation

### Turn 1 — User

Help me add OIDC support to the auth service.

### Turn 2 — Assistant

I'll help you implement OIDC support. Let me start by examining the existing auth configuration.
`;

const CURSOR_SESSION = `# Cursor Session: 2026-04-13 (xyz78901)

**Session ID:** xyz78901-abc2-3456-defg-hi7890123456
**Date:** 2026-04-13T14:00:00Z — 2026-04-13T15:00:00Z
**Working directory:** \`/home/testuser/dev/frontend-app\`
**Source:** Cursor

## Conversation

### Turn 1 — User

Can you refactor the sidebar component?

### Turn 2 — Assistant

Sure, let me look at the current sidebar implementation.
`;

const MEETING_NOTES = `# Kickoff Meeting

## Attendees
- Alice Chen
- Bob Martinez

## Agenda
1. Sprint planning
2. Architecture review

## Action Items
- Alice to review PR #42
`;

describe('routeContent', () => {
  describe('AI conversation detection', () => {
    it('detects Claude Code sessions', () => {
      const result = routeContent('claude-session-2026-04-13.md', CLAUDE_SESSION);
      expect(result.category).toBe('ai-conversation-claude');
      expect(result.tier).toBe('deterministic');
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result.cwdClassification?.category).toBe('project');
      expect(result.cwdClassification?.slug).toBe('auth-redesign');
    });

    it('detects Cursor sessions', () => {
      const result = routeContent('cursor-session-2026-04-13.md', CURSOR_SESSION);
      expect(result.category).toBe('ai-conversation-cursor');
      expect(result.tier).toBe('deterministic');
      expect(result.cwdClassification?.slug).toBe('frontend-app');
    });

    it('extracts cwd from content when not in metadata', () => {
      const result = routeContent('session.md', CLAUDE_SESSION);
      expect(result.cwdClassification?.slug).toBe('auth-redesign');
    });

    it('uses metadata cwd when provided', () => {
      const result = routeContent('session.md', CLAUDE_SESSION, {
        cwd: `${homedir()}/Desktop`,
      });
      expect(result.cwdClassification?.category).toBe('general');
      expect(result.cwdClassification?.slug).toBe('_general');
    });

    it('does not classify non-session markdown as AI conversation', () => {
      const regularMarkdown = '# My Notes\n\nSome regular notes here.\n';
      const result = routeContent('notes.md', regularMarkdown);
      expect(result.category).not.toBe('ai-conversation-claude');
      expect(result.category).not.toBe('ai-conversation-cursor');
    });
  });

  describe('meeting notes detection', () => {
    it('detects meeting notes by path', () => {
      const result = routeContent('raw/plaud/2026-04-13.md', '# Some content');
      expect(result.category).toBe('meeting-notes');
    });

    it('detects meeting notes by content', () => {
      const result = routeContent('notes.md', MEETING_NOTES);
      expect(result.category).toBe('meeting-notes');
    });
  });

  describe('data files', () => {
    it('classifies CSV as data', () => {
      const result = routeContent('export.csv', 'col1,col2\na,b');
      expect(result.category).toBe('data');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies JSON as data', () => {
      const result = routeContent('config.json', '{"key": "value"}');
      expect(result.category).toBe('data');
    });
  });

  describe('code files', () => {
    it('classifies TypeScript as code-artifact', () => {
      const result = routeContent('app.ts', 'const x = 1;');
      expect(result.category).toBe('code-artifact');
      expect(result.confidence).toBe(1.0);
    });

    it('classifies Python as code-artifact', () => {
      const result = routeContent('main.py', 'print("hello")');
      expect(result.category).toBe('code-artifact');
    });
  });

  describe('document files', () => {
    it('classifies PDF as document', () => {
      const result = routeContent('report.pdf', '');
      expect(result.category).toBe('document');
    });
  });

  describe('unknown files', () => {
    it('returns unknown for unrecognized content', () => {
      const result = routeContent('file.png', '');
      expect(result.category).toBe('unknown');
      expect(result.confidence).toBe(0.0);
    });

    it('returns unknown for plain markdown without AI patterns', () => {
      const result = routeContent('article.md', '# Just an article\n\nSome text.');
      expect(result.category).toBe('unknown');
    });
  });

  describe('sourceType preservation', () => {
    it('preserves original source type', () => {
      const result = routeContent('data.csv', 'a,b,c');
      expect(result.sourceType).toBe('csv');
    });

    it('preserves markdown source type for AI conversations', () => {
      const result = routeContent('session.md', CLAUDE_SESSION);
      expect(result.sourceType).toBe('markdown');
    });
  });
});

describe('isAIConversation', () => {
  it('returns true for AI conversation categories', () => {
    expect(isAIConversation('ai-conversation-claude')).toBe(true);
    expect(isAIConversation('ai-conversation-cursor')).toBe(true);
  });

  it('returns false for other categories', () => {
    expect(isAIConversation('meeting-notes')).toBe(false);
    expect(isAIConversation('document')).toBe(false);
    expect(isAIConversation('unknown')).toBe(false);
  });
});

describe('getAISource', () => {
  it('returns source for AI categories', () => {
    expect(getAISource('ai-conversation-claude')).toBe('claude');
    expect(getAISource('ai-conversation-cursor')).toBe('cursor');
  });

  it('returns null for non-AI categories', () => {
    expect(getAISource('meeting-notes')).toBeNull();
    expect(getAISource('unknown')).toBeNull();
  });
});

import type { ParsedSession, SessionTurn } from './jsonl-parser.js';

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    return iso.slice(11, 19); // HH:MM:SS from ISO
  } catch {
    return '';
  }
}

function turnLabel(turn: SessionTurn): string {
  switch (turn.type) {
    case 'user-prompt': return 'User';
    case 'assistant-text': return 'Assistant';
    case 'tool-use': return 'Tool';
  }
}

export function formatSessionMarkdown(session: ParsedSession): string {
  const shortId = session.sessionId.slice(0, 8);
  const date = session.startedAt.slice(0, 10);
  const isCursor = session.version === 'Cursor';
  const source = isCursor ? 'Cursor' : 'Claude Code';
  const lines: string[] = [];

  lines.push(`# ${source} Session: ${date} (${shortId})`);
  lines.push('');
  lines.push(`**Session ID:** ${session.sessionId}`);
  lines.push(`**Date:** ${session.startedAt} — ${session.endedAt}`);
  lines.push(`**Working directory:** \`${session.cwd}\``);
  if (session.gitBranch) {
    lines.push(`**Git branch:** ${session.gitBranch}`);
  }
  if (session.version) {
    lines.push(`**Source:** ${session.version}`);
  }
  lines.push('');
  lines.push('## Conversation');
  lines.push('');

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];
    const time = formatTime(turn.timestamp);
    const timeStr = time ? ` (${time})` : '';
    const label = turnLabel(turn);

    lines.push(`### Turn ${i + 1} — ${label}${timeStr}`);
    lines.push('');
    lines.push(turn.content);
    lines.push('');
  }

  return lines.join('\n');
}

export function sessionExportFilename(session: ParsedSession): string {
  const date = session.startedAt.slice(0, 10);
  const shortId = session.sessionId.slice(0, 8);
  const prefix = session.version === 'Cursor' ? 'cursor-session' : 'claude-session';
  return `${prefix}-${date}-${shortId}.md`;
}

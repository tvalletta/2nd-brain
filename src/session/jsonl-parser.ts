import { readFile } from 'node:fs/promises';
import { createLogger } from '../shared/logger.js';

const log = createLogger('jsonl-parser');

const MAX_PROMPT_CHARS = 2000;
const MAX_TOOL_SUMMARY_CHARS = 150;
const MAX_EXPORT_BYTES = 100_000;
const KEEP_TURNS_EACH_END = 20;

export interface ParsedSession {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  startedAt: string;
  endedAt: string;
  version: string;
  turns: SessionTurn[];
}

export interface SessionTurn {
  timestamp: string;
  type: 'user-prompt' | 'assistant-text' | 'tool-use';
  content: string;
  toolName?: string;
}

interface RawRecord {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function summarizeToolInput(input: Record<string, unknown>): string {
  if (input.file_path) return String(input.file_path);
  if (input.command) return String(input.command).slice(0, MAX_TOOL_SUMMARY_CHARS);
  if (input.pattern) return String(input.pattern);
  if (input.prompt) return String(input.prompt).slice(0, MAX_TOOL_SUMMARY_CHARS);
  if (input.description) return String(input.description).slice(0, MAX_TOOL_SUMMARY_CHARS);
  const keys = Object.keys(input).slice(0, 3).join(', ');
  return keys ? `{${keys}}` : '';
}

function extractUserContent(content: string | ContentBlock[]): string | null {
  if (typeof content === 'string') {
    // Skip /clear and other bare commands
    if (/^<command-name>/.test(content.trim())) return null;
    return content.slice(0, MAX_PROMPT_CHARS);
  }
  // Array content — extract text blocks only (skip tool_result blocks)
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  const joined = parts.join('\n');
  return joined.length > 0 ? joined.slice(0, MAX_PROMPT_CHARS) : null;
}

function extractAssistantTurns(content: ContentBlock[], timestamp: string): SessionTurn[] {
  const turns: SessionTurn[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      turns.push({ timestamp, type: 'assistant-text', content: block.text });
    } else if (block.type === 'tool_use' && block.name) {
      const summary = block.input ? summarizeToolInput(block.input) : '';
      turns.push({
        timestamp,
        type: 'tool-use',
        content: summary ? `**${block.name}** — ${summary}` : `**${block.name}**`,
        toolName: block.name,
      });
    }
    // Skip 'thinking' blocks entirely
  }

  return turns;
}

export async function parseSessionJSONL(filePath: string): Promise<ParsedSession> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  let sessionId = '';
  let cwd = '';
  let gitBranch: string | undefined;
  let version = '';
  let startedAt = '';
  let endedAt = '';
  const turns: SessionTurn[] = [];

  for (const line of lines) {
    let record: RawRecord;
    try {
      record = JSON.parse(line) as RawRecord;
    } catch {
      log.debug('Skipping unparseable JSONL line');
      continue;
    }

    // Skip non-message records
    if (record.type === 'file-history-snapshot') continue;
    if (record.type === 'system') continue;
    if (record.isMeta) continue;
    if (record.isSidechain) continue;

    // Extract metadata from first real record
    const ts = record.timestamp ?? '';
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;

    if (!sessionId && record.sessionId) sessionId = record.sessionId;
    if (!cwd && record.cwd) cwd = record.cwd;
    if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch;
    if (!version && record.version) version = record.version;

    if (record.type === 'user' && record.message?.content != null) {
      const text = extractUserContent(record.message.content as string | ContentBlock[]);
      if (text) {
        turns.push({ timestamp: ts, type: 'user-prompt', content: text });
      }
    } else if (record.type === 'assistant' && record.message?.content != null) {
      const content = record.message.content;
      if (Array.isArray(content)) {
        turns.push(...extractAssistantTurns(content as ContentBlock[], ts));
      }
    }
  }

  // Apply size budget — if too large, keep first N and last N turns
  const totalSize = turns.reduce((sum, t) => sum + t.content.length, 0);
  if (totalSize > MAX_EXPORT_BYTES && turns.length > KEEP_TURNS_EACH_END * 2) {
    const head = turns.slice(0, KEEP_TURNS_EACH_END);
    const tail = turns.slice(-KEEP_TURNS_EACH_END);
    const omitted = turns.length - KEEP_TURNS_EACH_END * 2;
    const marker: SessionTurn = {
      timestamp: '',
      type: 'assistant-text',
      content: `*[${omitted} turns omitted for brevity]*`,
    };
    return {
      sessionId,
      cwd,
      gitBranch,
      startedAt,
      endedAt,
      version,
      turns: [...head, marker, ...tail],
    };
  }

  return { sessionId, cwd, gitBranch, startedAt, endedAt, version, turns };
}

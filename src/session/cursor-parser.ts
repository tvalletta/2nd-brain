import Database from 'better-sqlite3';
import type { ParsedSession, SessionTurn } from './jsonl-parser.js';

const MAX_PROMPT_CHARS = 2000;
const MAX_TOOL_SUMMARY_CHARS = 150;
const MAX_EXPORT_BYTES = 100_000;
const KEEP_TURNS_EACH_END = 20;

interface CursorMeta {
  agentId: string;
  latestRootBlobId?: string;
  name?: string;
  mode?: string;
  createdAt?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  toolName?: string;
  toolCallId?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: unknown;
}

function extractUserQuery(content: string): string | null {
  // Extract <user_query> content if present
  const match = content.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (match) return match[1].trim().slice(0, MAX_PROMPT_CHARS);
  // Skip system-injected user messages (user_info only, no real query)
  if (content.trim().startsWith('<user_info>') && !content.includes('<user_query>')) return null;
  return content.slice(0, MAX_PROMPT_CHARS);
}

function extractWorkspacePath(content: string): string | undefined {
  const match = content.match(/Workspace Path:\s*(.+?)(?:\n|$)/);
  return match ? match[1].trim() : undefined;
}

function extractAssistantTurns(content: ContentBlock[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    } else if (block.type === 'redacted-reasoning' || block.type === 'thinking') {
      // Skip thinking/reasoning blocks
    } else if ((block.type === 'tool-use' || block.type === 'tool-call') && (block.toolName || block.name)) {
      const toolName = block.toolName ?? block.name ?? '?';
      let summary = '';
      if (block.input) {
        if (block.input.file_path) summary = String(block.input.file_path);
        else if (block.input.command) summary = String(block.input.command).slice(0, MAX_TOOL_SUMMARY_CHARS);
        else if (block.input.pattern) summary = String(block.input.pattern);
      }
      turns.push({
        timestamp: '',
        type: 'tool-use',
        content: summary ? `**${toolName}** — ${summary}` : `**${toolName}**`,
        toolName,
      });
    }
  }

  if (textParts.length > 0) {
    turns.unshift({
      timestamp: '',
      type: 'assistant-text',
      content: textParts.join('\n'),
    });
  }

  return turns;
}

function extractToolResultSummary(content: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'tool-result' && block.toolName) {
      parts.push(`[result: ${block.toolName}]`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

export async function parseCursorChat(dbPath: string): Promise<ParsedSession> {
  const db = new Database(dbPath, { readonly: true });

  // Read meta
  let meta: CursorMeta;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value: string } | undefined;
    if (!row) {
      db.close();
      return emptyCursorSession();
    }
    meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf-8')) as CursorMeta;
  } catch {
    db.close();
    return emptyCursorSession();
  }

  // Read all blobs, extract JSON messages
  const rows = db.prepare('SELECT id, data FROM blobs').all() as Array<{ id: string; data: Buffer }>;
  db.close();

  const messages: Array<{ id: string; role: string; content: string | ContentBlock[] }> = [];
  for (const row of rows) {
    const raw = row.data;
    try {
      const parsed = JSON.parse(raw.toString('utf-8')) as {
        role?: string;
        content?: string | ContentBlock[];
      };
      if (parsed.role && parsed.content != null) {
        messages.push({ id: row.id, role: parsed.role, content: parsed.content });
      }
    } catch {
      // Binary blob (protobuf tree node) — skip
    }
  }

  // Build turns from messages
  const turns: SessionTurn[] = [];
  let cwd = '';

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        // Extract workspace path from first user message
        if (!cwd) {
          cwd = extractWorkspacePath(msg.content) ?? '';
        }
        const text = extractUserQuery(msg.content);
        if (text) {
          turns.push({ timestamp: '', type: 'user-prompt', content: text });
        }
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            if (!cwd) cwd = extractWorkspacePath(block.text) ?? '';
            const text = extractUserQuery(block.text);
            if (text) {
              turns.push({ timestamp: '', type: 'user-prompt', content: text });
            }
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        turns.push(...extractAssistantTurns(msg.content as ContentBlock[]));
      } else if (typeof msg.content === 'string') {
        turns.push({ timestamp: '', type: 'assistant-text', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      // Tool results — just note which tools returned results
      if (Array.isArray(msg.content)) {
        const summary = extractToolResultSummary(msg.content as ContentBlock[]);
        if (summary) {
          // Don't add as separate turn — tool results are noisy
          // The tool-use turn from the assistant already captures the tool name
        }
      }
    }
  }

  // Convert createdAt timestamp to ISO
  const createdAt = meta.createdAt
    ? new Date(meta.createdAt).toISOString()
    : '';

  const sessionId = meta.agentId || '';

  // Apply size budget
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
      startedAt: createdAt,
      endedAt: createdAt,
      version: 'Cursor',
      turns: [...head, marker, ...tail],
    };
  }

  return {
    sessionId,
    cwd,
    startedAt: createdAt,
    endedAt: createdAt,
    version: 'Cursor',
    turns,
  };
}

function emptyCursorSession(): ParsedSession {
  return {
    sessionId: '',
    cwd: '',
    startedAt: '',
    endedAt: '',
    version: 'Cursor',
    turns: [],
  };
}

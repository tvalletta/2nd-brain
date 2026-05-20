// JSONL audit log for every MCP tool call.
//
// Written to .karpathy/logs/mcp-usage.jsonl — one JSON object per line.
// Use `cat .karpathy/logs/mcp-usage.jsonl | jq ...` to analyze.
//
// The log never throws; failures are silently swallowed so logging can
// never break a tool call.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface UsageEntry {
  ts: string;
  tool: string;
  /** Sanitized args — large content fields replaced with char count. */
  args: Record<string, unknown>;
  duration_ms: number;
  success: boolean;
  /** Length of items array if result was a JSON array. */
  result_count?: number;
  /** Total character length of the response text. */
  result_chars: number;
  error?: string;
}

/** Fields whose values may contain large content — truncated to char count. */
const LARGE_FIELDS = new Set(['content', 'body', 'text', 'raw', 'transcript', 'summary']);

export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (LARGE_FIELDS.has(k) && typeof v === 'string' && v.length > 200) {
      out[k] = `[${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Try to parse the result text as a JSON array and return its length. */
export function parseResultCount(text: string): number | undefined {
  if (!text.trimStart().startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

export async function appendUsageEntry(logPath: string, entry: UsageEntry): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Never let logging failures affect tool execution
  }
}

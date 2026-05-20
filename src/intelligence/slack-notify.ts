// D2: Slack notification + reply parsing.
//
// We use a fire-and-forget incoming webhook for outbound messages. Inbound
// approval replies are parsed by `parseSlackReply`, which the slack-reply
// hook (or the MCP `approve_research` tool) invokes.

import type { ResearchCandidate, ResearchDepth } from '../maintenance/research-queue.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('slack');

export interface SlackNotifyOptions {
  webhookUrl: string;
  channel?: string;
}

export function formatQueueDigest(args: {
  totalPending: number;
  topCandidates: ResearchCandidate[];
  queuePath: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `*Karpathy research queue* — ${args.totalPending} pending candidate${args.totalPending === 1 ? '' : 's'}.`,
  );
  if (args.topCandidates.length === 0) {
    lines.push('_No new candidates._');
  } else {
    lines.push(`Top ${Math.min(5, args.topCandidates.length)} by score:`);
    args.topCandidates.slice(0, 5).forEach((c, i) => {
      lines.push(
        `${i + 1}. *${c.title}* (${c.score.toFixed(2)}, suggested: ${c.suggested}) — ${c.reason}`,
      );
    });
    lines.push('');
    lines.push('Reply with picks: `1 heavy, 2 medium, 3 light, skip 4 5`');
  }
  lines.push(`Queue: \`${args.queuePath}\``);
  return lines.join('\n');
}

export async function sendSlackNotification(opts: SlackNotifyOptions, message: string): Promise<boolean> {
  if (!opts.webhookUrl) {
    log.info('No Slack webhook configured; skipping');
    return false;
  }
  try {
    const res = await fetch(opts.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, channel: opts.channel }),
    });
    if (!res.ok) {
      log.warn('Slack webhook returned non-2xx', { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('Slack send failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

export interface ParsedDecision {
  /** Slack reply forms accept either positional indices (1-based) or slugs. */
  match: { index?: number; slug?: string };
  depth: ResearchDepth;
}

/**
 * Parse a free-form Slack reply into a list of decisions.
 *
 * Supports forms (case-insensitive, comma-separated):
 *   `1 heavy, 2 medium, 3 light`
 *   `skip 4 5`
 *   `fsrs heavy, raptor medium`
 *   `1 heavy 2 medium` (whitespace-only)
 */
export function parseSlackReply(text: string): ParsedDecision[] {
  if (!text.trim()) return [];
  const out: ParsedDecision[] = [];
  // Tokenize into segments split by comma; within each segment, allow either
  // (token, depth) or (depth, token...).
  const segments = text.split(',').map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg
      .replace(/[.;!]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) continue;

    // Form A: leading depth keyword applies to the rest
    //   "skip 4 5"  → skip 4, skip 5
    //   "heavy 1 2" → heavy 1, heavy 2
    if (isDepth(tokens[0])) {
      const depth = tokens[0].toLowerCase() as ResearchDepth;
      for (const t of tokens.slice(1)) {
        const m = matchToken(t);
        if (m) out.push({ match: m, depth });
      }
      continue;
    }

    // Form B: pairs of (target, depth) or (target target depth) → all targets get depth
    let pendingTargets: string[] = [];
    for (const t of tokens) {
      if (isDepth(t)) {
        const depth = t.toLowerCase() as ResearchDepth;
        for (const tg of pendingTargets) {
          const m = matchToken(tg);
          if (m) out.push({ match: m, depth });
        }
        pendingTargets = [];
      } else {
        pendingTargets.push(t);
      }
    }
    // Trailing targets without depth → ignore.
  }
  return out;
}

function isDepth(s: string): boolean {
  return /^(light|medium|heavy|skip)$/i.test(s);
}

function matchToken(s: string): { index?: number; slug?: string } | null {
  if (/^\d+$/.test(s)) return { index: Number.parseInt(s, 10) };
  // Slug heuristic: alphanumeric / dash / underscore, length ≥ 2.
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(s) && s.length >= 2) return { slug: s.toLowerCase() };
  return null;
}

/** Apply parsed decisions to candidates list. Returns the updated candidates. */
export function applyDecisions(
  candidates: ResearchCandidate[],
  decisions: ParsedDecision[],
): ResearchCandidate[] {
  // Index in queue order (sorted by score desc).
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  for (const d of decisions) {
    let target: ResearchCandidate | undefined;
    if (d.match.index !== undefined) target = sorted[d.match.index - 1];
    else if (d.match.slug) target = candidates.find((c) => c.slug.toLowerCase() === d.match.slug);
    if (target) target.decision = d.depth;
  }
  return candidates;
}

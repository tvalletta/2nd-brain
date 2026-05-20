// Pins the most recent weekly digest's hot topics + top pending research
// candidates + recent meeting highlights + MCP usage audit stats into the
// hotcache so every Claude session sees them without having to ask.
//
// Four regions are written:
//   `hot-topics`       — top clusters from the latest digest (with links)
//   `research-pending` — top pending research candidates (with suggested depth)
//   `recent-meetings`  — last N meeting notes: date, title, key themes
//   `mcp-audit`        — live MCP usage stats + jq reminder
//
// Idempotent. Called from the rebuild-vault-artifacts job.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VaultAdapter } from '../vault/adapter.js';
import type { HotCacheManager } from '../session/hot-cache.js';
import { parseNote } from '../vault/frontmatter.js';
import { getProtectedRegion } from '../vault/protected-regions.js';
import { readResearchQueue, researchQueuePath } from '../maintenance/research-queue.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

const HOT_TOPICS_REGION = 'hot-topics';
const RESEARCH_PENDING_REGION = 'research-pending';
const MCP_AUDIT_REGION = 'mcp-audit';
const RECENT_MEETINGS_REGION = 'recent-meetings';
const MAX_HOT_TOPICS = 5;
const MAX_PENDING = 5;
const MAX_RECENT_MEETINGS = 3;

export interface HotCacheInjectionResult {
  digestPath: string | null;
  topicsWritten: number;
  pendingWritten: number;
  meetingsWritten: number;
}

export async function injectHotCache(
  vault: VaultAdapter,
  hotCache: HotCacheManager,
  layout: VaultLayout = DEFAULT_LAYOUT,
  projectRoot?: string,
): Promise<HotCacheInjectionResult> {
  const result: HotCacheInjectionResult = {
    digestPath: null,
    topicsWritten: 0,
    pendingWritten: 0,
    meetingsWritten: 0,
  };

  // 1. Hot topics from the most recent weekly digest.
  const topicsBlock = await formatHotTopics(vault, layout);
  if (topicsBlock) {
    await hotCache.updateRegion(HOT_TOPICS_REGION, topicsBlock.body);
    result.digestPath = topicsBlock.digestPath;
    result.topicsWritten = topicsBlock.count;
  } else {
    await hotCache.updateRegion(HOT_TOPICS_REGION, '_No weekly digest yet — run `karpathy intel digest`._');
  }

  // 2. Pending research candidates from the queue.
  const pendingBlock = await formatPendingResearch(vault, layout);
  await hotCache.updateRegion(RESEARCH_PENDING_REGION, pendingBlock.body);
  result.pendingWritten = pendingBlock.count;

  // 3. Recent meeting highlights — last N meeting notes from wiki/meetings/.
  const meetingsBlock = await formatRecentMeetings(vault, layout);
  await hotCache.updateRegion(RECENT_MEETINGS_REGION, meetingsBlock.body);
  result.meetingsWritten = meetingsBlock.count;

  // 4. MCP usage audit stats — live signal so the operator knows to review.
  if (projectRoot) {
    const auditBlock = await formatMCPAudit(projectRoot);
    await hotCache.updateRegion(MCP_AUDIT_REGION, auditBlock);
  }

  await hotCache.flush();
  return result;
}

interface HotTopicsBlock {
  body: string;
  digestPath: string;
  count: number;
}

async function formatHotTopics(
  vault: VaultAdapter,
  layout: VaultLayout,
): Promise<HotTopicsBlock | null> {
  if (!(await vault.exists(layout.digests))) return null;
  const files = (await vault.listMarkdownFiles(layout.digests))
    .filter((p) => !p.endsWith('/_index.md'))
    .sort()
    .reverse();
  if (files.length === 0) return null;

  const latest = files[0];
  const content = await vault.read(latest);
  const { body } = parseNote(content);

  // Extract `## ...` cluster headings + their leading line of trend metadata.
  // We don't try to parse the full body — the goal is a compact pin.
  const clusters: { heading: string; meta: string }[] = [];
  const sections = body.split(/^## /gm);
  for (const sec of sections.slice(1)) {
    const lines = sec.split('\n');
    const heading = lines[0]?.trim() ?? '';
    if (!heading) continue;
    // Find the meta line — the first italic line after the heading.
    let meta = '';
    for (const line of lines.slice(1, 6)) {
      const t = line.trim();
      if (t.startsWith('*') && t.endsWith('*')) {
        meta = t.replace(/^\*|\*$/g, '');
        break;
      }
    }
    clusters.push({ heading, meta });
    if (clusters.length >= MAX_HOT_TOPICS) break;
  }

  if (clusters.length === 0) return null;

  const week = latest.match(/(\d{4}-W\d{2})/)?.[1] ?? latest;
  const linkPath = latest.replace(/\.md$/, '');
  const lines: string[] = [`*Latest digest: [[${linkPath}|${week}]]*`, ''];
  for (const c of clusters) {
    lines.push(`- **${c.heading}**${c.meta ? ` — ${c.meta}` : ''}`);
  }
  return { body: lines.join('\n'), digestPath: latest, count: clusters.length };
}

interface PendingBlock {
  body: string;
  count: number;
}

async function formatPendingResearch(
  vault: VaultAdapter,
  layout: VaultLayout,
): Promise<PendingBlock> {
  const queue = await readResearchQueue(vault, layout);
  const pending = queue.candidates
    .filter((c) => c.status === 'pending' && !c.decision)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PENDING);

  if (pending.length === 0) {
    return { body: '_No pending research candidates._', count: 0 };
  }

  const lines: string[] = [
    `*${pending.length} candidate${pending.length === 1 ? '' : 's'} awaiting your call. Approve via \`approve_research\` MCP tool, \`karpathy intel approve\`, or by editing \`${researchQueuePath(layout)}\`.*`,
    '',
  ];
  pending.forEach((c, i) => {
    lines.push(`${i + 1}. **${c.title}** (${c.score.toFixed(2)}, suggested: ${c.suggested}) — ${c.reason}`);
  });
  return { body: lines.join('\n'), count: pending.length };
}

interface RecentMeetingsBlock {
  body: string;
  count: number;
}

async function formatRecentMeetings(
  vault: VaultAdapter,
  layout: VaultLayout,
): Promise<RecentMeetingsBlock> {
  const meetingsDir = `${layout.wiki}/meetings`;
  if (!(await vault.exists(meetingsDir))) {
    return { body: '_No meeting notes yet — run `karpathy reingest` to process Plaud transcripts._', count: 0 };
  }

  // Sort by embedded meeting date (p-YYYY-MM-DD- in filename), not ingestion date prefix
  const extractMeetingDate = (p: string): string => {
    const m = p.match(/\/p-(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : p.split('/').pop() ?? '';
  };

  // Scan more files than needed so we can skip placeholders and still fill the quota
  const files = (await vault.listMarkdownFiles(meetingsDir))
    .filter((p) => !p.endsWith('/_index.md'))
    .sort((a, b) => extractMeetingDate(b).localeCompare(extractMeetingDate(a)))
    .slice(0, MAX_RECENT_MEETINGS * 10);

  if (files.length === 0) {
    return { body: '_No meeting notes yet._', count: 0 };
  }

  const entries: string[] = [];

  for (const filePath of files) {
    try {
      const content = await vault.read(filePath);
      const { data } = parseNote(content);
      const title = (data.title as string) ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Meeting';
      const date = (data.meeting_date as string) ?? '';

      const keyThemes = getProtectedRegion(content, 'key-themes');
      const firstThemeLine = keyThemes
        ? keyThemes.split('\n').find((l) => l.trim() && l.trim() !== '(none)')?.trim() ?? ''
        : '';

      // Skip placeholder notes with no actual content
      if (!firstThemeLine || firstThemeLine.toLowerCase().startsWith('no substantive content')) continue;

      const linkPath = filePath.replace(/\.md$/, '');
      const label = date ? `${date} — ${title}` : title;
      entries.push(`- **[[${linkPath}|${label}]]**${firstThemeLine ? ` — ${firstThemeLine}` : ''}`);
      if (entries.length >= MAX_RECENT_MEETINGS) break;
    } catch {
      // skip unreadable meeting notes
    }
  }

  if (entries.length === 0) {
    return { body: '_No meeting notes with content yet._', count: 0 };
  }

  const lines = [`*${entries.length} recent meeting${entries.length === 1 ? '' : 's'}*`, '', ...entries];
  return { body: lines.join('\n'), count: entries.length };
}

async function formatMCPAudit(projectRoot: string): Promise<string> {
  const logPath = join(projectRoot, '.karpathy', 'logs', 'mcp-usage.jsonl');
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf-8');
  } catch {
    return '_No MCP usage log yet — log populates after first tool call._\n\n`cat .karpathy/logs/mcp-usage.jsonl | jq -r \'.tool\' | sort | uniq -c | sort -rn`';
  }

  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return '_No MCP usage log yet._';
  }

  let failures = 0;
  let zeroResults = 0;
  const toolCounts: Record<string, number> = {};

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        tool: string;
        success: boolean;
        result_count?: number;
      };
      toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;
      if (!entry.success) failures++;
      if (entry.result_count === 0) zeroResults++;
    } catch {
      // malformed line — skip
    }
  }

  const total = lines.length;
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => `${t} (${n})`)
    .join(', ');

  const parts: string[] = [
    `*${total} calls logged · ${failures} failures · ${zeroResults} zero-result searches*`,
    '',
    `Top tools: ${topTools}`,
    '',
    'Review: `cat .karpathy/logs/mcp-usage.jsonl | jq -r \'.tool\' | sort | uniq -c | sort -rn`',
    'Zero-result: `cat .karpathy/logs/mcp-usage.jsonl | jq \'select(.result_count == 0)\'`',
    'Failures: `cat .karpathy/logs/mcp-usage.jsonl | jq \'select(.success == false)\'`',
  ];

  return parts.join('\n');
}

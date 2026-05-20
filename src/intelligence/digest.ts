// B1: Weekly hot-topics digest.
//
// Pull all chunks indexed in the last `windowDays`, cluster them by cosine
// similarity, label each cluster with the LLM, classify trend by how this
// week's cluster size compares to the prior cycle's same cluster (when
// available), and write `wiki/digests/{ISO-week}.md`.
//
// Trend classification (BERTrend-lite):
//  - strong: this-week share ≥ 0.10 of all weekly chunks
//  - weak:   share between 0.04 and 0.10
//  - noise:  below 0.04 (dropped from output)

import { z } from 'zod';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { VaultAdapter } from '../vault/adapter.js';
import type { EmbeddingRow, EmbeddingStore } from '../embeddings/store.js';
import { clusterByCosine, representativeMembers } from './clustering.js';
import { isoWeek } from './iso-week.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

export interface DigestOptions {
  windowDays: number;
  minClusterSize: number;
  maxClusters: number;
  joinThreshold?: number;
  /** Override `now`; useful for tests. */
  nowMs?: number;
  /** Layout to resolve digest paths. Defaults to legacy layout. */
  layout?: VaultLayout;
}

export interface DigestCluster {
  id: number;
  size: number;
  share: number;
  trend: 'strong' | 'weak';
  label: string;
  summary: string;
  representativePaths: string[];
  topPaths: string[];
}

export interface DigestResult {
  isoWeek: string;
  windowFrom: string;
  windowTo: string;
  totalChunks: number;
  clusters: DigestCluster[];
  digestPath: string;
}

export interface DigestDeps {
  vault: VaultAdapter;
  llm: LLMClient;
  store: EmbeddingStore;
}

export async function runWeeklyDigest(
  deps: DigestDeps,
  options: DigestOptions,
): Promise<DigestResult> {
  const now = options.nowMs ?? Date.now();
  const windowMs = options.windowDays * 86400_000;
  const cutoff = now - windowMs;
  const cutoffIso = new Date(cutoff).toISOString();
  const nowIso = new Date(now).toISOString();

  const recent = deps.store.all((row) => new Date(row.updated_at).getTime() >= cutoff);
  const total = recent.length;

  // Cluster.
  const clusters = clusterByCosine(
    recent.map((r) => ({ id: `${r.doc_id}#${r.chunk_index}`, vector: r.vector, row: r })),
    {
      joinThreshold: options.joinThreshold ?? 0.55,
      minSize: options.minClusterSize,
      maxClusters: options.maxClusters,
    },
  );

  const labeled: DigestCluster[] = [];
  for (const c of clusters) {
    const share = total > 0 ? c.members.length / total : 0;
    const trend: 'strong' | 'weak' | 'noise' = share >= 0.1 ? 'strong' : share >= 0.04 ? 'weak' : 'noise';
    if (trend === 'noise') continue;

    const reps = representativeMembers(c, 5);
    const repRows = reps.map((m) => (m as unknown as { row: EmbeddingRow }).row);
    const labelObj = await labelCluster(deps.llm, repRows);
    labeled.push({
      id: c.id,
      size: c.members.length,
      share,
      trend,
      label: labelObj.label,
      summary: labelObj.summary,
      representativePaths: dedupe(repRows.map((r) => r.doc_id)),
      topPaths: dedupe(c.members.map((m) => (m as unknown as { row: EmbeddingRow }).row.doc_id)).slice(0, 10),
    });
  }

  const layout = options.layout ?? DEFAULT_LAYOUT;
  const digestsFolder = layout.digests;
  const week = isoWeek(new Date(now));
  const digestPath = `${digestsFolder}/${week}.md`;
  await deps.vault.ensureFolder(digestsFolder);
  await deps.vault.atomicWrite(
    digestPath,
    renderDigest({
      isoWeek: week,
      windowFrom: cutoffIso,
      windowTo: nowIso,
      totalChunks: total,
      clusters: labeled,
    }),
  );
  await rebuildDigestIndex(deps.vault, digestsFolder);

  await appendLogEntry(
    deps.vault,
    {
      kind: 'digest:weekly',
      message: `${week} — ${total} chunks → ${labeled.length} clusters`,
      at: nowIso,
    },
    layout,
  );

  return {
    isoWeek: week,
    windowFrom: cutoffIso,
    windowTo: nowIso,
    totalChunks: total,
    clusters: labeled,
    digestPath,
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

interface ClusterLabel {
  label: string;
  summary: string;
}

async function labelCluster(llm: LLMClient, rows: EmbeddingRow[]): Promise<ClusterLabel> {
  const samples = rows
    .map((r, i) => `${i + 1}. (${r.doc_id}) ${r.text.slice(0, 600)}`)
    .join('\n\n');
  const prompt = `You are labelling a cluster of related notes/transcripts from this week.

Sample chunks:
${samples}

Return STRICT JSON with these fields:
{
  "label": "short noun-phrase title (≤8 words) describing what the cluster is about",
  "summary": "2 sentences explaining what showed up in this cluster and why it matters"
}

Output ONLY the JSON object inside a single \`\`\`json code block.`;

  const Schema = z.object({
    label: z.string().transform((s) => s.slice(0, 80)),
    summary: z.string().transform((s) => s.slice(0, 500)),
  });
  try {
    return await llm.extractStructured(prompt, Schema);
  } catch {
    // Fallback: synthesize a label from the most-frequent tokens.
    return {
      label: synthFallbackLabel(rows),
      summary: rows[0]?.text.slice(0, 200) ?? '',
    };
  }
}

function synthFallbackLabel(rows: EmbeddingRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
  return top.length > 0 ? top.join(' / ') : 'Unlabeled cluster';
}

interface RenderInput {
  isoWeek: string;
  windowFrom: string;
  windowTo: string;
  totalChunks: number;
  clusters: DigestCluster[];
}

function renderDigest(d: RenderInput): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: index');
  lines.push(`title: Hot topics — ${d.isoWeek}`);
  lines.push(`created_at: ${d.windowTo}`);
  lines.push(`updated_at: ${d.windowTo}`);
  lines.push(`window_from: ${d.windowFrom}`);
  lines.push(`window_to: ${d.windowTo}`);
  lines.push(`total_chunks: ${d.totalChunks}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Hot topics — ${d.isoWeek}`);
  lines.push('');
  lines.push(
    `Window: \`${d.windowFrom.slice(0, 10)}\` → \`${d.windowTo.slice(0, 10)}\`. ${d.totalChunks} chunks, ${d.clusters.length} clusters.`,
  );
  lines.push('');
  for (const c of d.clusters) {
    const trendBadge = c.trend === 'strong' ? '🔥' : '〰️';
    lines.push(`## ${trendBadge} ${c.label}`);
    lines.push('');
    lines.push(`*${c.size} chunks · ${(c.share * 100).toFixed(1)}% share · ${c.trend} signal*`);
    lines.push('');
    lines.push(c.summary);
    lines.push('');
    lines.push('**Sources:**');
    for (const p of c.topPaths) lines.push(`- [[${p.replace(/\.md$/, '')}]]`);
    lines.push('');
  }
  return lines.join('\n');
}

async function rebuildDigestIndex(vault: VaultAdapter, folder: string): Promise<void> {
  if (!(await vault.exists(folder))) return;
  const files = (await vault.listMarkdownFiles(folder))
    .filter((p) => !p.endsWith('/_index.md'))
    .sort()
    .reverse();
  const lines: string[] = ['---', 'type: index', 'title: Weekly digests', '---', '', '# Weekly digests', ''];
  for (const f of files) {
    const slug = f.split('/').pop()?.replace(/\.md$/, '') ?? f;
    lines.push(`- [[${f.replace(/\.md$/, '')}|${slug}]]`);
  }
  await vault.atomicWrite(`${folder}/_index.md`, lines.join('\n'));
}

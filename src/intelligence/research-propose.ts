// D1: Gap detection + scoring.
//
// Walks the vault for research candidates and writes a stack-ranked queue.
// Six-signal `gap_score` per the intelligence-plan:
//   0.30 recency of mentions   (rolling window of session/transcript chunks)
//   0.20 frequency of mentions (last 14d)
//   0.15 active-project relevance
//   0.15 confidence gap (1 − confidence)
//   0.10 staleness (1 − retrievability)
//   0.10 domain heat (AI/ML topics get a small bump)
//
// Output: `wiki/_system/research-queue.md`. Existing user decisions are
// preserved on upsert. Auto-expire low-score entries past `autoExpireDays`.

import type { VaultAdapter } from '../vault/adapter.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { EmbeddingStore } from '../embeddings/store.js';
import { parseNote } from '../vault/frontmatter.js';
import {
  type ResearchCandidate,
  readResearchQueue,
  writeResearchQueue,
} from '../maintenance/research-queue.js';
import { retrievability, defaultStability } from '../vault/half-life.js';
import { appendLogEntry } from '../maintenance/vault-log.js';
import { layoutFromConfig } from '../vault/paths.js';

function scanFolders(layout: ReturnType<typeof layoutFromConfig>): string[] {
  return [`${layout.wiki}/concepts`, `${layout.wiki}/topics`];
}

const RECENT_WINDOW_DAYS = 14;
const AI_DOMAINS = new Set(['ai-research', 'tech-stack']);

interface MentionStats {
  count: number;
  mostRecentMs: number;
  inActiveProjects: boolean;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return '';
}

function asNumber(v: unknown, fallback?: number): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  return fallback;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export interface ProposeOptions {
  nowMs?: number;
}

export interface ProposeDeps {
  vault: VaultAdapter;
  config: KarpathyConfig;
  store: EmbeddingStore;
}

export interface ProposeResult {
  scanned: number;
  proposed: number;
  topCandidates: ResearchCandidate[];
}

export async function proposeResearch(deps: ProposeDeps, opts: ProposeOptions = {}): Promise<ProposeResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cap = deps.config.intelligence.research.queueCap;
  const expireDays = deps.config.intelligence.research.autoExpireDays;
  const expireBelow = deps.config.intelligence.research.autoExpireBelowScore;

  const layout = layoutFromConfig(deps.config);
  const existing = await readResearchQueue(deps.vault, layout);
  const existingMap = new Map(existing.candidates.map((c) => [c.slug, c]));

  // Pre-compute per-slug mention stats from the embedding store. We treat any
  // chunk whose text *contains the slug-as-a-token* (or the title) as a mention.
  const allRows = deps.store.all();
  const recentCutoff = nowMs - RECENT_WINDOW_DAYS * 86400_000;
  const activeProjects = await listActiveProjectSlugs(deps.vault, layout);

  const candidates: ResearchCandidate[] = [];
  let scanned = 0;

  for (const folder of scanFolders(layout)) {
    if (!(await deps.vault.exists(folder))) continue;
    const files = await deps.vault.listMarkdownFiles(folder);
    for (const path of files) {
      if (path.endsWith('/_index.md')) continue;
      scanned += 1;
      const raw = await deps.vault.read(path);
      const { data, body: _body } = parseNote(raw);
      const fm = data as Record<string, unknown>;
      const type = asString(fm.type);
      if (type !== 'concept' && type !== 'topic') continue;

      const slug = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
      const title = asString(fm.title) || slug;
      const aliases = Array.isArray(fm.aliases) ? (fm.aliases as string[]) : [];
      const lastVerified = asString(fm.last_verified) || asString(fm.updated_at);
      const stability =
        asNumber(fm.stability) ?? defaultStability((asString(fm.half_life_domain) as string) || type);
      const retr = retrievability({ lastVerifiedISO: lastVerified, stabilityDays: stability, nowMs });
      const confidence = asString(fm.confidence);
      const confidenceGap = confidence === 'low' ? 1 : confidence === 'medium' ? 0.5 : confidence === 'high' ? 0 : 0.7;
      const staleness = 1 - retr;
      const domain = asString(fm.half_life_domain) || (type === 'concept' ? 'concept' : 'topic');
      const domainHeat = AI_DOMAINS.has(domain) ? 1 : 0;

      const stats = mentionStats(allRows, [slug, title, ...aliases], recentCutoff, activeProjects);
      const recencyOfMentions =
        stats.mostRecentMs === 0
          ? 0
          : Math.exp(-Math.max(0, nowMs - stats.mostRecentMs) / (7 * 86400_000));
      const frequencyScore = clamp01(stats.count / 10); // 10 mentions saturates
      const projectRelevance = stats.inActiveProjects ? 1 : 0;

      const score =
        0.30 * recencyOfMentions +
        0.20 * frequencyScore +
        0.15 * projectRelevance +
        0.15 * confidenceGap +
        0.10 * staleness +
        0.10 * domainHeat;

      // Skip very-low-signal candidates entirely.
      if (score < 0.2 && stats.count === 0) continue;

      const reason = composeReason({
        stats,
        confidence,
        retr,
        recencyOfMentions,
      });
      const suggested =
        score >= 0.7 ? 'heavy' : score >= 0.45 ? 'medium' : 'light';

      const prior = existingMap.get(slug);
      candidates.push({
        slug,
        title,
        score: clamp01(score),
        reason,
        suggested: suggested as 'light' | 'medium' | 'heavy',
        decision: prior?.decision,
        // If user already approved a depth, mark pending if not yet executed.
        status: prior?.status === 'completed' ? 'completed' : 'pending',
        addedAt: prior?.addedAt ?? nowIso,
        completedAt: prior?.completedAt,
        completedDepth: prior?.completedDepth,
      });
    }
  }

  // Auto-expire low-score stale entries from the prior queue.
  for (const prior of existing.candidates) {
    if (candidates.find((c) => c.slug === prior.slug)) continue; // re-proposed → keep
    if (prior.status === 'completed') {
      // Keep completed rows for one-week visibility, then expire.
      if (prior.completedAt && nowMs - new Date(prior.completedAt).getTime() > 7 * 86400_000) {
        continue; // drop
      }
      candidates.push(prior);
      continue;
    }
    const ageDays = (nowMs - new Date(prior.addedAt).getTime()) / 86400_000;
    if (ageDays > expireDays && prior.score < expireBelow) {
      // expire
      continue;
    }
    candidates.push({ ...prior, status: prior.status });
  }

  // Cap.
  candidates.sort((a, b) => b.score - a.score);
  const trimmed = candidates.slice(0, cap);

  await writeResearchQueue(deps.vault, { candidates: trimmed }, layout);
  await appendLogEntry(
    deps.vault,
    {
      kind: 'research:propose',
      message: `${scanned} scanned → ${trimmed.length} in queue (${trimmed.filter((c) => c.status === 'pending').length} pending)`,
      at: nowIso,
    },
    layout,
  );

  return {
    scanned,
    proposed: trimmed.length,
    topCandidates: trimmed.slice(0, 10),
  };
}

function mentionStats(
  rows: ReturnType<EmbeddingStore['all']>,
  needles: string[],
  recentCutoff: number,
  activeProjects: Set<string>,
): MentionStats {
  const lowered = needles.filter(Boolean).map((n) => n.toLowerCase());
  let count = 0;
  let mostRecentMs = 0;
  let inActiveProjects = false;
  for (const row of rows) {
    const t = row.text.toLowerCase();
    let hit = false;
    for (const needle of lowered) {
      if (!needle) continue;
      // word-boundary-ish: avoid matching substrings of unrelated tokens.
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(t)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const ts = new Date(row.updated_at).getTime();
    if (ts < recentCutoff) continue;
    count += 1;
    if (ts > mostRecentMs) mostRecentMs = ts;
    const project = typeof row.metadata.project_slug === 'string' ? row.metadata.project_slug : undefined;
    if (project && activeProjects.has(project)) inActiveProjects = true;
  }
  return { count, mostRecentMs, inActiveProjects };
}

async function listActiveProjectSlugs(
  vault: VaultAdapter,
  layout: ReturnType<typeof layoutFromConfig>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const projectsDir = `${layout.wiki}/projects`;
  if (!(await vault.exists(projectsDir))) return out;
  const files = await vault.listMarkdownFiles(projectsDir);
  for (const f of files) {
    if (!f.endsWith('/_index.md')) continue;
    const raw = await vault.read(f);
    const { data } = parseNote(raw);
    const fm = data as Record<string, unknown>;
    const status = typeof fm.project_status === 'string' ? fm.project_status : 'active';
    if (status !== 'archived' && status !== 'inactive') {
      const slug = f.split('/').slice(-2, -1)[0];
      if (slug) out.add(slug);
    }
  }
  return out;
}

function composeReason(args: {
  stats: MentionStats;
  confidence: string;
  retr: number;
  recencyOfMentions: number;
}): string {
  const parts: string[] = [];
  if (args.stats.count > 0) {
    parts.push(`${args.stats.count} mention${args.stats.count === 1 ? '' : 's'} in last 14d`);
  }
  if (args.stats.inActiveProjects) parts.push('in active project');
  if (args.confidence === 'low') parts.push('low confidence');
  if (args.retr < 0.5) parts.push(`stale (R=${args.retr.toFixed(2)})`);
  if (parts.length === 0) parts.push('flagged for research');
  return parts.join('; ');
}

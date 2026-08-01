// C2: Vault rot diagnostic.
//
// Identifies notes that are likely dead weight: orphan + stale + low confidence.
// Writes a compact health report to `wiki/_system/vault-health.md`.

import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG, getProtectedRegion } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { REFRESH_TARGETS, isPlaceholderContent, type RefreshTarget } from './refresh-targets.js';
import { refreshArchiveQueue, type ArchiveCandidate } from '../maintenance/archive-queue.js';

/** Legacy: the default-layout path. Prefer `vaultHealthPath(layout)`. */
export const VAULT_HEALTH_PATH = `${DEFAULT_LAYOUT.system}/vault-health.md`;
/** Layout-aware path to the vault-health report. */
export function vaultHealthPath(layout: VaultLayout): string {
  return `${layout.system}/vault-health.md`;
}
const REGION_ID = 'vault-health';
const THIN_REGION_ID = 'vault-health-thin-content';
const BARE_IDENTITY_REGION_ID = 'vault-health-bare-identity';
const STALE_DRAFT_REGION_ID = 'vault-health-stale-drafts';

const STALE_DAYS = 180;
function scanFolders(layout: VaultLayout): string[] {
  return [
    `${layout.wiki}/concepts`,
    `${layout.wiki}/topics`,
    `${layout.wiki}/entities`,
    `${layout.wiki}/projects`,
    `${layout.wiki}/decisions`,
    `${layout.wiki}/tools`,
    `${layout.wiki}/organizations`,
  ];
}

export interface RotEntry {
  path: string;
  title: string;
  ageDays: number;
  confidence: string;
  hasInboundMarker: boolean;
  retrievability: number | undefined;
}

export interface ThinContentEntry {
  path: string;
  title: string;
  region: string;
}

export interface BareIdentityEntry {
  path: string;
  title: string;
}

export interface StaleDraftEntry {
  path: string;
  title: string;
  ageDays: number;
  ingestStatus: string;
}

export interface RotScanResult {
  scanned: number;
  candidates: RotEntry[];
  thinCandidates: ThinContentEntry[];
  bareIdentityCandidates: BareIdentityEntry[];
  staleDraftCandidates: StaleDraftEntry[];
  reportPath: string;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return '';
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

export interface RunRotScanOptions {
  nowMs?: number;
  layout?: VaultLayout;
  /** G1: age (days) past which a draft source_summary appears in the "Stale
   *  draft sources" table. Defaults to 14. This pass always runs — same
   *  unconditional precedent as the thin-content/bare-identity passes below,
   *  neither of which is gated behind a config flag either; only the
   *  threshold is configurable. */
  staleDraftReportDays?: number;
  /** G3: feed this scan's own rot candidates (unchanged stale+orphan+low-
   *  confidence rule) into the archive queue. Defaults to false so every
   *  pre-Sub-project-C call site (including every rot-scan test that
   *  predates this feature) sees no behavior change. */
  archiveQueueEnabled?: boolean;
}

async function scanStaleDraftSources(
  vault: VaultAdapter,
  layout: VaultLayout,
  nowMs: number,
  reportDays: number,
): Promise<StaleDraftEntry[]> {
  const entries: StaleDraftEntry[] = [];
  if (!(await vault.exists(layout.sources))) return entries;
  const files = await vault.listMarkdownFiles(layout.sources);
  for (const path of files) {
    if (path.endsWith('/_index.md')) continue;
    const raw = await vault.read(path);
    const { data } = parseNote(raw);
    const fm = data as Record<string, unknown>;
    if (asString(fm.type) !== 'source_summary') continue;
    if (asString(fm.status) !== 'draft') continue; // already active/archived/rejected — not our concern
    const createdAt = asString(fm.created_at);
    const ageDays = createdAt ? (nowMs - new Date(createdAt).getTime()) / 86_400_000 : Infinity;
    if (ageDays >= reportDays) {
      entries.push({
        path,
        title: asString(fm.title) || path,
        ageDays: Math.round(ageDays === Infinity ? 9999 : ageDays),
        ingestStatus: asString(fm.ingest_status) || 'unknown',
      });
    }
  }
  return entries.sort((a, b) => b.ageDays - a.ageDays);
}

export async function runRotScan(
  vault: VaultAdapter,
  optionsOrNowMs: RunRotScanOptions | number = {},
): Promise<RotScanResult> {
  // Back-compat: legacy callers passed `nowMs` as the second arg.
  const options: RunRotScanOptions =
    typeof optionsOrNowMs === 'number' ? { nowMs: optionsOrNowMs } : optionsOrNowMs;
  const nowMs = options.nowMs ?? Date.now();
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const healthPath = vaultHealthPath(layout);
  const candidates: RotEntry[] = [];
  const thinCandidates: ThinContentEntry[] = [];
  const bareIdentityCandidates: BareIdentityEntry[] = [];
  let scanned = 0;

  for (const folder of scanFolders(layout)) {
    if (!(await vault.exists(folder))) continue;
    const files = await vault.listMarkdownFiles(folder);
    for (const path of files) {
      if (path.endsWith('/_index.md')) continue;
      scanned += 1;
      const raw = await vault.read(path);
      const { data, body } = parseNote(raw);
      const fm = data as Record<string, unknown>;
      const updatedAt = asString(fm.updated_at) || asString(fm.created_at);
      const ageMs = updatedAt ? nowMs - new Date(updatedAt).getTime() : Infinity;
      const ageDays = ageMs === Infinity ? Infinity : ageMs / 86400_000;
      const stale = ageDays >= STALE_DAYS;
      const hasInboundMarker = /%% begin:backlinks %%[\s\S]*?\[\[/.test(body);
      const confidence = asString(fm.confidence);
      const isOrphan = !hasInboundMarker;
      const lowConf = confidence === 'low' || asString(fm.review_state) === 'rejected';

      // Three-out-of-four rule:
      // ✗ stale, ✗ orphan, ✗ low conf → rot.
      // ✗ stale, ✗ orphan → rot (the canonical case).
      const score = (stale ? 1 : 0) + (isOrphan ? 1 : 0) + (lowConf ? 1 : 0);
      if (score >= 2) {
        candidates.push({
          path,
          title: asString(fm.title) || path,
          ageDays: Math.round(ageDays === Infinity ? 9999 : ageDays),
          confidence: confidence || 'unknown',
          hasInboundMarker,
          retrievability: asNumber(fm.retrievability),
        });
      }

      const type = asString(fm.type);
      const target = (REFRESH_TARGETS as Record<string, RefreshTarget>)[type];
      if (target && isPlaceholderContent(target, getProtectedRegion(body, target.primaryRegion))) {
        thinCandidates.push({ path, title: asString(fm.title) || path, region: target.primaryRegion });
      }

      if (asString(fm.entity_kind) === 'person' && fm.identity_uncertain === true) {
        bareIdentityCandidates.push({ path, title: asString(fm.title) || path });
      }
    }
  }

  candidates.sort((a, b) => b.ageDays - a.ageDays);

  // G3: feed this scan's own rot candidates (unchanged stale+orphan+low-
  // confidence rule) into the archive queue for human resolution via
  // `karpathy archivist` / `resolve_archive_candidate`. Opt-in via options
  // so every pre-Sub-project-C call site (including every test in this file
  // predating this feature) sees no behavior change.
  if (options.archiveQueueEnabled && candidates.length > 0) {
    const archiveCandidates: ArchiveCandidate[] = candidates.map((c) => ({
      path: c.path,
      title: c.title,
      reason: `rot-scan: age ${c.ageDays}d, confidence ${c.confidence}, inbound ${c.hasInboundMarker ? 'yes' : 'no'}`,
      ageDays: c.ageDays,
      confidence: c.confidence,
      retrievability: c.retrievability,
    }));
    await refreshArchiveQueue(vault, archiveCandidates, layout);
  }

  // G1: stale-draft source scan — a separate folder (layout.sources) and a
  // separate note `type` (source_summary) from the wiki-content rot rule
  // above, which was tuned for curated pages, not never-processed stubs.
  const staleDraftCandidates = await scanStaleDraftSources(
    vault,
    layout,
    nowMs,
    options.staleDraftReportDays ?? 14,
  );

  await vault.ensureFolder(layout.system);
  await vault.atomicWrite(
    healthPath,
    renderReport(scanned, candidates, thinCandidates, bareIdentityCandidates, staleDraftCandidates, nowMs),
  );
  return { scanned, candidates, thinCandidates, bareIdentityCandidates, staleDraftCandidates, reportPath: healthPath };
}

function renderReport(
  scanned: number,
  candidates: RotEntry[],
  thinCandidates: ThinContentEntry[],
  bareIdentityCandidates: BareIdentityEntry[],
  staleDraftCandidates: StaleDraftEntry[],
  nowMs: number,
): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: index');
  lines.push('title: Vault health');
  lines.push(`updated_at: ${new Date(nowMs).toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push('# Vault health');
  lines.push('');
  lines.push(`Scanned ${scanned} notes. ${candidates.length} candidates flagged as potential rot.`);
  lines.push('');
  lines.push(OPEN_TAG(REGION_ID));
  if (candidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path | Age (days) | Confidence | Inbound | Retrievability |');
    lines.push('|------|-----------:|------------|---------|----------------|');
    for (const c of candidates) {
      const r = c.retrievability !== undefined ? c.retrievability.toFixed(2) : '—';
      lines.push(
        `| [[${c.path.replace(/\.md$/, '')}|${c.title}]] | ${c.ageDays} | ${c.confidence} | ${c.hasInboundMarker ? 'yes' : 'no'} | ${r} |`,
      );
    }
  }
  lines.push(CLOSE_TAG(REGION_ID));
  lines.push('');
  lines.push('## Thin content');
  lines.push('');
  lines.push(`${thinCandidates.length} notes have a placeholder or near-empty primary region.`);
  lines.push('');
  lines.push(OPEN_TAG(THIN_REGION_ID));
  if (thinCandidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path | Region |');
    lines.push('|------|--------|');
    for (const t of thinCandidates) {
      lines.push(`| [[${t.path.replace(/\.md$/, '')}|${t.title}]] | ${t.region} |`);
    }
  }
  lines.push(CLOSE_TAG(THIN_REGION_ID));
  lines.push('');
  lines.push('## Bare-identity person pages');
  lines.push('');
  lines.push(`${bareIdentityCandidates.length} person pages have a canonical name that is a bare first name or handle.`);
  lines.push('');
  lines.push(OPEN_TAG(BARE_IDENTITY_REGION_ID));
  if (bareIdentityCandidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path |');
    lines.push('|------|');
    for (const b of bareIdentityCandidates) {
      lines.push(`| [[${b.path.replace(/\.md$/, '')}|${b.title}]] |`);
    }
  }
  lines.push(CLOSE_TAG(BARE_IDENTITY_REGION_ID));
  lines.push('');
  lines.push('## Stale draft sources');
  lines.push('');
  lines.push(`${staleDraftCandidates.length} source_summary notes are still status: draft past the reporting threshold.`);
  lines.push('');
  lines.push(OPEN_TAG(STALE_DRAFT_REGION_ID));
  if (staleDraftCandidates.length === 0) {
    lines.push('_No candidates._');
  } else {
    lines.push('| Path | Age (days) | ingest_status |');
    lines.push('|------|-----------:|---------------|');
    for (const s of staleDraftCandidates) {
      lines.push(`| [[${s.path.replace(/\.md$/, '')}|${s.title}]] | ${s.ageDays} | ${s.ingestStatus} |`);
    }
  }
  lines.push(CLOSE_TAG(STALE_DRAFT_REGION_ID));
  lines.push('');
  return lines.join('\n');
}

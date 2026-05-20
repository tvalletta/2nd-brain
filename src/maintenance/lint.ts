import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
import { extractProtectedRegions } from '../vault/protected-regions.js';
import { slugify } from '../vault/paths.js';
import { buildGraph } from '../compilation/graph-builder.js';
import { buildEntityIndex, levenshtein } from '../ingest/entity-resolver.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('lint');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LintIssue {
  type:
    | 'orphan'
    | 'broken-link'
    | 'missing-link'
    | 'stale'
    | 'thin'
    | 'duplicate-candidate'
    | 'missing-entity';
  severity: 'info' | 'warning' | 'error';
  path: string;
  message: string;
  suggestedAction?: string;
  autoFixable: boolean;
}

export interface LintResult {
  issues: LintIssue[];
  autoFixed: number;
  scanned: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Root index files and category indexes that are expected to have no inbound links. */
const ROOT_WIKI_PAGES = new Set([
  'wiki/_index.md',
  'wiki/entities/_index.md',
  'wiki/projects/_index.md',
  'wiki/concepts/_index.md',
  'wiki/decisions/_index.md',
  'wiki/tools/_index.md',
  'wiki/topics/_index.md',
  'wiki/organizations/_index.md',
  'wiki/sources/_index.md',
  'wiki/sessions/_index.md',
]);

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const THIN_CONTENT_THRESHOLD = 50;

const PENDING_ENRICHMENT = 'Pending enrichment.';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function lintWiki(
  vault: VaultAdapter,
  options?: { autoFix?: boolean },
): Promise<LintResult> {
  const autoFix = options?.autoFix ?? false;
  const issues: LintIssue[] = [];
  let autoFixed = 0;

  // Build shared data structures once
  const [graph, entityIndex] = await Promise.all([
    buildGraph(vault),
    buildEntityIndex(vault),
  ]);

  const scanned = graph.nodes.size;
  log.info('Lint started', { scanned, autoFix });

  // --- 1. Orphan detection ---
  const orphanIssues = detectOrphans(graph);
  issues.push(...orphanIssues);

  // --- 2. Broken link detection ---
  const brokenLinkIssues = detectBrokenLinks(graph);
  issues.push(...brokenLinkIssues);

  // --- 3. Missing link detection (+ optional auto-fix) ---
  const { issues: missingLinkIssues, fixed } = await detectMissingLinks(
    vault,
    graph,
    entityIndex,
    autoFix,
  );
  issues.push(...missingLinkIssues);
  autoFixed += fixed;

  // --- 4. Stale page detection ---
  const staleIssues = await detectStalePages(vault, graph, entityIndex);
  issues.push(...staleIssues);

  // --- 5. Thin page detection ---
  const thinIssues = await detectThinPages(vault, graph);
  issues.push(...thinIssues);

  // --- 6. Duplicate candidate detection ---
  const dupIssues = detectDuplicateCandidates(entityIndex);
  issues.push(...dupIssues);

  // --- 7. Missing entity detection ---
  const missingEntityIssues = await detectMissingEntities(vault, graph, entityIndex);
  issues.push(...missingEntityIssues);

  // --- Summary ---
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.type] = (counts[issue.type] ?? 0) + 1;
  }
  log.info('Lint complete', { scanned, issueCount: issues.length, autoFixed, ...counts });

  return { issues, autoFixed, scanned };
}

// ---------------------------------------------------------------------------
// 1. Orphan detection
// ---------------------------------------------------------------------------

function detectOrphans(graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never): LintIssue[] {
  const { nodes, edges } = graph;
  const issues: LintIssue[] = [];

  // Count inbound links per node
  const inboundCounts = new Map<string, number>();
  for (const path of nodes.keys()) {
    inboundCounts.set(path, 0);
  }
  for (const edge of edges) {
    if (nodes.has(edge.target)) {
      inboundCounts.set(edge.target, (inboundCounts.get(edge.target) ?? 0) + 1);
    }
  }

  for (const [path, count] of inboundCounts) {
    if (count > 0) continue;
    if (path.endsWith('_index.md')) continue;
    if (ROOT_WIKI_PAGES.has(path)) continue;

    issues.push({
      type: 'orphan',
      severity: 'info',
      path,
      message: `Page has no inbound links.`,
      autoFixable: false,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 2. Broken link detection
// ---------------------------------------------------------------------------

function detectBrokenLinks(graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never): LintIssue[] {
  const { nodes, edges } = graph;
  const issues: LintIssue[] = [];

  for (const edge of edges) {
    if (!nodes.has(edge.target)) {
      issues.push({
        type: 'broken-link',
        severity: 'warning',
        path: edge.source,
        message: `Wikilink to "${edge.target}" points to a non-existent page.`,
        autoFixable: false,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 3. Missing link detection
// ---------------------------------------------------------------------------

async function detectMissingLinks(
  vault: VaultAdapter,
  graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never,
  entityIndex: EntityIndex,
  autoFix: boolean,
): Promise<{ issues: LintIssue[]; fixed: number }> {
  const { nodes } = graph;
  const issues: LintIssue[] = [];
  let fixed = 0;

  for (const [path, _node] of nodes) {
    const content = await vault.read(path);
    const { data, body } = parseNote(content);

    // Collect existing wikilink targets in this page
    const existingTargets = new Set<string>();
    let match;
    const re = new RegExp(WIKILINK_PATTERN.source, WIKILINK_PATTERN.flags);
    while ((match = re.exec(body)) !== null) {
      existingTargets.add(slugify(match[1].trim()));
    }

    // Track replacements to apply for auto-fix
    const replacements: Array<{ name: string; slug: string }> = [];

    for (const entry of entityIndex.allEntries) {
      // Don't suggest linking to self
      if (entry.path === path) continue;

      if (existingTargets.has(entry.slug)) continue;

      const namesToCheck = [entry.name, ...entry.aliases];
      for (const name of namesToCheck) {
        if (name.length < 3) continue;

        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
        if (pattern.test(body)) {
          issues.push({
            type: 'missing-link',
            severity: 'info',
            path,
            message: `Mention of "${name}" is not wikilinked.`,
            suggestedAction: `Replace "${name}" with [[${entry.slug}|${name}]]`,
            autoFixable: true,
          });
          replacements.push({ name, slug: entry.slug });
          // Only one report per entity per page
          break;
        }
      }
    }

    // Auto-fix: insert wikilinks for bare mentions
    if (autoFix && replacements.length > 0) {
      let updatedBody = body;
      for (const { name, slug } of replacements) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Only replace the first bare mention (not inside existing wikilinks)
        const replacePattern = new RegExp(`(?<!\\[\\[)\\b(${escaped})\\b(?![^\\[]*\\]\\])`, 'i');
        const before = updatedBody;
        updatedBody = updatedBody.replace(replacePattern, `[[${slug}|$1]]`);
        if (updatedBody !== before) {
          fixed++;
        }
      }

      if (updatedBody !== body) {
        // Reconstruct the full note with frontmatter and write it back
        const { serializeNote } = await import('../vault/frontmatter.js');
        const serialized = serializeNote(data, updatedBody);
        await vault.atomicWrite(path, serialized);
      }
    }
  }

  return { issues, fixed };
}

// ---------------------------------------------------------------------------
// 4. Stale page detection
// ---------------------------------------------------------------------------

async function detectStalePages(
  vault: VaultAdapter,
  _graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never,
  entityIndex: EntityIndex,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const now = Date.now();

  // We only care about entity-type pages (ones that have source_refs and updated_at)
  for (const entry of entityIndex.allEntries) {
    try {
      const content = await vault.read(entry.path);
      const { data } = parseNote(content);

      const updatedAt = data.updated_at as string | undefined;
      if (!updatedAt) continue;

      const sourceRefs = (data.source_refs as string[]) ?? [];
      if (sourceRefs.length === 0) continue;

      const updatedMs = new Date(updatedAt).getTime();
      if (isNaN(updatedMs)) continue;

      const age = now - updatedMs;
      if (age < STALE_THRESHOLD_MS) continue;

      // Check if any source ref was ingested after the page was last updated
      let hasNewerSource = false;
      for (const ref of sourceRefs) {
        try {
          const refPath = ref.endsWith('.md') ? ref : `${ref}.md`;
          if (!(await vault.exists(refPath))) continue;
          const refContent = await vault.read(refPath);
          const { data: refData } = parseNote(refContent);
          const refUpdated = refData.updated_at as string | undefined;
          if (!refUpdated) continue;
          const refUpdatedMs = new Date(refUpdated).getTime();
          if (!isNaN(refUpdatedMs) && refUpdatedMs > updatedMs) {
            hasNewerSource = true;
            break;
          }
        } catch {
          // Source ref may not resolve to a readable file
        }
      }

      if (hasNewerSource) {
        issues.push({
          type: 'stale',
          severity: 'warning',
          path: entry.path,
          message: `Page was last updated ${Math.floor(age / (24 * 60 * 60 * 1000))} days ago but has newer source material.`,
          suggestedAction: 'Recompile this entity page to incorporate new source data.',
          autoFixable: false,
        });
      }
    } catch (err) {
      log.warn('Failed stale check for entity', {
        path: entry.path,
        error: (err as Error).message,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 5. Thin page detection
// ---------------------------------------------------------------------------

async function detectThinPages(
  vault: VaultAdapter,
  graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const [path, node] of graph.nodes) {
    // Only check entity-like types that should have compiled content
    if (!['entity', 'project', 'concept', 'decision', 'tool', 'topic', 'organization'].includes(node.type)) {
      continue;
    }

    try {
      const content = await vault.read(path);
      const { data } = parseNote(content);

      const sourceRefs = (data.source_refs as string[]) ?? [];
      if (sourceRefs.length < 2) continue;

      const regions = extractProtectedRegions(content);
      let totalContent = 0;
      for (const region of regions) {
        // Skip backlinks region — not real "content"
        if (region.id === 'backlinks') continue;
        const cleaned = region.content.replace(PENDING_ENRICHMENT, '').trim();
        totalContent += cleaned.length;
      }

      if (totalContent < THIN_CONTENT_THRESHOLD) {
        issues.push({
          type: 'thin',
          severity: 'warning',
          path,
          message: `Page has ${sourceRefs.length} source refs but very little content (${totalContent} chars in protected regions).`,
          suggestedAction: 'Recompile this page — it likely needs enrichment.',
          autoFixable: false,
        });
      }
    } catch (err) {
      log.warn('Failed thin page check', {
        path,
        error: (err as Error).message,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 6. Duplicate candidate detection
// ---------------------------------------------------------------------------

function detectDuplicateCandidates(entityIndex: EntityIndex): LintIssue[] {
  const issues: LintIssue[] = [];
  const seen = new Set<string>();

  const entries = entityIndex.allEntries;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];

      // Only compare within the same folder
      const folderA = extractFolder(a.path);
      const folderB = extractFolder(b.path);
      if (folderA !== folderB) continue;

      const pairKey = [a.path, b.path].sort().join('::');
      if (seen.has(pairKey)) continue;

      const nameA = a.name.toLowerCase();
      const nameB = b.name.toLowerCase();
      const dist = levenshtein(nameA, nameB);

      if (dist > 0 && dist <= 2) {
        seen.add(pairKey);
        issues.push({
          type: 'duplicate-candidate',
          severity: 'warning',
          path: a.path,
          message: `Possible duplicate: "${a.name}" is very similar to "${b.name}" (${b.path}).`,
          suggestedAction: `Review whether these two pages should be merged.`,
          autoFixable: false,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 7. Missing entity detection
// ---------------------------------------------------------------------------

async function detectMissingEntities(
  vault: VaultAdapter,
  graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never,
  entityIndex: EntityIndex,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const knownEntitySlugs = new Set(entityIndex.allEntries.map((e) => e.slug));

  // Scan source_summary and session_summary pages for their "entities" protected regions
  for (const [path, node] of graph.nodes) {
    if (node.type !== 'source_summary' && node.type !== 'session_summary') continue;

    try {
      const content = await vault.read(path);
      const regions = extractProtectedRegions(content);
      const entitiesRegion = regions.find((r) => r.id === 'entities');
      if (!entitiesRegion) continue;

      // Parse entity names from the region (typically formatted as wikilinks or list items)
      const entityNames = extractEntityNamesFromRegion(entitiesRegion.content);

      for (const name of entityNames) {
        const slug = slugify(name);
        if (knownEntitySlugs.has(slug)) continue;

        // Also check by canonical name or alias in the index
        const normalized = name.toLowerCase().trim();
        let found = false;
        for (const entry of entityIndex.allEntries) {
          if (entry.name.toLowerCase() === normalized) {
            found = true;
            break;
          }
          if (entry.aliases.some((a) => a.toLowerCase() === normalized)) {
            found = true;
            break;
          }
        }
        if (found) continue;

        issues.push({
          type: 'missing-entity',
          severity: 'info',
          path,
          message: `Entity "${name}" is referenced but has no wiki page.`,
          suggestedAction: 'Run compilation to create a wiki page for this entity.',
          autoFixable: false,
        });
      }
    } catch (err) {
      log.warn('Failed missing entity check', {
        path,
        error: (err as Error).message,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract entity names from a protected region's content.
 * Handles common formats:
 *   - `[[slug|Name]]` or `[[slug]]`
 *   - `- Name (kind)` list items
 *   - `- **Name** — description`
 */
function extractEntityNamesFromRegion(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  // Extract from wikilinks: [[slug|Display Name]] or [[slug]]
  const wikiRe = new RegExp(WIKILINK_PATTERN.source, WIKILINK_PATTERN.flags);
  let m;
  while ((m = wikiRe.exec(content)) !== null) {
    const name = (m[2] ?? m[1]).trim();
    const lower = name.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      names.push(name);
    }
  }

  // Extract from list items without wikilinks: "- Name (kind)" or "- **Name**"
  const listRe = /^-\s+\*{0,2}([^*\n(]+)\*{0,2}/gm;
  while ((m = listRe.exec(content)) !== null) {
    const raw = m[1].trim();
    // Skip if it's a wikilink reference (already handled)
    if (raw.startsWith('[[')) continue;
    // Skip very short or clearly non-entity text
    if (raw.length < 2) continue;

    const lower = raw.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      names.push(raw);
    }
  }

  return names;
}

function extractFolder(path: string): string {
  const parts = path.split('/');
  parts.pop(); // remove filename
  return parts.join('/');
}

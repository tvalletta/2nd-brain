import type { VaultAdapter } from '../vault/adapter.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { parseNote } from '../vault/frontmatter.js';
import { slugify, WIKI_CONTENT_FOLDERS } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('graph-builder');

export interface GraphNode {
  path: string;
  title: string;
  type: string;
  entityKind?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

export interface WikiGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface GraphAnalysis {
  orphanPages: string[];
  brokenLinks: Array<{ source: string; target: string }>;
  missingLinks: Array<{ source: string; mention: string; suggestedTarget: string }>;
}

const WIKI_FOLDERS = WIKI_CONTENT_FOLDERS;

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Build an in-memory graph of all wiki pages and their wikilink relationships.
 */
export async function buildGraph(vault: VaultAdapter): Promise<WikiGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // Collect all markdown files from wiki folders
  const allFiles: string[] = [];
  for (const folder of WIKI_FOLDERS) {
    try {
      const files = await vault.listMarkdownFiles(folder);
      allFiles.push(...files);
    } catch {
      // Folder may not exist yet
    }
  }

  log.info('Building wiki graph', { fileCount: allFiles.length });

  // Build slug-to-path map for resolving wikilinks
  const slugToPath = new Map<string, string>();

  // First pass: create nodes and build slug index
  for (const filePath of allFiles) {
    try {
      const content = await vault.read(filePath);
      const { data, body } = parseNote(content);

      const title = (data.title as string) ?? extractFilename(filePath);
      const type = (data.type as string) ?? 'unknown';
      const entityKind = (data.entity_kind as string) ?? undefined;

      const node: GraphNode = { path: filePath, title, type, entityKind };
      nodes.set(filePath, node);

      // Index by slug (filename without extension)
      const slug = extractSlug(filePath);
      slugToPath.set(slug, filePath);

      // Also index by slugified title for resolution
      const titleSlug = slugify(title);
      if (!slugToPath.has(titleSlug)) {
        slugToPath.set(titleSlug, filePath);
      }

      // Index aliases
      const aliases = (data.aliases as string[]) ?? [];
      for (const alias of aliases) {
        const aliasSlug = slugify(alias);
        if (!slugToPath.has(aliasSlug)) {
          slugToPath.set(aliasSlug, filePath);
        }
      }

      // Extract wikilinks from body
      const links = extractWikilinks(body);
      for (const link of links) {
        const targetSlug = slugify(link.target);
        edges.push({
          source: filePath,
          target: targetSlug, // Temporarily store slug; resolve in second pass
          label: link.displayText,
        });
      }
    } catch (err) {
      log.warn('Failed to process file for graph', {
        path: filePath,
        error: (err as Error).message,
      });
    }
  }

  // Second pass: resolve edge target slugs to actual paths
  const resolvedEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const targetPath = slugToPath.get(edge.target);
    if (targetPath) {
      resolvedEdges.push({
        source: edge.source,
        target: targetPath,
        label: edge.label,
      });
    } else {
      // Keep the edge with the slug as target (will show as broken link)
      resolvedEdges.push(edge);
    }
  }

  log.info('Wiki graph built', {
    nodeCount: nodes.size,
    edgeCount: resolvedEdges.length,
  });

  return { nodes, edges: resolvedEdges };
}

/**
 * Analyze the graph for quality issues: orphan pages, broken links,
 * and unlinked entity mentions.
 */
export async function analyzeGraph(
  graph: WikiGraph,
  vault: VaultAdapter,
  entityIndex: EntityIndex,
): Promise<GraphAnalysis> {
  const { nodes, edges } = graph;

  log.info('Analyzing wiki graph', {
    nodeCount: nodes.size,
    edgeCount: edges.length,
  });

  // 1. Compute inbound link counts to find orphan pages
  const inboundCounts = new Map<string, number>();
  for (const node of nodes.keys()) {
    inboundCounts.set(node, 0);
  }

  for (const edge of edges) {
    if (nodes.has(edge.target)) {
      inboundCounts.set(edge.target, (inboundCounts.get(edge.target) ?? 0) + 1);
    }
  }

  const orphanPages: string[] = [];
  for (const [path, count] of inboundCounts) {
    if (count === 0 && !path.endsWith('_index.md')) {
      orphanPages.push(path);
    }
  }

  // 2. Find broken links (edges to non-existent pages)
  const brokenLinks: Array<{ source: string; target: string }> = [];
  for (const edge of edges) {
    if (!nodes.has(edge.target)) {
      brokenLinks.push({ source: edge.source, target: edge.target });
    }
  }

  // 3. Find missing links (unlinked entity mentions)
  const missingLinks: Array<{ source: string; mention: string; suggestedTarget: string }> = [];

  for (const [path, _node] of nodes) {
    try {
      const content = await vault.read(path);
      const { body } = parseNote(content);

      // Get all existing wikilink targets in this page
      const existingTargets = new Set<string>();
      const linkMatches = extractWikilinks(body);
      for (const link of linkMatches) {
        existingTargets.add(slugify(link.target));
      }

      // Check each known entity
      for (const entry of entityIndex.allEntries) {
        // Don't suggest linking to self
        if (entry.path === path) continue;

        const entrySlug = entry.slug;
        if (existingTargets.has(entrySlug)) continue;

        // Check if the entity name or any alias appears in the body
        const namesToCheck = [entry.name, ...entry.aliases];
        for (const name of namesToCheck) {
          if (name.length < 3) continue;

          // Case-insensitive search for the name as a whole word
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
          if (pattern.test(body)) {
            missingLinks.push({
              source: path,
              mention: name,
              suggestedTarget: entry.path,
            });
            // Only report one missing link per entity per page
            break;
          }
        }
      }
    } catch (err) {
      log.warn('Failed to analyze page for missing links', {
        path,
        error: (err as Error).message,
      });
    }
  }

  log.info('Graph analysis complete', {
    orphanPages: orphanPages.length,
    brokenLinks: brokenLinks.length,
    missingLinks: missingLinks.length,
  });

  return { orphanPages, brokenLinks, missingLinks };
}

// --- Helpers ---

interface WikilinkMatch {
  target: string;
  displayText?: string;
}

function extractWikilinks(body: string): WikilinkMatch[] {
  const links: WikilinkMatch[] = [];
  const re = new RegExp(WIKILINK_PATTERN.source, WIKILINK_PATTERN.flags);
  let match;
  while ((match = re.exec(body)) !== null) {
    links.push({
      target: match[1].trim(),
      displayText: match[2]?.trim(),
    });
  }
  return links;
}

function extractSlug(filePath: string): string {
  return filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
}

function extractFilename(filePath: string): string {
  return filePath.split('/').pop()?.replace(/\.md$/, '') ?? filePath;
}

import { nanoid } from 'nanoid';
import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:cross-project-patterns');

interface EntityReference {
  name: string;
  kind: string;
  projects: Set<string>;
}

/**
 * Maintenance job that identifies shared patterns across projects.
 *
 * Detects:
 * 1. Entities referenced by 3+ projects (shared technologies, people, concepts)
 * 2. Shared technology stacks (tools/frameworks appearing across projects)
 *
 * Writes insight pages to wiki/insights/.
 */
export const detectCrossProjectPatternsHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const { vault } = context;

    const wiki = context.config.layout.wiki;

    // 1. Build cross-project entity index
    let allProjectFiles: string[];
    try {
      allProjectFiles = await vault.listMarkdownFiles(`${wiki}/projects`);
    } catch {
      log.info('No project files found');
      return;
    }

    // Map: entity name -> { kind, projects }
    const entityIndex = new Map<string, EntityReference>();

    for (const filePath of allProjectFiles) {
      // Extract project slug from path: wiki/projects/{slug}/...
      const parts = filePath.split('/');
      if (parts.length < 4) continue;
      const projectSlug = parts[2];

      try {
        const content = await vault.read(filePath);
        const { data } = parseNote(content);

        // Extract wikilinks from content
        const wikilinks = extractWikilinks(content);
        for (const link of wikilinks) {
          const key = link.toLowerCase();
          if (!entityIndex.has(key)) {
            entityIndex.set(key, { name: link, kind: 'unknown', projects: new Set() });
          }
          entityIndex.get(key)!.projects.add(projectSlug);
        }

        // Also check links from frontmatter
        const links = (data.links as string[]) ?? [];
        for (const link of links) {
          const key = link.toLowerCase();
          if (!entityIndex.has(key)) {
            entityIndex.set(key, { name: link, kind: 'unknown', projects: new Set() });
          }
          entityIndex.get(key)!.projects.add(projectSlug);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // 2. Resolve entity kinds from wiki pages
    for (const [key, ref] of entityIndex) {
      for (const folder of [`${wiki}/concepts`, `${wiki}/tools`, `${wiki}/people`, `${wiki}/topics`, `${wiki}/organizations`]) {
        const kind = folder.split('/').pop()!;
        // Check common slug patterns
        const slug = key.replace(/\s+/g, '-');
        if (await vault.exists(`${folder}/${slug}.md`)) {
          ref.kind = kind.replace(/s$/, ''); // tools -> tool
          break;
        }
      }
    }

    // 3. Find entities shared across 3+ projects
    const sharedEntities: EntityReference[] = [];
    for (const ref of entityIndex.values()) {
      if (ref.projects.size >= 3) {
        sharedEntities.push(ref);
      }
    }

    if (sharedEntities.length === 0) {
      log.info('No cross-project patterns detected');
      return;
    }

    // Sort by number of projects referencing (descending)
    sharedEntities.sort((a, b) => b.projects.size - a.projects.size);

    log.info('Cross-project patterns detected', {
      sharedEntities: sharedEntities.length,
    });

    // 4. Write insight page
    await vault.ensureFolder(`${wiki}/insights`);
    const now = nowISO();
    const insightId = `cross-project-${now.slice(0, 10)}`;
    const insightPath = `${wiki}/insights/${insightId}.md`;

    // Build shared entities section
    const sharedSection = sharedEntities
      .map((ref) => {
        const projects = Array.from(ref.projects).map((p) => `[[${p}]]`).join(', ');
        return `- **[[${ref.name}]]** (${ref.kind}) — referenced by ${ref.projects.size} projects: ${projects}`;
      })
      .join('\n');

    // Group by kind for technology stack detection
    const toolEntities = sharedEntities.filter((e) => e.kind === 'tool');
    const techStackSection = toolEntities.length > 0
      ? toolEntities
          .map((ref) => {
            const projects = Array.from(ref.projects).map((p) => `[[${p}]]`).join(', ');
            return `- **[[${ref.name}]]** — used in: ${projects}`;
          })
          .join('\n')
      : 'No shared tools detected across 3+ projects.';

    const frontmatter: Record<string, unknown> = {
      id: nanoid(),
      type: 'topic',
      title: `Cross-Project Patterns (${now.slice(0, 10)})`,
      status: 'active',
      confidence: 'medium',
      review_state: 'unreviewed',
      created_at: now,
      updated_at: now,
      source_refs: [],
      derived_from: [],
      aliases: [],
      links: sharedEntities.map((e) => e.name),
      change_origin: 'heuristic_review',
      protected_regions: ['shared-entities', 'shared-stack', 'backlinks'],
    };

    const body = `
# Cross-Project Patterns (${now.slice(0, 10)})

## Shared Entities
${OPEN_TAG('shared-entities')}
${sharedSection}
${CLOSE_TAG('shared-entities')}

## Shared Technology Stack
${OPEN_TAG('shared-stack')}
${techStackSection}
${CLOSE_TAG('shared-stack')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

    const content = serializeNote(frontmatter, body);
    await vault.atomicWrite(insightPath, content);

    log.info('Cross-project insight written', {
      path: insightPath,
      sharedEntities: sharedEntities.length,
      sharedTools: toolEntities.length,
    });
  },
};

/**
 * Extract [[wikilink]] names from markdown content.
 */
function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

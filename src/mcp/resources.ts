import type { MCPContext } from './context.js';
import { parseNote } from '../vault/frontmatter.js';

export const RESOURCE_DEFINITIONS = [
  {
    uri: 'vault://hot-cache',
    name: 'Hot Cache (CLAUDE.md)',
    description: 'Active context: recent sessions, key entities, and quick links',
    mimeType: 'text/markdown',
  },
  {
    uri: 'vault://index',
    name: 'Wiki Index',
    description: 'Map of Content for the wiki — lists all entities, projects, decisions, concepts',
    mimeType: 'text/markdown',
  },
  {
    uri: 'vault://entities',
    name: 'Entity Listing',
    description: 'All wiki entities (people, tools, organizations) with kind and status',
    mimeType: 'text/markdown',
  },
  {
    uri: 'vault://projects',
    name: 'Project Listing',
    description: 'All tracked projects with status',
    mimeType: 'text/markdown',
  },
  {
    uri: 'vault://decisions',
    name: 'Decision Listing',
    description: 'All recorded decisions with status and date',
    mimeType: 'text/markdown',
  },
  {
    uri: 'vault://review-queue',
    name: 'Review Queue',
    description: 'Items pending human review (contradictions, ambiguous entities)',
    mimeType: 'text/markdown',
  },
  {
    uri: 'vault://recent-changes',
    name: 'Recent Changes',
    description: 'Recently modified wiki pages',
    mimeType: 'text/markdown',
  },
];

async function listFolderWithFrontmatter(
  ctx: MCPContext,
  folder: string,
  fields: string[],
): Promise<string> {
  let files: string[];
  try {
    files = await ctx.vault.listMarkdownFiles(folder);
  } catch {
    return `No files found in ${folder}.`;
  }

  if (files.length === 0) return `No files found in ${folder}.`;

  const lines: string[] = [];
  for (const file of files) {
    try {
      const content = await ctx.vault.read(file);
      const { data } = parseNote(content);
      const title = (data.title as string) || file.split('/').pop()?.replace(/\.md$/, '') || file;
      const meta = fields
        .map((f) => data[f] != null ? `${f}: ${data[f]}` : null)
        .filter(Boolean)
        .join(', ');
      lines.push(`- [[${title}]]${meta ? ` (${meta})` : ''}`);
    } catch {
      lines.push(`- ${file} (unreadable)`);
    }
  }

  return lines.join('\n');
}

export async function handleResourceRead(
  params: { uri: string },
  ctx: MCPContext,
) {
  switch (params.uri) {
    case 'vault://hot-cache': {
      const text = await ctx.hotCache.toContext();
      return {
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text: text || 'Hot cache is empty.' }],
      };
    }

    case 'vault://index': {
      let text: string;
      try {
        text = await ctx.vault.read('wiki/_index.md');
      } catch {
        text = 'Wiki index not found. Run maintenance to generate it.';
      }
      return {
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text }],
      };
    }

    case 'vault://entities': {
      const text = await listFolderWithFrontmatter(ctx, 'wiki/entities', ['kind', 'status', 'confidence']);
      return {
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text: `# Entities\n\n${text}` }],
      };
    }

    case 'vault://projects': {
      const text = await listFolderWithFrontmatter(ctx, 'wiki/projects', ['status']);
      return {
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text: `# Projects\n\n${text}` }],
      };
    }

    case 'vault://decisions': {
      const text = await listFolderWithFrontmatter(ctx, 'wiki/decisions', ['status', 'date']);
      return {
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text: `# Decisions\n\n${text}` }],
      };
    }

    case 'vault://review-queue': {
      const text = await listFolderWithFrontmatter(ctx, 'review', ['conflict_type', 'resolution_state']);
      return {
        contents: [{ uri: params.uri, mimeType: 'text/markdown', text: `# Review Queue\n\n${text}` }],
      };
    }

    case 'vault://recent-changes': {
      const folders = ['wiki/entities', 'wiki/projects', 'wiki/decisions', 'wiki/concepts'];
      const allFiles: Array<{ path: string; updatedAt: string }> = [];

      for (const folder of folders) {
        try {
          const files = await ctx.vault.listMarkdownFiles(folder);
          for (const file of files) {
            try {
              const content = await ctx.vault.read(file);
              const { data } = parseNote(content);
              allFiles.push({
                path: file,
                updatedAt: (data.updated_at as string) || (data.created_at as string) || '',
              });
            } catch {
              // skip unreadable files
            }
          }
        } catch {
          // folder doesn't exist yet
        }
      }

      allFiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const recent = allFiles.slice(0, 20);
      const lines = recent.map((f) => {
        const name = f.path.split('/').pop()?.replace(/\.md$/, '') || f.path;
        return `- [[${name}]] — ${f.updatedAt || 'unknown date'}`;
      });

      return {
        contents: [{
          uri: params.uri,
          mimeType: 'text/markdown',
          text: `# Recent Changes\n\n${lines.join('\n') || 'No recent changes.'}`,
        }],
      };
    }

    default:
      return {
        contents: [{ uri: params.uri, mimeType: 'text/plain', text: `Unknown resource: ${params.uri}` }],
      };
  }
}

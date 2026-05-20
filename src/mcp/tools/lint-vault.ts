import { z } from 'zod';
import { parseNote, validateFrontmatter } from '../../vault/frontmatter.js';
import { extractOutlinks } from '../../maintenance/backlinks.js';
import { slugify } from '../../vault/paths.js';
import type { MCPContext } from '../context.js';

const ALL_CHECKS = [
  'orphan_notes',
  'broken_links',
  'stale_notes',
  'missing_frontmatter',
  'empty_notes',
  'duplicate_titles',
] as const;

type CheckName = (typeof ALL_CHECKS)[number];

const InputSchema = z.object({
  checks: z
    .array(z.enum(ALL_CHECKS))
    .optional()
    .describe('Which checks to run (default: all)'),
  folder: z
    .string()
    .optional()
    .describe('Scope to a specific folder (e.g. "wiki/entities")'),
  limit: z
    .number()
    .int()
    .positive()
    .default(50)
    .describe('Max findings to return per check (default 50)'),
});

export const definition = {
  name: 'lint_vault',
  description:
    'Run health checks on the vault: find orphan notes, broken wikilinks, stale notes, missing frontmatter, empty notes, and duplicate titles. Returns actionable findings.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      checks: {
        type: 'array' as const,
        items: {
          type: 'string' as const,
          enum: [...ALL_CHECKS],
        },
        description: 'Which checks to run (default: all)',
      },
      folder: { type: 'string' as const, description: 'Scope to a specific folder' },
      limit: { type: 'number' as const, description: 'Max findings per check (default 50)' },
    },
  },
};

interface LintFinding {
  check: CheckName;
  severity: 'info' | 'warning' | 'error';
  path: string;
  message: string;
}

interface NoteInfo {
  path: string;
  data: Record<string, unknown>;
  body: string;
  slug: string;
}

async function loadNotes(ctx: MCPContext, folders: string[]): Promise<NoteInfo[]> {
  const notes: NoteInfo[] = [];

  for (const folder of folders) {
    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const raw = await ctx.vault.read(file);
        const { data, body } = parseNote(raw);
        const slug = file.split('/').pop()?.replace(/\.md$/, '') ?? '';
        notes.push({ path: file, data, body, slug });
      } catch {
        // skip unreadable
      }
    }
  }

  return notes;
}

function checkOrphanNotes(notes: NoteInfo[], limit: number): LintFinding[] {
  // Build set of all link targets across the vault
  const allLinkTargets = new Set<string>();
  for (const note of notes) {
    for (const link of extractOutlinks(note.body)) {
      allLinkTargets.add(link.toLowerCase());
      allLinkTargets.add(slugify(link));
    }
  }

  const findings: LintFinding[] = [];
  for (const note of notes) {
    if (findings.length >= limit) break;
    // Skip index pages
    if (note.path.includes('_index.md')) continue;

    const isLinkedTo =
      allLinkTargets.has(note.slug.toLowerCase()) ||
      allLinkTargets.has((note.data.title as string ?? '').toLowerCase());

    if (!isLinkedTo) {
      findings.push({
        check: 'orphan_notes',
        severity: 'info',
        path: note.path,
        message: `No inbound wikilinks found for "${note.data.title ?? note.slug}"`,
      });
    }
  }

  return findings;
}

function checkBrokenLinks(notes: NoteInfo[], limit: number): LintFinding[] {
  const allSlugs = new Set(notes.map((n) => n.slug.toLowerCase()));
  const allTitles = new Set(
    notes
      .map((n) => (n.data.title as string)?.toLowerCase())
      .filter(Boolean),
  );

  const findings: LintFinding[] = [];
  for (const note of notes) {
    if (findings.length >= limit) break;

    const outlinks = extractOutlinks(note.body);
    for (const link of outlinks) {
      if (findings.length >= limit) break;
      const linkLower = link.toLowerCase();
      const linkSlug = slugify(link);

      if (!allSlugs.has(linkLower) && !allSlugs.has(linkSlug) && !allTitles.has(linkLower)) {
        findings.push({
          check: 'broken_links',
          severity: 'warning',
          path: note.path,
          message: `Broken wikilink [[${link}]] — no matching note found`,
        });
      }
    }
  }

  return findings;
}

function checkStaleNotes(notes: NoteInfo[], limit: number): LintFinding[] {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const cutoff = ninetyDaysAgo.toISOString();

  const findings: LintFinding[] = [];
  for (const note of notes) {
    if (findings.length >= limit) break;

    const status = note.data.status as string;
    const updatedAt = note.data.updated_at as string;

    if (status === 'active' && updatedAt && updatedAt < cutoff) {
      findings.push({
        check: 'stale_notes',
        severity: 'info',
        path: note.path,
        message: `Active note last updated ${updatedAt.slice(0, 10)} (>90 days ago)`,
      });
    }
  }

  return findings;
}

function checkMissingFrontmatter(notes: NoteInfo[], limit: number): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const note of notes) {
    if (findings.length >= limit) break;

    const result = validateFrontmatter(note.data);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      findings.push({
        check: 'missing_frontmatter',
        severity: 'error',
        path: note.path,
        message: `Invalid frontmatter: ${issues}`,
      });
    }
  }

  return findings;
}

function checkEmptyNotes(notes: NoteInfo[], limit: number): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const note of notes) {
    if (findings.length >= limit) break;

    // Strip headings, protected region markers, and whitespace
    const meaningful = note.body
      .replace(/^#{1,6}\s.*$/gm, '')
      .replace(/%% (?:begin|end):\S+ %%/g, '')
      .replace(/<!-- (?:PROTECTED|\/PROTECTED):\S+ -->/g, '')
      .trim();

    if (meaningful.length < 10) {
      findings.push({
        check: 'empty_notes',
        severity: 'warning',
        path: note.path,
        message: `Note has no meaningful body content`,
      });
    }
  }

  return findings;
}

function checkDuplicateTitles(notes: NoteInfo[], limit: number): LintFinding[] {
  const titleMap = new Map<string, string[]>();
  for (const note of notes) {
    const title = (note.data.title as string)?.toLowerCase();
    if (!title) continue;
    const paths = titleMap.get(title) ?? [];
    paths.push(note.path);
    titleMap.set(title, paths);
  }

  const findings: LintFinding[] = [];
  for (const [title, paths] of titleMap) {
    if (findings.length >= limit) break;
    if (paths.length > 1) {
      findings.push({
        check: 'duplicate_titles',
        severity: 'warning',
        path: paths[0],
        message: `Duplicate title "${title}" found in: ${paths.join(', ')}`,
      });
    }
  }

  return findings;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const checksToRun = input.checks ?? [...ALL_CHECKS];

  const { allWikiFolders } = await import('../../vault/paths.js');
  const wikiFolders = input.folder
    ? [input.folder]
    : allWikiFolders(ctx.config.layout);

  const notes = await loadNotes(ctx, wikiFolders);
  const findings: LintFinding[] = [];

  const runners: Record<CheckName, (n: NoteInfo[], l: number) => LintFinding[]> = {
    orphan_notes: checkOrphanNotes,
    broken_links: checkBrokenLinks,
    stale_notes: checkStaleNotes,
    missing_frontmatter: checkMissingFrontmatter,
    empty_notes: checkEmptyNotes,
    duplicate_titles: checkDuplicateTitles,
  };

  for (const check of checksToRun) {
    const runner = runners[check];
    if (runner) {
      findings.push(...runner(notes, input.limit));
    }
  }

  if (findings.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: `Vault lint passed. ${notes.length} notes scanned, no issues found.`,
      }],
    };
  }

  const summary = {
    notes_scanned: notes.length,
    total_findings: findings.length,
    by_severity: {
      error: findings.filter((f) => f.severity === 'error').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    findings,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
  };
}

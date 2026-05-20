import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote } from '../../vault/frontmatter.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:check-confidence-decay');

/** Default number of days before a spec is considered stale by age */
const DEFAULT_STALE_DAYS = 30;

/**
 * Maintenance job that scans project_spec notes for staleness.
 *
 * A spec is flagged for re-synthesis when either:
 * 1. conversations_since_update >= stale_threshold
 * 2. last_reinforced is older than a configurable number of days
 *
 * When stale specs are found, enqueues agent-synthesize-project for the
 * affected project.
 */
export const checkConfidenceDecayHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const { vault } = context;
    const staleDays = DEFAULT_STALE_DAYS;
    const now = Date.now();
    const staleMs = staleDays * 24 * 60 * 60 * 1000;

    // Scan all project directories for sub-specs
    let projectDirs: string[];
    try {
      const allFiles = await vault.listMarkdownFiles(`${context.config.layout.wiki}/projects`);
      // Extract unique project slugs from paths like wiki/projects/{slug}/spec.md
      const slugs = new Set<string>();
      for (const f of allFiles) {
        const parts = f.split('/');
        // wiki/projects/{slug}/something.md  => parts[2] is slug
        if (parts.length >= 4 && !parts[2].startsWith('_')) {
          slugs.add(parts[2]);
        }
      }
      projectDirs = Array.from(slugs);
    } catch {
      log.info('No project directories found');
      return;
    }

    const staleProjects = new Set<string>();

    for (const slug of projectDirs) {
      const hubDir = `wiki/projects/${slug}`;
      let specFiles: string[];
      try {
        specFiles = await vault.listMarkdownFiles(hubDir);
      } catch {
        continue;
      }

      for (const specPath of specFiles) {
        if (specPath.endsWith('_index.md')) continue;

        try {
          const content = await vault.read(specPath);
          const { data } = parseNote(content);

          if (data.type !== 'project_spec') continue;

          const conversationsSince = (data.conversations_since_update as number) ?? 0;
          const staleThreshold = (data.stale_threshold as number) ?? 10;
          const lastReinforced = data.last_reinforced as string | undefined;

          // Check threshold-based staleness
          if (conversationsSince >= staleThreshold) {
            log.info('Spec stale by conversation count', {
              specPath,
              conversationsSince,
              staleThreshold,
            });
            staleProjects.add(slug);
            continue;
          }

          // Check time-based staleness
          if (lastReinforced) {
            const lastTime = new Date(lastReinforced).getTime();
            if (now - lastTime > staleMs) {
              log.info('Spec stale by age', {
                specPath,
                lastReinforced,
                daysSince: Math.round((now - lastTime) / (24 * 60 * 60 * 1000)),
              });
              staleProjects.add(slug);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    if (staleProjects.size === 0) {
      log.info('No stale project specs found');
      return;
    }

    log.info('Stale projects detected', { count: staleProjects.size, projects: Array.from(staleProjects) });

    // Enqueue re-synthesis for each stale project
    for (const slug of staleProjects) {
      await context.enqueue({
        type: 'agent-synthesize-project',
        payload: { projectSlug: slug },
        trigger: 'cascade',
        priority: 35,
        dedupeKey: `synthesize:${slug}`,
      });
    }
  },
};

import { join } from 'node:path';
import type { JobHandler, Job, JobContext } from '../types.js';
import { runIngestAgent } from '../../agent/runner.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { createIngestTracker } from '../../agent/ingest-tracker.js';
import { createLogger } from '../../shared/logger.js';
import type { ContentCategory } from '../../ingest/content-router.js';

const log = createLogger('handler:agent-ingest');

/**
 * Job handler that runs the ingest agent for a source file.
 *
 * Expects payload:
 * - sourceSummaryPath: path to the source summary in outputs/source-summaries/
 * - rawPath: path to the raw file
 * - contentCategory: the ContentCategory of the file
 * - projectSlug: optional project slug from CWD classification
 */
export const agentIngestHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = (job.payload.sourceSummaryPath as string) ?? job.targetPath;
    const rawPath = job.payload.rawPath as string;
    const contentCategory = job.payload.contentCategory as ContentCategory;
    const projectSlug = job.payload.projectSlug as string | undefined;

    if (!rawPath) throw new Error('agent-ingest: no rawPath in payload');
    if (!contentCategory) throw new Error('agent-ingest: no contentCategory in payload');

    // Read the raw source content
    const sourceContent = await context.vault.read(rawPath);

    log.info('Running ingest agent', {
      rawPath,
      contentCategory,
      projectSlug,
    });

    const result = await runIngestAgent(
      {
        sourceFilePath: rawPath,
        sourceContent,
        contentCategory,
        projectSlug,
      },
      context,
    );

    // Update source summary with agent results
    if (summaryPath && await context.vault.exists(summaryPath)) {
      try {
        const content = await context.vault.read(summaryPath);
        const { data, body } = parseNote(content);

        data.ingest_status = 'linked';
        data.conversation_intent = result.completionData?.conversation_intent;

        const updated = serializeNote(data, body);
        await context.vault.atomicWrite(summaryPath, updated);
      } catch (err) {
        log.warn('Failed to update source summary after agent run', {
          summaryPath,
          error: (err as Error).message,
        });
      }
    }

    // Track incremental ingest and check if full re-synthesis is needed
    if (projectSlug) {
      const stateDir = join(context.projectRoot, context.config.stateDir);
      const tracker = createIngestTracker(stateDir);
      const { thresholdReached, count } = await tracker.recordIncremental(
        projectSlug,
        rawPath,
        context.config.agent.incrementalThreshold,
      );

      if (thresholdReached) {
        log.info('Incremental threshold reached, enqueuing full re-synthesis', {
          projectSlug,
          count,
        });
        await context.enqueue({
          type: 'agent-synthesize-project',
          payload: { projectSlug },
          trigger: 'cascade',
          priority: 35,
          dedupeKey: `synthesize:${projectSlug}`,
        });
      }
    }

    // Enqueue deterministic follow-ups (backlinks, indexes)
    await context.enqueue({
      type: 'update-backlinks',
      trigger: 'cascade',
      priority: 10,
      dedupeKey: 'backlinks:full',
      debounceMs: 5000,
    });

    await context.enqueue({
      type: 'rebuild-indexes',
      trigger: 'cascade',
      priority: 15,
      dedupeKey: 'indexes:full',
      debounceMs: 5000,
    });

    log.info('Agent ingest complete', {
      rawPath,
      turns: result.agentResult.turns,
      toolCalls: result.agentResult.toolCalls,
    });
  },
};

import { join } from 'node:path';
import type { JobHandler, Job, JobContext } from '../types.js';
import { createAgentClient } from '../../agent/bedrock-agent-client.js';
import { createToolExecutor, toToolDefinitions } from '../../agent/tool-registry.js';
import { createIngestToolRegistry } from '../../agent/tools/index.js';
import { buildSynthesisSystemPrompt, buildSynthesisUserPrompt } from '../../agent/prompts/synthesis-system.js';
import { createDigestCache } from '../../agent/digest-cache.js';
import { createIngestTracker } from '../../agent/ingest-tracker.js';
import { listProjectSpecs } from '../../compilation/project-hub.js';
import { createLogger } from '../../shared/logger.js';
import type { AgentContext } from '../../agent/tool-registry.js';

const log = createLogger('handler:agent-synthesize-project');

/**
 * Full re-synthesis handler. Reads ALL conversation digests for a project,
 * runs the Opus model agent to rebuild/refine all sub-specs from the
 * complete conversation corpus.
 *
 * Triggered by:
 * - Incremental ingest threshold reached (automatic)
 * - Confidence decay detection (automatic)
 * - CLI: `karpathy synthesize <slug>`
 *
 * Expects payload:
 * - projectSlug: the project to re-synthesize
 */
export const agentSynthesizeProjectHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const projectSlug = _job.payload.projectSlug as string;
    if (!projectSlug) throw new Error('agent-synthesize-project: no projectSlug in payload');

    const { vault, config } = context;
    const stateDir = join(context.projectRoot, config.stateDir);
    const agentConfig = config.agent;

    log.info('Starting full re-synthesis', { projectSlug });

    // 1. Read current hub state
    const indexPath = `wiki/projects/${projectSlug}/_index.md`;
    let currentHub: string;
    try {
      currentHub = await vault.read(indexPath);
    } catch {
      log.warn('Project hub not found, skipping re-synthesis', { projectSlug });
      return;
    }

    // 2. Read current sub-specs
    const specs = await listProjectSpecs(vault, projectSlug);
    const currentSpecs: Array<{ specType: string; content: string }> = [];
    for (const spec of specs) {
      try {
        const content = await vault.read(spec.path);
        currentSpecs.push({ specType: spec.specType, content });
      } catch {
        // Skip unreadable specs
      }
    }

    // 3. Load conversation digests
    const digestCache = createDigestCache(stateDir);
    const digests = await digestCache.getForProject(projectSlug);

    if (digests.length === 0) {
      log.info('No digests available for re-synthesis', { projectSlug });
      return;
    }

    log.info('Loaded digests for re-synthesis', {
      projectSlug,
      digestCount: digests.length,
      specCount: currentSpecs.length,
    });

    // 4. Build agent context and tools
    const agentContext: AgentContext = {
      ...context,
      sourceFilePath: indexPath,
      sourceContent: currentHub,
      contentCategory: 'ai-conversation-claude',
      projectSlug,
    };

    const tools = createIngestToolRegistry();
    const toolExecutor = createToolExecutor(tools, agentContext, agentConfig.toolTimeoutMs);
    const toolDefinitions = toToolDefinitions(tools);

    // 5. Build prompts
    const systemPrompt = buildSynthesisSystemPrompt();
    const userPrompt = buildSynthesisUserPrompt({
      projectSlug,
      currentHub,
      currentSpecs,
      digests: digests.map((d) => ({ sourcePath: d.sourcePath, digest: d.digest })),
    });

    // 6. Run agent with Opus model
    const model = agentConfig.opusModel;
    const client = createAgentClient({ region: config.llm.region });

    log.info('Running Opus re-synthesis agent', {
      projectSlug,
      model,
      digestCount: digests.length,
    });

    const result = await client.runAgentLoop(
      userPrompt,
      toolDefinitions,
      toolExecutor,
      {
        system: systemPrompt,
        model,
        maxTurns: agentConfig.maxTurns,
        maxTokens: agentConfig.maxTokens,
        temperature: 0.3,
        apiTimeoutMs: agentConfig.apiTimeoutMs,
        apiRetryAttempts: agentConfig.apiRetryAttempts,
        apiRetryBaseMs: agentConfig.apiRetryBaseMs,
      },
    );

    // 7. Record full synthesis in tracker (resets incremental counter)
    const tracker = createIngestTracker(stateDir);
    await tracker.recordFullSynthesis(projectSlug);

    // 7b. Prune digest cache: remove entries for deleted source files
    const pruned = await digestCache.prune((path) => vault.exists(path));
    if (pruned > 0) {
      log.info('Pruned stale digest entries', { projectSlug, pruned });
    }

    // 8. Enqueue maintenance follow-ups
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

    log.info('Full re-synthesis complete', {
      projectSlug,
      turns: result.turns,
      toolCalls: result.toolCalls,
    });
  },
};

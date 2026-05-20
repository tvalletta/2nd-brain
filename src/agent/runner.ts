import type { JobContext } from '../jobs/types.js';
import type { ContentCategory } from '../ingest/content-router.js';
import type { AgentContext } from './tool-registry.js';
import { createAgentClient, type AgentLoopResult } from './bedrock-agent-client.js';
import { createToolExecutor, toToolDefinitions } from './tool-registry.js';
import { createIngestToolRegistry } from './tools/index.js';
import { buildIngestSystemPrompt } from './prompts/ingest-system.js';
import { buildIngestUserPrompt } from './prompts/ingest-user.js';
import { loadSkills, matchSkill, seedBuiltinSkills, recordSkillUsage } from './skills/registry.js';
import { matchSkillByEmbedding } from './skills/embedding-match.js';
import { createProviderFromConfig } from '../embeddings/factory.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent-runner');

export interface IngestAgentInput {
  sourceFilePath: string;
  sourceContent: string;
  contentCategory: ContentCategory;
  projectSlug?: string;
}

export interface IngestAgentResult {
  agentResult: AgentLoopResult;
  completionData?: Record<string, unknown>;
}

/**
 * Run the ingest agent for a single source file.
 * The agent uses tools to explore wiki state, then synthesizes knowledge
 * from the source into project hubs and wiki pages.
 */
export async function runIngestAgent(
  input: IngestAgentInput,
  jobContext: JobContext,
): Promise<IngestAgentResult> {
  const agentConfig = jobContext.config.agent;

  // Build agent context (extends job context with source-specific info)
  const agentContext: AgentContext = {
    ...jobContext,
    sourceFilePath: input.sourceFilePath,
    sourceContent: input.sourceContent,
    contentCategory: input.contentCategory,
    projectSlug: input.projectSlug,
  };

  // Set up tools
  const tools = createIngestToolRegistry();
  const toolExecutor = createToolExecutor(tools, agentContext, agentConfig.toolTimeoutMs);
  const toolDefinitions = toToolDefinitions(tools);

  // Load synthesis skills and match against content
  const { layoutFromConfig } = await import('../vault/paths.js');
  const layout = layoutFromConfig(jobContext.config);
  await seedBuiltinSkills(jobContext.vault, layout);
  const skills = await loadSkills(jobContext.vault, layout);
  const skillMatch =
    jobContext.config.agent.skillMatch === 'embedding'
      ? await matchSkillByEmbedding(input.sourceContent, skills, createProviderFromConfig(jobContext.config))
      : matchSkill(input.sourceContent, skills);
  const skillStrategy = skillMatch?.skill.strategy ?? undefined;

  if (skillMatch) {
    log.info('Matched synthesis skill', {
      skill: skillMatch.skill.name,
      score: skillMatch.score,
      matchCount: skillMatch.matchCount,
    });
    await recordSkillUsage(jobContext.vault, skillMatch.skill.id, layout);
  }

  // Build prompts (inject skill strategy if matched)
  const systemPrompt = buildIngestSystemPrompt(skillStrategy);
  const userPrompt = buildIngestUserPrompt({
    sourcePath: input.sourceFilePath,
    contentCategory: input.contentCategory,
    projectSlug: input.projectSlug,
    content: input.sourceContent,
  });

  // Select model based on content category
  const model = agentConfig.sonnetModel;

  log.info('Starting ingest agent', {
    sourceFile: input.sourceFilePath,
    category: input.contentCategory,
    projectSlug: input.projectSlug,
    skill: skillMatch?.skill.name ?? null,
    model,
  });

  // Create agent client and run the loop
  const client = createAgentClient({ region: jobContext.config.llm.region });
  const agentResult = await client.runAgentLoop(
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

  log.info('Ingest agent complete', {
    sourceFile: input.sourceFilePath,
    turns: agentResult.turns,
    toolCalls: agentResult.toolCalls,
  });

  return { agentResult };
}

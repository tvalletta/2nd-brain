import { z } from 'zod';

/**
 * Phase 0: tiered model selection. Handlers route to a tier rather than a
 * single model, so cheap-first is built into the architecture instead of
 * being a per-handler override.
 *
 * - `fast`   — extraction, significance gate, stance classifier, TL;DR.
 * - `medium` — topic-refresh, conflict triage, synthesis.
 * - `heavy`  — weekly digest, deep research synthesis.
 *
 * `model` (legacy single-model field) is preserved for backwards compat and
 * defaults to `models.medium` when handlers don't yet declare a tier.
 */
export const LLMModelTiersSchema = z.object({
  fast: z.string().default('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
  medium: z.string().default('us.anthropic.claude-sonnet-4-6'),
  heavy: z.string().default('us.anthropic.claude-opus-4-6-v1'),
});
export type LLMModelTiers = z.infer<typeof LLMModelTiersSchema>;
export type LLMTier = keyof LLMModelTiers;

export const LLMConfigSchema = z.object({
  provider: z.enum(['bedrock', 'litellm']).default('bedrock'),
  region: z.string().default('us-west-2'),
  model: z.string().default('us.anthropic.claude-sonnet-4-6'),
  maxTokens: z.number().int().positive().default(4096),
  /** Phase 0: tiered model selection. Falls back to `model` when callers don't pick a tier. */
  models: LLMModelTiersSchema.default({}),
  /** LiteLLM proxy base URL (required when provider = 'litellm') */
  baseUrl: z.string().optional(),
  /** LiteLLM proxy API key (required when provider = 'litellm') */
  apiKey: z.string().optional(),
  /** Bedrock HTTP Bearer token — read from BEDROCK_BEARER_TOKEN env var if not set here */
  bearerToken: z.string().optional(),
});

export const IngestConfigSchema = z.object({
  watchEnabled: z.boolean().default(false),
  watchPaths: z.array(z.string()).default(['raw/']),
  debounceMs: z.number().int().nonnegative().default(2000),
  /** §23.1: When true, the file watcher also monitors {vaultPath}/{layout.clippings}. */
  watchClippings: z.boolean().default(false),
});

export const MaintenanceConfigSchema = z.object({
  autoBacklinks: z.boolean().default(true),
  autoIndexes: z.boolean().default(true),
  reviewEnabled: z.boolean().default(false),
});

export const SessionConfigSchema = z.object({
  exportToRaw: z.boolean().default(true),
  minTurns: z.number().int().nonnegative().default(2),
});

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxTurns: z.number().int().positive().default(20),
  maxTokens: z.number().int().positive().default(8192),
  sonnetModel: z.string().default('us.anthropic.claude-sonnet-4-6'),
  opusModel: z.string().default('us.anthropic.claude-opus-4-6-v1'),
  haikuModel: z.string().default('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
  incrementalThreshold: z.number().int().positive().default(5),
  apiTimeoutMs: z.number().int().positive().default(120000),
  apiRetryAttempts: z.number().int().nonnegative().default(3),
  apiRetryBaseMs: z.number().int().positive().default(1000),
  toolTimeoutMs: z.number().int().positive().default(30000),
  /** E1: Skill matching mode — `substring` (legacy) or `embedding` (semantic, opt-in). */
  skillMatch: z.enum(['substring', 'embedding']).default('substring'),
});

export const EmbeddingsConfigSchema = z.object({
  /**
   * `deterministic` is offline & test-grade; `bedrock-titan` was the legacy
   * production provider; `ollama` is the always-on local provider behind the
   * hybrid-search module.
   */
  provider: z.enum(['deterministic', 'bedrock-titan', 'ollama']).default('deterministic'),
  /** Override LLM region; defaults to llm.region when unset. */
  region: z.string().optional(),
  model: z.string().optional(),
  /** Titan v2 supports 256 / 512 / 1024; Ollama nomic-embed-text returns 768. */
  dimensions: z.number().int().positive().optional(),
  /** Ollama HTTP endpoint. Default points at the local launchd-managed daemon. */
  baseUrl: z.string().default('http://localhost:11434'),
  /** Ollama probe timeout (ms). Used by `isOllamaAvailable()` and per-call embed timeouts. */
  timeoutMs: z.number().int().positive().default(5000),
});

export const IntelligenceConfigSchema = z.object({
  /** Per-content-type recency weight β in `α·sim + β·exp(-Δt/30)`. */
  recencyWeight: z
    .object({
      session: z.number().min(0).max(1).default(0.3),
      transcript: z.number().min(0).max(1).default(0.3),
      concept: z.number().min(0).max(1).default(0.1),
      topic: z.number().min(0).max(1).default(0.2),
      project: z.number().min(0).max(1).default(0.15),
      default: z.number().min(0).max(1).default(0.15),
    })
    .default({}),
  /** TL;DR (A3) thresholds. */
  tldr: z
    .object({
      enabled: z.boolean().default(true),
      maxChars: z.number().int().positive().default(120),
      cooldownDays: z.number().nonnegative().default(1),
    })
    .default({}),
  /** Hot-topics digest (B1). */
  digest: z
    .object({
      enabled: z.boolean().default(true),
      windowDays: z.number().int().positive().default(7),
      minClusterSize: z.number().int().positive().default(3),
      maxClusters: z.number().int().positive().default(8),
    })
    .default({}),
  /** Decay scan (C1). */
  decay: z
    .object({
      enabled: z.boolean().default(true),
      retrievabilityRefresh: z.number().min(0).max(1).default(0.5),
      retrievabilityArchive: z.number().min(0).max(1).default(0.2),
    })
    .default({}),
  /**
   * Phase 1 (cascading curation): threshold-gated topic refresh. The
   * `evaluate-refresh-candidates` job uses these to decide whether to
   * enqueue a `topic-refresh` for a dirty note.
   */
  refresh: z
    .object({
      enabled: z.boolean().default(true),
      /** Min pending_evidence_count to trigger a refresh. */
      threshold: z.number().int().positive().default(3),
      /** Refresh on staleness even below the evidence threshold (uses decay.retrievabilityRefresh). */
      considerRetrievability: z.boolean().default(true),
      /**
       * Cascade depth on refresh completion. 1 = mark-dirty direct neighbors
       * (linked concepts in the rewritten region). 0 = no cascade. Higher
       * depths are deliberately not supported — keep blast radius bounded.
       */
      cascadeDepth: z.union([z.literal(0), z.literal(1)]).default(1),
    })
    .default({}),
  /**
   * Phase 0: per-day LLM call budget by tier. The reflection scheduler picks
   * highest-value targets within this ceiling. Set any tier to 0 to disable
   * a tier; set the parent to `enabled: false` for unlimited (legacy).
   */
  budget: z
    .object({
      enabled: z.boolean().default(true),
      llmCallsPerDay: z
        .object({
          fast: z.number().int().nonnegative().default(200),
          medium: z.number().int().nonnegative().default(50),
          heavy: z.number().int().nonnegative().default(10),
        })
        .default({}),
    })
    .default({}),
  /** Research (D1-D3). */
  research: z
    .object({
      enabled: z.boolean().default(true),
      queueCap: z.number().int().positive().default(50),
      autoExpireDays: z.number().int().positive().default(14),
      autoExpireBelowScore: z.number().min(0).max(1).default(0.3),
      depths: z
        .object({
          light: z.object({ rounds: z.number().int().positive().default(1), perRound: z.number().int().positive().default(3), topSources: z.number().int().positive().default(3) }).default({}),
          medium: z.object({ rounds: z.number().int().positive().default(2), perRound: z.number().int().positive().default(5), topSources: z.number().int().positive().default(8) }).default({}),
          heavy: z.object({ rounds: z.number().int().positive().default(3), perRound: z.number().int().positive().default(7), topSources: z.number().int().positive().default(15) }).default({}),
        })
        .default({}),
      /** Pluggable web search backend. `noop` = LLM-only, `duckduckgo` = no-key fallback, `mcp` = local search MCP server. */
      search: z
        .object({
          provider: z.enum(['noop', 'duckduckgo', 'mcp']).default('noop'),
          mcp: z
            .object({
              command: z.string().optional(),
              args: z.array(z.string()).default([]),
              toolName: z.string().default('search'),
              queryArg: z.string().default('query'),
              countArg: z.string().default('count'),
              extraArgs: z.record(z.unknown()).optional(),
              env: z.record(z.string()).optional(),
            })
            .optional(),
        })
        .default({}),
    })
    .default({}),
});

export const NotificationsConfigSchema = z.object({
  slack: z
    .object({
      enabled: z.boolean().default(false),
      webhookUrl: z.string().optional(),
      target: z.string().optional(),
    })
    .default({}),
});

export const EnrichmentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxChunkSize: z.number().int().positive().default(12000),
  chunkOverlap: z.number().int().nonnegative().default(1000),
  autoCreateEntities: z.boolean().default(true),
  autoMergeEntities: z.boolean().default(true),
  contradictionDetection: z.boolean().default(false),
  entityBlocklist: z.array(z.string()).default([]),
  minEntityConfidence: z.number().min(0).max(1).default(0.3),
  /** D4: Significance gate — `off` legacy behaviour, `heuristic` (cheap), or `llm` (Bedrock-backed). */
  significanceGate: z.enum(['off', 'heuristic', 'llm']).default('heuristic'),
});

/**
 * Vault layout — physical paths for each logical folder. Every karpathy-managed
 * path is computed from this map at runtime, so an alternative vault layout
 * (e.g. AI Conversations/ at root, Curated/{wiki,sources,review,_system}/) is
 * a config-only change with no code edits.
 *
 * Defaults preserve the historical layout for backwards compatibility.
 */
export const LayoutConfigSchema = z.object({
  /** Where raw Claude/Cursor session transcripts land (Stop hook + Cursor import). */
  aiConversations: z.string().default('raw/ai-conversations'),
  /** Where the Stop hook's structured session-projection file lands. */
  aiSummaries: z.string().default('outputs/session-summaries'),
  /** Where pre-layout legacy date-bucketed session captures live. */
  aiLegacy: z.string().default('raw/legacy-sessions'),
  /** Root of the curated knowledge graph. */
  wiki: z.string().default('wiki'),
  /** Per-raw-file extraction records (formerly `outputs/source-summaries`). */
  sources: z.string().default('outputs/source-summaries'),
  /** Human-review queue. */
  review: z.string().default('review'),
  /** Infrastructure (research queue, vault health, scheduler state in vault). */
  system: z.string().default('wiki/_system'),
  /** Generic extraction outputs (rare/legacy). */
  extractions: z.string().default('outputs/extractions'),
  /** Generic reviews outputs (rare/legacy). */
  reviews: z.string().default('outputs/reviews'),
  /** Daily/weekly digests. */
  digests: z.string().default('wiki/digests'),
  /**
   * Top-level catalogue index file. Default `index.md` at vault root preserves
   * the Karpathy LLM Wiki convention; users with a curated-only machine area
   * typically override to `Curated/index.md`.
   */
  vaultIndex: z.string().default('index.md'),
  /**
   * Append-only system ledger. Default `log.md` at vault root preserves the
   * legacy convention; override to e.g. `Curated/log.md` when machine-managed
   * artifacts should be visually segregated.
   */
  vaultLog: z.string().default('log.md'),
  /**
   * §23.1: Drop zone for human-authored clippings and research notes.
   * Files added here are ingested through the standard pipeline.
   * Enable automatic pickup via ingest.watchClippings.
   */
  clippings: z.string().default('clippings'),
});

export const KarpathyConfigSchema = z.object({
  vaultPath: z.string(),
  projectRoot: z.string().optional(),
  hotCachePath: z.string().default('CLAUDE.md'),
  stateDir: z.string().default('.karpathy/state'),
  lockDir: z.string().default('.karpathy/locks'),
  logDir: z.string().default('.karpathy/logs'),
  llm: LLMConfigSchema.default({}),
  ingest: IngestConfigSchema.default({}),
  maintenance: MaintenanceConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  enrichment: EnrichmentConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  intelligence: IntelligenceConfigSchema.default({}),
  notifications: NotificationsConfigSchema.default({}),
  layout: LayoutConfigSchema.default({}),
});

// Partial versions of sub-configs for use in GlobalConfigSchema overrides
const PartialLLMConfigSchema = LLMConfigSchema.partial();
const PartialIngestConfigSchema = IngestConfigSchema.partial();
const PartialMaintenanceConfigSchema = MaintenanceConfigSchema.partial();
const PartialSessionConfigSchema = SessionConfigSchema.partial();
const PartialEnrichmentConfigSchema = EnrichmentConfigSchema.partial();
const PartialAgentConfigSchema = AgentConfigSchema.partial();
const PartialEmbeddingsConfigSchema = EmbeddingsConfigSchema.partial();
const PartialIntelligenceConfigSchema = IntelligenceConfigSchema.partial();
const PartialNotificationsConfigSchema = NotificationsConfigSchema.partial();
const PartialLayoutConfigSchema = LayoutConfigSchema.partial();

export const ProjectOverrideSchema = z.object({
  vaultPath: z.string().optional(),
  hotCachePath: z.string().optional(),
  stateDir: z.string().optional(),
  lockDir: z.string().optional(),
  logDir: z.string().optional(),
  llm: PartialLLMConfigSchema.optional(),
  ingest: PartialIngestConfigSchema.optional(),
  maintenance: PartialMaintenanceConfigSchema.optional(),
  session: PartialSessionConfigSchema.optional(),
  enrichment: PartialEnrichmentConfigSchema.optional(),
  agent: PartialAgentConfigSchema.optional(),
  embeddings: PartialEmbeddingsConfigSchema.optional(),
  intelligence: PartialIntelligenceConfigSchema.optional(),
  notifications: PartialNotificationsConfigSchema.optional(),
  layout: PartialLayoutConfigSchema.optional(),
});

export const GlobalDefaultsSchema = z.object({
  vaultPath: z.string().optional(),
  hotCachePath: z.string().optional(),
  stateDir: z.string().optional(),
  lockDir: z.string().optional(),
  logDir: z.string().optional(),
  llm: PartialLLMConfigSchema.optional(),
  ingest: PartialIngestConfigSchema.optional(),
  maintenance: PartialMaintenanceConfigSchema.optional(),
  session: PartialSessionConfigSchema.optional(),
  enrichment: PartialEnrichmentConfigSchema.optional(),
  agent: PartialAgentConfigSchema.optional(),
  embeddings: PartialEmbeddingsConfigSchema.optional(),
  intelligence: PartialIntelligenceConfigSchema.optional(),
  notifications: PartialNotificationsConfigSchema.optional(),
  layout: PartialLayoutConfigSchema.optional(),
});

export const GlobalConfigSchema = z.object({
  defaults: GlobalDefaultsSchema.default({}),
  projects: z.record(z.string(), ProjectOverrideSchema).default({}),
});

export type KarpathyConfig = z.infer<typeof KarpathyConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;
export type ProjectOverride = z.infer<typeof ProjectOverrideSchema>;

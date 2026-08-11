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
  /**
   * Fix B (resource-boundedness): minimum time in ms between Stop/PostCompact-
   * hook-spawned background drains (`src/hooks/background-drain.ts`). A spawn
   * within this window of the last one is skipped — the scheduled `intel
   * tick` (every 5 min) still drains the queue regardless, so skipping never
   * strands work for long.
   */
  stopDrainMinIntervalMs: z.number().int().nonnegative().default(30_000),
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
  /**
   * Fix K (resource-boundedness): hard cap (chars) on a single embedding
   * input, used both as `chunkText()`'s `maxChars` in `embedding-index.ts`
   * and as the Ollama provider's defensive truncation backstop. nomic-embed-
   * text caps inputs at 2048 tokens; wikilink-dense markdown can tokenize as
   * low as ~1.5 chars/token, so a 4000-char cap (the old hardcoded value,
   * assuming ~2.5 chars/token) could exceed the model's limit and 500. 2048
   * chars stays safe (≈1365 tokens even at 1.5 ch/tok) with margin to spare.
   */
  maxChunkChars: z.number().int().positive().default(2048),
});

/**
 * Sub-project C: draft/archival lifecycle. Master gate (`enabled`) plus
 * per-mechanism knobs — see docs/superpowers/specs/2026-07-31-sub-project-c-
 * draft-archival-lifecycle-design.md §12 for the full rationale.
 */
export const LifecycleConfigSchema = z.object({
  /** Master gate for all Sub-project C behavior (G0-G7). */
  enabled: z.boolean().default(true),
  /** G1: age (days) past which a draft source_summary appears in vault-health.md's
   *  "Stale draft sources" table. */
  staleDraftReportDays: z.number().int().positive().default(14),
  /**
   * G2: gate for auto-archiving stale drafts. Defaults to **false** — with a
   * large real-vault backlog of already-stale drafts, defaulting this on
   * would silently archive the majority of source_summary notes the moment
   * the daily job first runs after deploy. G0/G1/G3-G5 and the reporting
   * table are unaffected by this default and work identically regardless.
   * An operator opts in explicitly once ready.
   */
  staleDraftArchiveEnabled: z.boolean().default(false),
  /** G2: age (days) past which a draft source_summary is auto-archived (once
   *  staleDraftArchiveEnabled is true). Should be >= staleDraftReportDays — a
   *  note should always be reported as stale before it's auto-archived; see
   *  `lifecycleConfigWarnings` in config/loader.ts for the (warn-only) check. */
  staleDraftArchiveDays: z.number().int().positive().default(30),
  /** G3: gate for rot-scan feeding its candidates into the archive queue.
   *  Independent of maintenance.reviewEnabled — this queue is populated by
   *  the always-scheduled weekly rot-scan job, not by the reviewEnabled-
   *  gated detect-* jobs. */
  archiveQueueEnabled: z.boolean().default(true),
});

export const IntelligenceConfigSchema = z.object({
  /** Per-content-type recency weight β in `α·sim + β·exp(-Δt/30)`. */
  recencyWeight: z
    .object({
      session: z.number().min(0).max(1).default(0.3),
      transcript: z.number().min(0).max(1).default(0.2),
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
      /**
       * Fix G (resource-boundedness): cap on `topic-refresh` jobs enqueued by
       * a single decay-scan run. Qualifying candidates are collected across
       * the whole scan, sorted by urgency (thin-content trigger first, then
       * lowest retrievability first), and only the top N are enqueued — the
       * rest are skipped (and logged) rather than fanning out 1:1 with vault
       * size.
       */
      maxRefreshEnqueuePerRun: z.number().int().positive().default(25),
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
   * B2b: wiki content richness. Gates thin-content backfill (decay-scan) and
   * glossary threshold synthesis (compile-entities → glossary-synthesize).
   */
  richness: z
    .object({
      enabled: z.boolean().default(true),
      /** Mention count at which a glossary concept gets an LLM-synthesized rollup line
       *  instead of just a bare list of raw glosses. Re-fires every `threshold` mentions
       *  past the last synthesis (e.g. at 3, then 6, then 9...). */
      glossarySynthesisThreshold: z.number().int().positive().default(3),
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
      /**
       * G1 (Sub-project D): when true, a decided-but-unexecuted candidate is
       * automatically enqueued as a research-execute job by the next
       * research-propose run, instead of requiring
       * `karpathy intel research <slug> <depth>` by hand. Defaults to
       * **false**: research-execute makes real LLM calls (budget-gated per
       * G2, but still real cost) and -- depending on `search.provider` --
       * spawns an external websearch MCP subprocess that has never been
       * exercised against real traffic in the production vault. Ship built
       * and one flip away; see docs/superpowers/specs/2026-07-31-sub-
       * project-d-research-queue-redesign-design.md §14/§15.
       */
      autoDrainEnabled: z.boolean().default(false),
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
  /** Sub-project C: draft/archival lifecycle. */
  lifecycle: LifecycleConfigSchema.default({}),
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

/**
 * B2c: person name resolution. Gates external-ID capture (Component 0),
 * nickname/honorific/initials fuzzy-match extensions (Component 1), and the
 * immediate name-variant detection check on new-page creation (Component 3).
 */
export const PersonResolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Gate for Component 0 (external-ID capture) — Slack link scanning at extraction time. */
  externalIdCaptureEnabled: z.boolean().default(true),
  /** Gate for Component 1's nickname/honorific/initials fuzzy-match extensions. */
  nicknameMatchingEnabled: z.boolean().default(true),
  /** Additional nickname-equivalence groups appended to the built-in NICKNAME_GROUPS seed list. */
  extraNicknameGroups: z.array(z.array(z.string())).default([]),
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
  significanceGate: z.enum(['off', 'heuristic', 'llm']).default('llm'),
  /** Below this confidence, an LLM "drop" verdict creates the page anyway and flags it for review instead of silently discarding it. */
  significanceGateDropConfidence: z.number().min(0).max(1).default(0.7),
  personResolution: PersonResolutionConfigSchema.default({}),
});

export const JobsConfigSchema = z.object({
  transientRetry: z
    .object({
      backoffCeilingMs: z.number().int().positive().default(1_800_000), // 30 min
      alertAfterMs: z.number().int().nonnegative().default(3_600_000), // 1 hour
      probeTrustWindowMs: z.number().int().positive().default(120_000), // 2 min
      /**
       * Fix F (resource-boundedness): once a job's `transientRetryCount`
       * exceeds this, `queue.ts`'s `fail()` marks it terminally `failed`
       * instead of resetting it to `pending` forever. Previously unbounded —
       * a job against a slow/unreachable endpoint retried every ≤30 min
       * indefinitely, re-spending LLM budget each attempt.
       */
      maxTransientRetries: z.number().int().positive().default(20),
    })
    .default({}),
  /**
   * Fix H (resource-boundedness): ceiling on total active (pending+running)
   * jobs held in `job-queue.json`. `enqueue()` refuses new jobs once this is
   * reached (logging a warning) rather than growing the active set without
   * bound — `flush()` already capped only the completed/failed tail at 100.
   */
  maxActiveJobs: z.number().int().positive().default(1000),
});

export const ReviewConfigSchema = z.object({
  analysisEnabled: z.boolean().default(true),
  confidenceEscalationThreshold: z.number().min(0).max(1).default(0.7),
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

export const SearchConfigSchema = z.object({
  /** When true, keyword search runs first and semantic search only fires
   * as a fallback on low keyword confidence, instead of running
   * unconditionally on every query. Defaults off — see the
   * semantic-latency-fallback design spec's rollout-care requirement. */
  semanticFallbackEnabled: z.boolean().default(false),
  /**
   * Fix D (resource-boundedness): number of changed-file bodies `FTSIndex.sync()`
   * reads into memory and commits per batch, instead of pre-reading every
   * changed file's full body into one array before the write transaction. On
   * a first `--populate-fts` or after a bulk mtime-touching resync (e.g. a
   * OneDrive re-sync), that unbounded array held ~22k file bodies (100s of
   * MB) at once. Bounds peak memory to `ftsSyncBatchSize` bodies at a time.
   */
  ftsSyncBatchSize: z.number().int().positive().default(500),
});

/**
 * Shared MCP daemon (docs/superpowers/specs/2026-08-06-shared-mcp-daemon-
 * design.md): the long-lived HTTP transport that consolidates the per-window
 * stdio MCP servers + the launchd tick into one process. Binds loopback-only
 * by default; `authToken`, when set, is validated against the `Authorization`
 * header by the HTTP transport (optional hardening — default is no token).
 */
export const DaemonConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(8765),
  /** Scheduler tick cadence (ms) — replaces the standalone launchd `com.karpathy.tick` job. */
  tickIntervalMs: z.number().int().positive().default(300_000),
  /** MCP session idle timeout (ms) before the HTTP transport closes it. */
  sessionIdleTimeoutMs: z.number().int().positive().default(1_800_000),
  /** `--max-old-space-size` (MB) applied to the daemon process. */
  heapMb: z.number().int().positive().default(512),
  /** Optional bearer token for `Authorization` header validation. Unset = loopback trust. */
  authToken: z.string().optional(),
  /** Enables the event-loop watchdog that detects a wedged daemon process. */
  watchdogEnabled: z.boolean().default(true),
  /** Max ms the watchdog allows the event loop to go unresponsive before acting. */
  watchdogTimeoutMs: z.number().int().positive().default(30_000),
  /** Watchdog heartbeat cadence (ms). */
  watchdogHeartbeatMs: z.number().int().positive().default(1_000),
  /** Max ms a scheduler-tick child process may run before it is treated as stuck. */
  schedulerChildMaxRuntimeMs: z.number().int().positive().default(600_000),
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
  jobs: JobsConfigSchema.default({}),
  review: ReviewConfigSchema.default({}),
  layout: LayoutConfigSchema.default({}),
  search: SearchConfigSchema.default({}),
  daemon: DaemonConfigSchema.default({}),
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
const PartialJobsConfigSchema = JobsConfigSchema.partial();
const PartialReviewConfigSchema = ReviewConfigSchema.partial();
const PartialLayoutConfigSchema = LayoutConfigSchema.partial();
const PartialSearchConfigSchema = SearchConfigSchema.partial();
const PartialDaemonConfigSchema = DaemonConfigSchema.partial();

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
  jobs: PartialJobsConfigSchema.optional(),
  review: PartialReviewConfigSchema.optional(),
  layout: PartialLayoutConfigSchema.optional(),
  search: PartialSearchConfigSchema.optional(),
  daemon: PartialDaemonConfigSchema.optional(),
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
  jobs: PartialJobsConfigSchema.optional(),
  review: PartialReviewConfigSchema.optional(),
  layout: PartialLayoutConfigSchema.optional(),
  search: PartialSearchConfigSchema.optional(),
  daemon: PartialDaemonConfigSchema.optional(),
});

export const GlobalConfigSchema = z.object({
  defaults: GlobalDefaultsSchema.default({}),
  projects: z.record(z.string(), ProjectOverrideSchema).default({}),
});

export type KarpathyConfig = z.infer<typeof KarpathyConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type ProjectOverride = z.infer<typeof ProjectOverrideSchema>;

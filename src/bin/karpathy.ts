import { resolve, join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load .env from project root synchronously so env vars are available before any client is created
try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
  const env = readFileSync(join(root, '.env'), 'utf-8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* no .env — fine */ }
import { ensureDir } from '../shared/fs-utils.js';
import { DEFAULT_VAULT_DIRS, GLOBAL_CONFIG_PATH } from '../config/defaults.js';
import { loadConfig, loadConfigOrNull } from '../config/loader.js';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { createJobQueue } from '../jobs/queue.js';
import { createFileLock } from '../jobs/lock.js';
import { createJobRunner } from '../jobs/runner.js';
import { createHandlerRegistry } from '../jobs/handlers/index.js';
import { resolveStateDir, resolveLockDir } from '../config/defaults.js';
import { createBedrockClient, createLiteLLMClient, createNoopClient } from '../enrichment/llm-client.js';
import { dispatchHook } from '../hooks/dispatch.js';
import { ingestFile } from '../ingest/pipeline.js';
import { detectContradictions, writeContradictionReview } from '../review/contradiction-detector.js';
import { detectDuplicates, writeDuplicateReview } from '../review/duplicate-detector.js';
import { listReviewItems, approveReviewItem, rejectReviewItem } from '../review/review-queue.js';
import { migrateVault } from '../migration/migrate-vault.js';
import { migrateProjectsToHubs } from '../migration/migrate-project-hubs.js';
import { migrateMarkers } from '../migration/migrate-markers.js';
import { exportSessionToRaw } from '../session/export-session.js';
import { mergeEntities, detectMergeCandidates, autoMerge } from '../compilation/entity-merger.js';
import {
  readReconciliationQueue,
  refreshQueue,
  resolveEntry,
  pendingEntries,
} from '../maintenance/reconciliation-queue.js';
import { buildEntityIndex, resolveEntity } from '../ingest/entity-resolver.js';
import type { EntityKind } from '../ingest/entity-resolver.js';
import { rebuildAllBacklinks } from '../maintenance/backlinks.js';
import { rebuildAllIndexes } from '../maintenance/indexes.js';
import { seedBuiltinSkills, loadSkills } from '../agent/skills/registry.js';
import { archiveCurrentSpec, listSupersededVersions } from '../specs/versioner.js';
import { intelCommand } from './intel-command.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { createLogger } from '../shared/logger.js';
import type { KarpathyConfig } from '../config/schema.js';
import { LLMConfigSchema, IngestConfigSchema, MaintenanceConfigSchema } from '../config/schema.js';

const log = createLogger('cli');

function createLLMFromConfig(config: KarpathyConfig) {
  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    return createLiteLLMClient({
      baseUrl,
      apiKey,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
    });
  }
  if (config.llm.provider === 'bedrock') {
    return createBedrockClient({
      region: config.llm.region,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
  }
  return createNoopClient();
}

const CLAUDE_MD_TEMPLATE = `# Karpathy Second Memory

## Active Context
${OPEN_TAG('active-context')}
No active context yet. Start a Claude Code session to begin capturing knowledge.
${CLOSE_TAG('active-context')}

## Recent Sessions
${OPEN_TAG('recent-sessions')}
No sessions captured yet.
${CLOSE_TAG('recent-sessions')}

## Key Entities
${OPEN_TAG('key-entities')}
No entities extracted yet.
${CLOSE_TAG('key-entities')}

## Quick Links
${OPEN_TAG('quick-links')}
Indexes will be generated after the first maintenance run.
${CLOSE_TAG('quick-links')}
`;

const WIKI_INDEX_TEMPLATE = `---
id: wiki-index
type: index
title: Wiki Index
status: active
created_at: ${new Date().toISOString()}
updated_at: ${new Date().toISOString()}
source_refs: []
derived_from: []
aliases: []
links: []
change_origin: deterministic_maintenance
protected_regions:
  - pages
---

# Wiki Index

${OPEN_TAG('pages')}
No pages yet. Pages will be listed here after the first maintenance run.
${CLOSE_TAG('pages')}
`;

async function initCommand(vaultPath?: string): Promise<void> {
  const root = resolve(process.cwd());
  const vault = resolve(root, vaultPath ?? 'vault');

  log.info('Initializing Karpathy vault', { vault });

  // Create vault directories
  for (const dir of DEFAULT_VAULT_DIRS) {
    await ensureDir(join(vault, dir));
  }

  // Create .karpathy state dirs in project root
  await ensureDir(join(root, '.karpathy', 'state'));
  await ensureDir(join(root, '.karpathy', 'locks'));
  await ensureDir(join(root, '.karpathy', 'logs'));

  // Write CLAUDE.md
  const claudeMdPath = join(vault, 'CLAUDE.md');
  await writeFile(claudeMdPath, CLAUDE_MD_TEMPLATE, 'utf-8');

  // Write wiki index
  const indexPath = join(vault, 'wiki', '_index.md');
  await writeFile(indexPath, WIKI_INDEX_TEMPLATE, 'utf-8');

  // Write/update global config at ~/.karpathy/config.json
  await ensureDir(join(GLOBAL_CONFIG_PATH, '..'));

  let globalConfig: { defaults?: Record<string, unknown>; projects?: Record<string, unknown> } = {};
  try {
    const existing = await import('node:fs/promises').then((fs) =>
      fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'),
    );
    globalConfig = JSON.parse(existing) as typeof globalConfig;
  } catch {
    // No existing global config — start fresh
  }

  if (!globalConfig.defaults) {
    const llmDefaults = LLMConfigSchema.parse({});
    const ingestDefaults = IngestConfigSchema.parse({});
    const maintDefaults = MaintenanceConfigSchema.parse({});
    globalConfig.defaults = {
      vaultPath: vault,
      llm: { provider: llmDefaults.provider, region: llmDefaults.region, model: llmDefaults.model },
      ingest: { watchEnabled: ingestDefaults.watchEnabled, watchPaths: ingestDefaults.watchPaths },
      maintenance: { autoBacklinks: maintDefaults.autoBacklinks, autoIndexes: maintDefaults.autoIndexes, reviewEnabled: maintDefaults.reviewEnabled },
    };
  }

  if (!globalConfig.projects) globalConfig.projects = {};

  await writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2) + '\n', 'utf-8');

  log.info('Vault initialized successfully', { globalConfigPath: GLOBAL_CONFIG_PATH, claudeMdPath });
  process.stdout.write(
    `Vault initialized at ${vault}\nGlobal config updated at ${GLOBAL_CONFIG_PATH}\n`,
  );
}

async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  const wikiFiles = await vault.listMarkdownFiles(config.layout.wiki);
  const rawFiles = await vault.listFiles('raw');
  const sessionFiles = await vault.listMarkdownFiles(config.layout.aiSummaries);
  const reviewFiles = await vault.listMarkdownFiles(config.layout.review);

  process.stdout.write(
    [
      `Karpathy Second Memory`,
      `  Vault: ${config.vaultPath}`,
      `  Wiki pages: ${wikiFiles.length}`,
      `  Raw files: ${rawFiles.length}`,
      `  Session summaries: ${sessionFiles.length}`,
      `  Review items: ${reviewFiles.length}`,
      '',
    ].join('\n'),
  );
}

async function maintainCommand(): Promise<void> {
  const config = await loadConfig();
  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');

  const queue = createJobQueue(queuePath);
  await queue.load();

  // Enqueue maintenance jobs
  if (config.maintenance.autoBacklinks) {
    await queue.enqueue({
      type: 'update-backlinks',
      priority: 10,
      trigger: 'cli',
      dedupeKey: 'backlinks:full',
      debounceMs: 0,
    });
  }

  if (config.maintenance.autoIndexes) {
    await queue.enqueue({
      type: 'rebuild-index',
      priority: 10,
      trigger: 'cli',
      dedupeKey: 'index:wiki',
      debounceMs: 0,
    });
  }

  const vault = createFsAdapter(config.vaultPath);
  const llm = createLLMFromConfig(config);
  const lock = createFileLock(lockDir);
  const handlers = createHandlerRegistry();
  const runner = createJobRunner({
    queue,
    lock,
    handlers,
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm,
    vault,
    config,
  });

  const processed = await runner.runAll();
  process.stdout.write(`Maintenance complete. ${processed} job(s) processed.\n`);
}

async function drainQueueCommand(): Promise<void> {
  const config = await loadConfig();
  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const lock = createFileLock(lockDir);

  // Global drain lock — only one drain process at a time
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lock.acquire('__drain__', 1000);
  } catch {
    // Another drain is already running — exit silently
    return;
  }

  try {
    const queuePath = join(stateDir, 'job-queue.json');
    const queue = createJobQueue(queuePath);
    await queue.load();

    if (queue.size() === 0) return;

    const vault = createFsAdapter(config.vaultPath);
    const llm = createLLMFromConfig(config);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });

    const processed = await runner.runAll();
    log.info('Background drain complete', { processed });
  } finally {
    if (release) await release();
  }
}

async function ingestCommand(args: string[]): Promise<void> {
  const enrich = args.includes('--enrich');
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath) {
    process.stderr.write('Usage: karpathy ingest <file-path> [--enrich]\n');
    process.exit(1);
  }

  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const result = await ingestFile(filePath, vault, config.layout);
  process.stdout.write(
    [
      `Ingested: ${result.rawPath}`,
      `  Source type: ${result.sourceType}`,
      `  Summary: ${result.sourceSummaryPath}`,
      `  Hash: ${result.sourceHash}`,
      '',
    ].join('\n'),
  );

  if (enrich) {
    const stateDir = resolveStateDir(config);
    const lockDir = resolveLockDir(config);
    const queuePath = join(stateDir, 'job-queue.json');
    const queue = createJobQueue(queuePath);
    await queue.load();

    // Enqueue classify-source to kick off the enrichment cascade
    await queue.enqueue({
      type: 'classify-source',
      targetPath: result.sourceSummaryPath,
      payload: { rawPath: result.rawPath, sourceHash: result.sourceHash },
      trigger: 'cli',
      priority: 30,
    });

    const llm = createLLMFromConfig(config);
    const lock = createFileLock(lockDir);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });

    const processed = await runner.runAll();
    process.stdout.write(`Enrichment complete. ${processed} job(s) processed.\n`);
  }
}

async function hookCommand(eventName: string): Promise<void> {
  const config = await loadConfigOrNull();
  if (!config) return;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  const input = raw.trim() ? JSON.parse(raw) : {};

  const result = await dispatchHook(eventName, input, config);
  if (result) {
    process.stdout.write(JSON.stringify(result));
  }
}

async function reviewCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const subcommand = args[0];

  if (subcommand === 'detect') {
    const contradictions = await detectContradictions(vault);
    for (const c of contradictions) {
      await writeContradictionReview(vault, c);
    }

    const duplicates = await detectDuplicates(vault);
    for (const d of duplicates) {
      await writeDuplicateReview(vault, d);
    }

    process.stdout.write(
      `Found ${contradictions.length} contradiction(s) and ${duplicates.length} duplicate(s).\n`,
    );
    return;
  }

  if (subcommand === 'approve' && args[1]) {
    await approveReviewItem(vault, args[1]);
    process.stdout.write(`Approved: ${args[1]}\n`);
    return;
  }

  if (subcommand === 'reject' && args[1]) {
    await rejectReviewItem(vault, args[1]);
    process.stdout.write(`Rejected: ${args[1]}\n`);
    return;
  }

  // Default: list review items
  const items = await listReviewItems(vault);
  if (items.length === 0) {
    process.stdout.write('Review queue is empty.\n');
    return;
  }

  process.stdout.write(`Review queue (${items.length} items):\n`);
  for (const item of items) {
    process.stdout.write(`  [${item.reviewState}] ${item.title} — ${item.path}\n`);
  }
}

async function migrateCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  process.stdout.write('Starting vault migration...\n');
  const result = await migrateVault(vault);

  process.stdout.write(
    [
      `Migration complete:`,
      `  Source summaries deleted: ${result.sourceSummariesDeleted}`,
      `  Entities backfilled: ${result.entitiesBackfilled}`,
      `  Projects backfilled: ${result.projectsBackfilled}`,
      `  Concepts backfilled: ${result.conceptsBackfilled}`,
      `  Skipped: ${result.skipped.length}`,
      `  Errors: ${result.errors.length}`,
      '',
    ].join('\n'),
  );

  if (result.skipped.length > 0) {
    process.stdout.write('Skipped:\n');
    for (const s of result.skipped) {
      process.stdout.write(`  ${s}\n`);
    }
  }

  if (result.errors.length > 0) {
    process.stderr.write('Errors:\n');
    for (const e of result.errors) {
      process.stderr.write(`  ${e}\n`);
    }
  }
}

async function migrateHubsCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  process.stdout.write('Migrating legacy project pages to hub model...\n');
  const result = await migrateProjectsToHubs(vault);

  process.stdout.write(
    [
      `Migration complete:`,
      `  Migrated: ${result.migrated.length}`,
      `  Skipped: ${result.skipped.length}`,
      `  Errors: ${result.errors.length}`,
      '',
    ].join('\n'),
  );

  if (result.migrated.length > 0) {
    process.stdout.write('Migrated:\n');
    for (const m of result.migrated) {
      process.stdout.write(`  ${m}\n`);
    }
  }

  if (result.skipped.length > 0) {
    process.stdout.write('Skipped:\n');
    for (const s of result.skipped) {
      process.stdout.write(`  ${s}\n`);
    }
  }

  if (result.errors.length > 0) {
    process.stderr.write('Errors:\n');
    for (const e of result.errors) {
      process.stderr.write(`  ${e}\n`);
    }
  }

  // Rebuild indexes after migration
  if (result.migrated.length > 0) {
    process.stdout.write('\nRebuilding indexes...\n');
    await rebuildAllIndexes(vault);
    process.stdout.write('Done.\n');
  }
}

async function migrateMarkersCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  process.stdout.write('Migrating protected region markers to %% syntax...\n');
  const result = await migrateMarkers(vault);

  process.stdout.write(
    [
      `Migration complete:`,
      `  Files scanned: ${result.filesScanned}`,
      `  Files modified: ${result.filesModified}`,
      `  Markers replaced: ${result.markersReplaced}`,
      '',
    ].join('\n'),
  );
}

async function reingestCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  // Find all files in raw/
  const filesToIngest = await vault.listFiles('raw');

  if (filesToIngest.length === 0) {
    process.stdout.write('No raw files found to re-ingest.\n');
    return;
  }

  process.stdout.write(`Found ${filesToIngest.length} raw file(s) to re-ingest.\n`);

  const enrich = !args.includes('--no-enrich');
  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  const queue = createJobQueue(queuePath);
  await queue.load();

  // Ingest each raw file
  let ingested = 0;
  for (const rawRelPath of filesToIngest) {
    try {
      // Resolve to absolute path for ingestFileCore
      const absPath = join(config.vaultPath, rawRelPath);
      const result = await ingestFile(absPath, vault, config.layout);
      ingested++;
      process.stdout.write(`  [${ingested}/${filesToIngest.length}] ${rawRelPath} → ${result.sourceSummaryPath}\n`);

      if (enrich) {
        await queue.enqueue({
          type: 'classify-source',
          targetPath: result.sourceSummaryPath,
          payload: { rawPath: result.rawPath, sourceHash: result.sourceHash },
          trigger: 'cli',
          priority: 30,
        });
      }
    } catch (err) {
      process.stderr.write(`  FAILED: ${rawRelPath}: ${(err as Error).message}\n`);
    }
  }

  process.stdout.write(`\nIngested ${ingested}/${filesToIngest.length} files.\n`);

  if (enrich && ingested > 0) {
    process.stdout.write('Running enrichment pipeline...\n');
    const llm = createLLMFromConfig(config);
    const lock = createFileLock(lockDir);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });

    const processed = await runner.runAll();
    process.stdout.write(`Enrichment complete. ${processed} job(s) processed.\n`);
  }
}

async function installMcpCommand(): Promise<void> {
  const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const serverPath = resolve(process.cwd(), 'dist', 'mcp', 'server.js');
  const registered: string[] = [];

  const mcpEntry = {
    command: 'node',
    args: [serverPath],
  };

  // 1. Claude Code — ~/.claude/settings.json (under mcpServers)
  const claudeSettingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    let claudeSettings: Record<string, unknown>;
    try {
      claudeSettings = JSON.parse(await rf(claudeSettingsPath, 'utf-8'));
    } catch {
      claudeSettings = {};
    }
    const mcpServers = (claudeSettings.mcpServers ?? {}) as Record<string, unknown>;
    mcpServers.karpathy = mcpEntry;
    claudeSettings.mcpServers = mcpServers;
    await ensureDir(join(homedir(), '.claude'));
    await wf(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2) + '\n', 'utf-8');
    registered.push(`  Claude Code: ${claudeSettingsPath}`);
  } catch (err) {
    log.error('Failed to register in Claude Code', { error: (err as Error).message });
  }

  // 2. Claude Desktop — ~/Library/Application Support/Claude/claude_desktop_config.json (under mcpServers)
  const claudeDesktopPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  try {
    let desktopConfig: Record<string, unknown>;
    try {
      desktopConfig = JSON.parse(await rf(claudeDesktopPath, 'utf-8'));
    } catch {
      desktopConfig = {};
    }
    const desktopServers = (desktopConfig.mcpServers ?? {}) as Record<string, unknown>;
    desktopServers.karpathy = mcpEntry;
    desktopConfig.mcpServers = desktopServers;
    await ensureDir(join(homedir(), 'Library', 'Application Support', 'Claude'));
    await wf(claudeDesktopPath, JSON.stringify(desktopConfig, null, 2) + '\n', 'utf-8');
    registered.push(`  Claude Desktop: ${claudeDesktopPath}`);
  } catch (err) {
    log.error('Failed to register in Claude Desktop', { error: (err as Error).message });
  }

  // 3. Cursor IDE — ~/.cursor/mcp.json (under mcpServers)
  const cursorMcpPath = join(homedir(), '.cursor', 'mcp.json');
  try {
    let cursorConfig: Record<string, unknown>;
    try {
      cursorConfig = JSON.parse(await rf(cursorMcpPath, 'utf-8'));
    } catch {
      cursorConfig = {};
    }
    const cursorServers = (cursorConfig.mcpServers ?? {}) as Record<string, unknown>;
    cursorServers.karpathy = mcpEntry;
    cursorConfig.mcpServers = cursorServers;
    await ensureDir(join(homedir(), '.cursor'));
    await wf(cursorMcpPath, JSON.stringify(cursorConfig, null, 2) + '\n', 'utf-8');
    registered.push(`  Cursor IDE: ${cursorMcpPath}`);
  } catch (err) {
    log.error('Failed to register in Cursor', { error: (err as Error).message });
  }

  // 4. ChatGPT Desktop (Atlas) — ~/Library/Application Support/com.openai.atlas/mcp.json
  //    Note: ChatGPT Desktop may require manual setup via Settings > Tools in the app UI.
  //    We write the config file in case the app reads from it.
  const chatgptPath = join(homedir(), 'Library', 'Application Support', 'com.openai.atlas', 'mcp.json');
  try {
    let chatgptConfig: Record<string, unknown>;
    try {
      chatgptConfig = JSON.parse(await rf(chatgptPath, 'utf-8'));
    } catch {
      chatgptConfig = {};
    }
    const chatgptServers = (chatgptConfig.mcpServers ?? {}) as Record<string, unknown>;
    chatgptServers.karpathy = mcpEntry;
    chatgptConfig.mcpServers = chatgptServers;
    await ensureDir(join(homedir(), 'Library', 'Application Support', 'com.openai.atlas'));
    await wf(chatgptPath, JSON.stringify(chatgptConfig, null, 2) + '\n', 'utf-8');
    registered.push(`  ChatGPT Desktop: ${chatgptPath}`);
  } catch (err) {
    log.error('Failed to register in ChatGPT Desktop', { error: (err as Error).message });
  }

  process.stdout.write(`MCP server registered in:\n${registered.join('\n')}\n`);
  process.stdout.write('\nNote: Restart each application to pick up the new MCP server.\n');
  process.stdout.write('ChatGPT Desktop may require manual setup via Settings > Tools.\n');
}

/**
 * Merge Karpathy hooks into existing settings hooks, preserving non-Karpathy entries.
 * Karpathy hooks are identified by their command containing 'karpathy.js hook'.
 */
export function mergeHooks(
  existingHooks: Record<string, unknown[]>,
  karpathyHooks: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const isKarpathyHook = (entry: unknown): boolean => {
    const e = entry as { hooks?: Array<{ command?: string }> };
    return e?.hooks?.some?.((h) => typeof h.command === 'string' && h.command.includes('karpathy.js hook')) ?? false;
  };

  const merged: Record<string, unknown[]> = { ...existingHooks };

  for (const [event, entries] of Object.entries(karpathyHooks)) {
    const existing = (existingHooks[event] ?? []) as unknown[];
    const nonKarpathy = existing.filter((e) => !isKarpathyHook(e));
    merged[event] = [...nonKarpathy, ...entries];
  }

  return merged;
}

async function installHooksCommand(): Promise<void> {
  const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const distPath = resolve(process.cwd(), 'dist', 'bin', 'karpathy.js');

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await rf(settingsPath, 'utf-8'));
  } catch {
    settings = {};
  }

  const cmd = (event: string) => `node ${distPath} hook ${event}`;

  const karpathyHooks: Record<string, unknown[]> = {
    SessionStart: [
      { hooks: [{ type: 'command', command: cmd('session-start'), timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: cmd('user-prompt-submit'), timeout: 5, async: true }] },
    ],
    PostToolUse: [
      { hooks: [{ type: 'command', command: cmd('post-tool-use'), timeout: 5, async: true }] },
    ],
    PostCompact: [
      { hooks: [{ type: 'command', command: cmd('post-compact'), timeout: 5 }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: cmd('stop'), timeout: 10 }] },
    ],
  };

  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  settings.hooks = mergeHooks(existingHooks, karpathyHooks);
  await ensureDir(join(homedir(), '.claude'));
  await wf(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  process.stdout.write(`Hooks installed to ${settingsPath}\n`);
}

async function importSessionsCommand(args: string[]): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  const { homedir } = await import('node:os');

  const config = await loadConfig();
  const stateDir = resolveStateDir(config);
  const allFlag = args.includes('--all');
  const enrich = args.includes('--enrich');
  const projectArg = args.find((_, i) => args[i - 1] === '--project');
  const projectCwd = projectArg ?? process.cwd();

  // Resolve Claude Code projects directory
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  // Find project directories to scan
  let projectDirs: string[];
  if (allFlag) {
    try {
      const entries = await readdir(claudeProjectsDir);
      projectDirs = entries.map((e) => join(claudeProjectsDir, e));
    } catch {
      process.stderr.write('No Claude Code projects found.\n');
      return;
    }
  } else {
    // Encode cwd to match Claude Code's directory naming: /foo/bar → -foo-bar
    const encoded = projectCwd.replace(/\//g, '-');
    projectDirs = [join(claudeProjectsDir, encoded)];
  }

  let total = 0;
  let exported = 0;
  let skipped = 0;
  const exportedPaths: string[] = [];

  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      total++;
      try {
        const result = await exportSessionToRaw(
          join(dir, file),
          stateDir,
          { minTurns: config.session.minTurns },
        );

        if (result.exported && result.stagingPath) {
          exported++;
          exportedPaths.push(result.stagingPath);
          process.stdout.write(`  Exported: ${file} → ${result.stagingPath}\n`);
        } else {
          skipped++;
          log.debug('Skipped session', { file, reason: result.reason });
        }
      } catch (err) {
        skipped++;
        process.stderr.write(`  Failed: ${file}: ${(err as Error).message}\n`);
      }
    }
  }

  process.stdout.write(
    `\nSessions: ${exported} exported, ${skipped} skipped, ${total} total.\n`,
  );

  if (enrich && exportedPaths.length > 0) {
    process.stdout.write('Running ingest pipeline...\n');
    const lockDir = resolveLockDir(config);
    const queuePath = join(stateDir, 'job-queue.json');
    const queue = createJobQueue(queuePath);
    await queue.load();

    for (const stagingPath of exportedPaths) {
      await queue.enqueue({
        type: 'ingest-raw-file',
        payload: { filePath: stagingPath },
        trigger: 'cli',
        priority: 20,
      });
    }

    const vault = createFsAdapter(config.vaultPath);
    const llm = createLLMFromConfig(config);
    const lock = createFileLock(lockDir);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });

    const processed = await runner.runAll();
    process.stdout.write(`Enrichment complete. ${processed} job(s) processed.\n`);
  }
}

async function importCursorSessionsCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const stateDir = resolveStateDir(config);
  const enrich = args.includes('--enrich');

  const { importNewCursorSessions } = await import('../session/import-cursor-sessions.js');
  const result = await importNewCursorSessions(config, stateDir, { verbose: true });
  const { total, exported, skipped, exportedPaths } = result;

  process.stdout.write(
    `\nCursor sessions: ${exported} exported, ${skipped} skipped, ${total} total.\n`,
  );

  if (enrich && exportedPaths.length > 0) {
    process.stdout.write('Running ingest pipeline...\n');
    const lockDir = resolveLockDir(config);
    const queuePath = join(stateDir, 'job-queue.json');
    const queue = createJobQueue(queuePath);
    await queue.load();

    for (const stagingPath of exportedPaths) {
      await queue.enqueue({
        type: 'ingest-raw-file',
        payload: { filePath: stagingPath },
        trigger: 'cli',
        priority: 20,
      });
    }

    const vault = createFsAdapter(config.vaultPath);
    const llm = createLLMFromConfig(config);
    const lock = createFileLock(lockDir);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });

    const processed = await runner.runAll();
    process.stdout.write(`Enrichment complete. ${processed} job(s) processed.\n`);
  }
}

async function cleanCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  const foldersToDelete = ['wiki', 'outputs', 'review', 'indexes'];
  let deleted = 0;

  for (const folder of foldersToDelete) {
    try {
      const files = await vault.listFiles(folder);
      for (const file of files) {
        await vault.delete(file);
        deleted++;
      }
      process.stdout.write(`  Deleted ${files.length} file(s) from ${folder}/\n`);
    } catch {
      // Folder may not exist
    }
  }

  // Reset CLAUDE.md
  const claudeMdPath = join(config.vaultPath, 'CLAUDE.md');
  await writeFile(claudeMdPath, CLAUDE_MD_TEMPLATE, 'utf-8');
  process.stdout.write('  Reset CLAUDE.md\n');

  // Clear job queue
  const stateDir = resolveStateDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  await writeFile(queuePath, '[]', 'utf-8');
  process.stdout.write('  Cleared job queue\n');

  // Recreate vault directories
  for (const dir of DEFAULT_VAULT_DIRS) {
    await ensureDir(join(config.vaultPath, dir));
  }

  // Write fresh wiki index
  const indexPath = join(config.vaultPath, 'wiki', '_index.md');
  await writeFile(indexPath, WIKI_INDEX_TEMPLATE, 'utf-8');

  process.stdout.write(`\nClean complete. Deleted ${deleted} files. Raw sources preserved.\n`);
}

async function mergeCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  const autoFlag = args.includes('--auto');
  const detectFlag = args.includes('--detect');

  if (detectFlag) {
    // Detect potential merge candidates
    const candidates = await detectMergeCandidates(vault);
    if (candidates.length === 0) {
      process.stdout.write('No merge candidates detected.\n');
      return;
    }
    process.stdout.write(`Found ${candidates.length} merge candidate(s):\n`);
    for (const c of candidates) {
      process.stdout.write(
        `  [${(c.confidence * 100).toFixed(0)}%] "${c.sourceName}" → "${c.targetName}"\n` +
        `         Reason: ${c.reason}\n` +
        `         Paths: ${c.sourcePath} → ${c.targetPath}\n`,
      );
    }
    return;
  }

  if (autoFlag) {
    // Auto-merge high-confidence duplicates
    const threshold = parseFloat(args.find((a) => a.startsWith('--threshold='))?.split('=')[1] ?? '0.85');
    const results = await autoMerge(vault, threshold);
    if (results.length === 0) {
      process.stdout.write('No high-confidence duplicates found to auto-merge.\n');
      return;
    }
    process.stdout.write(`Auto-merged ${results.length} entity pair(s):\n`);
    for (const r of results) {
      process.stdout.write(`  ${r.deletedPath} → ${r.targetPath}\n`);
    }

    // Rebuild backlinks and indexes after merges
    process.stdout.write('Rebuilding backlinks and indexes...\n');
    await rebuildAllBacklinks(vault);
    await rebuildAllIndexes(vault);
    process.stdout.write('Done.\n');
    return;
  }

  // Manual merge: karpathy merge <source> <target>
  const nonFlagArgs = args.filter((a) => !a.startsWith('--'));
  if (nonFlagArgs.length < 2) {
    process.stderr.write(
      'Usage: karpathy merge <source-name> <target-name>\n' +
      '       karpathy merge --detect        Detect potential duplicates\n' +
      '       karpathy merge --auto           Auto-merge high-confidence duplicates\n',
    );
    process.exit(1);
  }

  const sourceName = nonFlagArgs[0];
  const targetName = nonFlagArgs[1];

  // Resolve names to paths using entity index
  const index = await buildEntityIndex(vault);

  // Try each entity kind to find matches
  const kinds: EntityKind[] = ['person', 'project', 'concept', 'topic', 'decision', 'tool', 'organization'];
  let sourcePath: string | null = null;
  let targetPath: string | null = null;

  for (const kind of kinds) {
    if (!sourcePath) {
      const sr = resolveEntity({ name: sourceName, kind }, index);
      if (sr.status === 'matched') sourcePath = sr.matchedPath!;
    }
    if (!targetPath) {
      const tr = resolveEntity({ name: targetName, kind }, index);
      if (tr.status === 'matched') targetPath = tr.matchedPath!;
    }
  }

  if (!sourcePath) {
    process.stderr.write(`Could not find entity: "${sourceName}"\n`);
    process.exit(1);
  }
  if (!targetPath) {
    process.stderr.write(`Could not find entity: "${targetName}"\n`);
    process.exit(1);
  }

  process.stdout.write(`Merging "${sourceName}" (${sourcePath})\n    into "${targetName}" (${targetPath})\n`);

  const result = await mergeEntities(sourcePath, targetPath, vault);

  process.stdout.write(
    [
      `Merge complete:`,
      `  Aliases added: ${result.aliasesAdded.join(', ') || 'none'}`,
      `  Source refs added: ${result.sourceRefsAdded.length}`,
      `  Regions updated: ${result.regionsUpdated.join(', ') || 'none'}`,
      `  Wikilinks rewritten: ${result.wikilinksRewritten}`,
      `  Deleted: ${result.deletedPath}`,
      '',
    ].join('\n'),
  );

  // Rebuild backlinks and indexes
  process.stdout.write('Rebuilding backlinks and indexes...\n');
  await rebuildAllBacklinks(vault);
  await rebuildAllIndexes(vault);
  process.stdout.write('Done.\n');
}

async function synthesizeCommand(args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) {
    process.stderr.write('Usage: karpathy synthesize <project-slug>\n');
    process.exit(1);
  }

  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  // Check project hub exists
  const indexPath = `wiki/projects/${slug}/_index.md`;
  if (!(await vault.exists(indexPath))) {
    process.stderr.write(`Project hub not found: ${indexPath}\n`);
    process.exit(1);
  }

  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  const queue = createJobQueue(queuePath);
  await queue.load();

  await queue.enqueue({
    type: 'agent-synthesize-project',
    payload: { projectSlug: slug },
    trigger: 'cli',
    priority: 35,
    dedupeKey: `synthesize:${slug}`,
  });

  const llm = createLLMFromConfig(config);
  const lock = createFileLock(lockDir);
  const handlers = createHandlerRegistry();
  const runner = createJobRunner({
    queue,
    lock,
    handlers,
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm,
    vault,
    config,
  });

  process.stdout.write(`Starting full re-synthesis for "${slug}"...\n`);
  const processed = await runner.runAll();
  process.stdout.write(`Re-synthesis complete. ${processed} job(s) processed.\n`);
}

async function checkDecayCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  const queue = createJobQueue(queuePath);
  await queue.load();

  await queue.enqueue({
    type: 'check-confidence-decay',
    trigger: 'cli',
    priority: 85,
    dedupeKey: 'confidence-decay',
  });

  const llm = createLLMFromConfig(config);
  const lock = createFileLock(lockDir);
  const handlers = createHandlerRegistry();
  const runner = createJobRunner({
    queue,
    lock,
    handlers,
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm,
    vault,
    config,
  });

  process.stdout.write('Checking confidence decay...\n');
  const processed = await runner.runAll();
  process.stdout.write(`Confidence decay check complete. ${processed} job(s) processed.\n`);
}

async function crossProjectCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  const queue = createJobQueue(queuePath);
  await queue.load();

  await queue.enqueue({
    type: 'detect-cross-project-patterns',
    trigger: 'cli',
    priority: 85,
    dedupeKey: 'cross-project',
  });

  const llm = createLLMFromConfig(config);
  const lock = createFileLock(lockDir);
  const handlers = createHandlerRegistry();
  const runner = createJobRunner({
    queue,
    lock,
    handlers,
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm,
    vault,
    config,
  });

  process.stdout.write('Detecting cross-project patterns...\n');
  const processed = await runner.runAll();
  process.stdout.write(`Cross-project analysis complete. ${processed} job(s) processed.\n`);
}

async function reprocessAgentCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  if (!config.agent.enabled) {
    process.stderr.write('Agent pipeline is not enabled. Set agent.enabled: true in config.\n');
    process.exit(1);
  }

  // Find all AI conversation source summaries that haven't been agent-processed
  const summaryFiles = await vault.listMarkdownFiles(config.layout.sources);
  const toProcess: Array<{
    summaryPath: string;
    rawPath: string;
    sourceHash: string;
    contentCategory: string;
    projectSlug: string;
  }> = [];

  for (const sp of summaryFiles) {
    try {
      const content = await vault.read(sp);
      const { parseNote } = await import('../vault/frontmatter.js');
      const { data } = parseNote(content);

      const category = data.content_category as string | undefined;
      const slug = data.project_slug as string | undefined;
      const rawPath = data.source_path as string | undefined;
      const hash = data.source_hash as string | undefined;
      const status = data.ingest_status as string | undefined;

      // Only process AI conversations with a project slug that haven't been agent-linked
      if (
        category &&
        category.startsWith('ai-conversation') &&
        slug &&
        rawPath &&
        hash &&
        status !== 'linked'
      ) {
        toProcess.push({
          summaryPath: sp,
          rawPath,
          sourceHash: hash,
          contentCategory: category,
          projectSlug: slug,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (toProcess.length === 0) {
    process.stdout.write('No unprocessed AI conversation summaries found.\n');
    return;
  }

  process.stdout.write(
    `Found ${toProcess.length} AI conversation(s) to process through agent pipeline.\n`,
  );

  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  const queue = createJobQueue(queuePath);
  await queue.load();

  for (const item of toProcess) {
    await queue.enqueue({
      type: 'agent-ingest',
      targetPath: item.summaryPath,
      payload: {
        sourceSummaryPath: item.summaryPath,
        rawPath: item.rawPath,
        sourceHash: item.sourceHash,
        contentCategory: item.contentCategory,
        projectSlug: item.projectSlug,
      },
      trigger: 'cli',
      priority: 25,
      dedupeKey: `agent-ingest:${item.sourceHash}`,
    });
    process.stdout.write(`  Enqueued: ${item.summaryPath} (${item.projectSlug})\n`);
  }

  process.stdout.write(`\nRunning agent pipeline (this may take a while)...\n`);

  const llm = createLLMFromConfig(config);
  const lock = createFileLock(lockDir);
  const handlers = createHandlerRegistry();
  const runner = createJobRunner({
    queue,
    lock,
    handlers,
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm,
    vault,
    config,
  });

  const processed = await runner.runAll();
  process.stdout.write(`Agent reprocessing complete. ${processed} job(s) processed.\n`);
}

async function skillsCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const subcommand = args[0];

  if (subcommand === 'generate') {
    const stateDir = resolveStateDir(config);
    const lockDir = resolveLockDir(config);
    const queuePath = join(stateDir, 'job-queue.json');
    const queue = createJobQueue(queuePath);
    await queue.load();

    await queue.enqueue({
      type: 'generate-synthesis-skills',
      trigger: 'cli',
      priority: 90,
      dedupeKey: 'generate-skills',
    });

    const llm = createLLMFromConfig(config);
    const lock = createFileLock(lockDir);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });

    process.stdout.write('Generating new synthesis skills from unmatched conversations...\n');
    const processed = await runner.runAll();
    process.stdout.write(`Skill generation complete. ${processed} job(s) processed.\n`);
    return;
  }

  if (subcommand === 'seed') {
    const count = await seedBuiltinSkills(vault, config.layout);
    process.stdout.write(`Seeded ${count} built-in skill(s).\n`);
    return;
  }

  // Default: list skills
  const skills = await loadSkills(vault, config.layout);
  if (skills.length === 0) {
    process.stdout.write('No skills found. Run "karpathy skills seed" to seed built-in skills.\n');
    return;
  }

  process.stdout.write(`Synthesis Skills (${skills.length}):\n`);
  for (const skill of skills) {
    const state = skill.review_state === 'approved' ? '[approved]' : `[${skill.review_state}]`;
    process.stdout.write(
      `  ${state} ${skill.name} (${skill.id}) — usage: ${skill.usage_count}, confidence: ${skill.confidence}\n`,
    );
  }
}

async function curatorCommand(): Promise<void> {
  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);
  const layout = config.layout;

  // Detect new candidates and append to queue.
  const candidates = await detectMergeCandidates(vault);
  const added = await refreshQueue(vault, candidates, layout);
  if (added > 0) {
    process.stdout.write(`Found ${added} new candidate(s). Refreshing queue...\n`);
  }

  const queue = await readReconciliationQueue(vault, layout);
  const pending = pendingEntries(queue);

  if (pending.length === 0) {
    process.stdout.write('Reconciliation queue is empty — no pending candidates.\n');
    return;
  }

  process.stdout.write(`\nReconciliation queue: ${pending.length} pending candidate(s).\n`);
  process.stdout.write('Decisions: [m]erge  [r]ename  [s]kip  [M]anual  [q]uit\n\n');

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  let processed = 0;

  for (const entry of pending) {
    const confidencePct = Math.round(entry.confidence * 100);
    process.stdout.write(
      `\n─────────────────────────────────────────\n` +
      `  Source:  "${entry.sourceName}"\n` +
      `           ${entry.sourcePath}\n` +
      `  Target:  "${entry.targetName}"\n` +
      `           ${entry.targetPath}\n` +
      `  Reason:  ${entry.reason}\n` +
      `  Score:   ${confidencePct}%\n`,
    );

    const answer = (await question('Decision [m/r/s/M/q]: ')).trim().toLowerCase();

    if (answer === 'q') {
      process.stdout.write('Exiting curator. Remaining entries stay pending.\n');
      break;
    }

    if (answer === 'm') {
      process.stdout.write(`Merging "${entry.sourceName}" → "${entry.targetName}"...\n`);
      const result = await mergeEntities(entry.sourcePath, entry.targetPath, vault);
      await resolveEntry(vault, entry.id, 'merge', undefined, layout);
      process.stdout.write(
        `  Aliases added: ${result.aliasesAdded.join(', ') || 'none'}\n` +
        `  Wikilinks rewritten: ${result.wikilinksRewritten}\n`,
      );
      processed++;
    } else if (answer === 'r') {
      const newName = (await question('  New canonical name: ')).trim();
      if (!newName) {
        process.stdout.write('  Skipping — no name provided.\n');
        continue;
      }
      process.stdout.write(`Merging with rename to "${newName}"...\n`);
      const result = await mergeEntities(entry.sourcePath, entry.targetPath, vault);
      await resolveEntry(vault, entry.id, 'rename', newName, layout);
      process.stdout.write(
        `  Aliases added: ${result.aliasesAdded.join(', ') || 'none'}\n` +
        `  Wikilinks rewritten: ${result.wikilinksRewritten}\n`,
      );
      processed++;
    } else if (answer === 's') {
      await resolveEntry(vault, entry.id, 'skip', undefined, layout);
      process.stdout.write('  Skipped.\n');
    } else if (answer === 'M') {
      await resolveEntry(vault, entry.id, 'manual', undefined, layout);
      process.stdout.write('  Marked manual — handle this pair directly.\n');
    } else {
      process.stdout.write('  Unknown input — skipping.\n');
    }
  }

  rl.close();

  if (processed > 0) {
    process.stdout.write('\nRebuilding backlinks and indexes...\n');
    await rebuildAllBacklinks(vault);
    await rebuildAllIndexes(vault);
    process.stdout.write(`Done. ${processed} merge(s) applied.\n`);
  } else {
    process.stdout.write('\nNo merges applied.\n');
  }
}

async function touchCommand(args: string[]): Promise<void> {
  const notePath = args[0];
  if (!notePath) {
    process.stderr.write('Usage: karpathy touch <note-path>\n');
    process.exit(1);
  }

  const config = await loadConfig();
  const vault = createFsAdapter(config.vaultPath);

  if (!(await vault.exists(notePath))) {
    process.stderr.write(`Note not found: ${notePath}\n`);
    process.exit(1);
  }

  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queuePath = join(stateDir, 'job-queue.json');
  const queue = createJobQueue(queuePath);
  await queue.load();

  await queue.enqueue({
    type: 're-enrich-note',
    targetPath: notePath,
    payload: { notePath },
    trigger: 'cli',
    priority: 55,
    dedupeKey: `re-enrich:${notePath}`,
  });

  const llm = createLLMFromConfig(config);
  const lock = createFileLock(lockDir);
  const handlers = createHandlerRegistry();
  const runner = createJobRunner({
    queue,
    lock,
    handlers,
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm,
    vault,
    config,
  });

  process.stdout.write(`Re-enriching ${notePath}...\n`);
  const processed = await runner.runAll();
  process.stdout.write(`Re-enrichment complete. ${processed} job(s) processed.\n`);
}

async function maintenanceCommand(args: string[]): Promise<void> {
  const populateFts = args.includes('--populate-fts');
  const reEmbed = args.includes('--re-embed');
  const pruneArg = args.find((a) => a.startsWith('--prune-provider'));
  const folderArgIdx = args.indexOf('--folder');
  const folderArg = folderArgIdx !== -1 ? args[folderArgIdx + 1] : undefined;

  if (!populateFts && !reEmbed && !pruneArg) {
    process.stderr.write(
      [
        'Usage: karpathy maintenance <flag>',
        '',
        'Flags:',
        '  --populate-fts          One-shot scan: build/refresh the FTS5 keyword index',
        '                          across every markdown file in the vault.',
        '  --re-embed [--folder <path>]  Re-run the embedding pipeline over vault notes.',
        '                          Defaults to the wiki folder. Use --folder to target',
        '                          any vault-relative path (e.g. "AI Conversations").',
        '  --prune-provider <id>   Delete every embedding row owned by <id>. Use after',
        '                          switching providers (e.g. titan-v2-1024 -> ollama).',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const config = await loadConfig();
  const projectRoot = config.projectRoot ?? process.cwd();

  if (populateFts) {
    const { openHybridStoreFromConfig } = await import('../search/factory.js');
    // Per design doc §2: cover the entire vault. The walker skips dotfiles
    // so .obsidian/, .git/, .trash/ are excluded automatically.
    const dirs = ['.'];
    const store = openHybridStoreFromConfig(config, projectRoot);
    process.stdout.write(`Populating FTS5 index over the full vault...\n`);
    try {
      const stats = await store.syncFTS(dirs);
      process.stdout.write(
        `FTS sync complete. Added ${stats.added}, updated ${stats.updated}, removed ${stats.removed}, unchanged ${stats.unchanged}.\n`,
      );
    } finally {
      store.close();
    }
  }

  if (reEmbed) {
    const stateDir = resolveStateDir(config);
    const lockDir = resolveLockDir(config);
    const queuePath = join(stateDir, 'job-queue.json');
    const queue = createJobQueue(queuePath);
    await queue.load();
    await queue.enqueue({
      type: 'embedding-index',
      trigger: 'cli',
      priority: 45,
      payload: { folder: folderArg ?? config.layout.wiki },
      dedupeKey: `embedding-index:${folderArg ?? 'wiki'}`,
    });
    const vault = createFsAdapter(config.vaultPath);
    const llm = createLLMFromConfig(config);
    const lock = createFileLock(lockDir);
    const handlers = createHandlerRegistry();
    const runner = createJobRunner({
      queue,
      lock,
      handlers,
      vaultPath: config.vaultPath,
      projectRoot: config.projectRoot!,
      llm,
      vault,
      config,
    });
    process.stdout.write('Re-embedding wiki notes...\n');
    const processed = await runner.runAll();
    process.stdout.write(`Re-embed complete. ${processed} job(s) processed.\n`);
  }

  if (pruneArg) {
    const providerId = pruneArg.includes('=')
      ? pruneArg.split('=')[1]
      : args[args.indexOf(pruneArg) + 1];
    if (!providerId) {
      process.stderr.write('Usage: karpathy maintenance --prune-provider <id>\n');
      process.exit(1);
    }
    const { openStoreFromConfig } = await import('../embeddings/factory.js');
    const store = openStoreFromConfig(config, projectRoot);
    try {
      const before = store.listProviders();
      const target = before.find((p) => p.provider_id === providerId);
      if (!target) {
        process.stdout.write(
          `No rows found for provider "${providerId}". Known providers: ${before.map((p) => p.provider_id).join(', ') || '(none)'}\n`,
        );
        return;
      }
      const removed = store.pruneProvider(providerId);
      process.stdout.write(
        `Pruned ${removed} embedding row(s) under provider "${providerId}".\n`,
      );
    } finally {
      store.close();
    }
  }
}

async function specVersionsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'archive') {
    const description = args.slice(1).join(' ') || undefined;
    const projectRoot = process.cwd();
    const result = await archiveCurrentSpec(projectRoot, description);
    if (result) {
      process.stdout.write(`Spec archived to: ${result}\n`);
    } else {
      process.stdout.write('No specification found to archive.\n');
    }
    return;
  }

  // Default: list versions
  const projectRoot = process.cwd();
  const versions = await listSupersededVersions(projectRoot);
  if (versions.length === 0) {
    process.stdout.write('No superseded versions found.\n');
    return;
  }

  process.stdout.write(`Superseded Spec Versions (${versions.length}):\n`);
  for (const v of versions) {
    process.stdout.write(`  v${v.version} — ${v.date} (${v.fileName})\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await initCommand(args[1]);
      break;
    case 'status':
      await statusCommand();
      break;
    case 'hook':
      await hookCommand(args[1]);
      break;
    case 'install-hooks':
      await installHooksCommand();
      break;
    case 'install-mcp':
      await installMcpCommand();
      break;
    case 'mcp':
      await import('../mcp/server.js');
      break;
    case 'maintain':
      await maintainCommand();
      break;
    case 'maintenance':
      await maintenanceCommand(args.slice(1));
      break;
    case 'drain-queue':
      await drainQueueCommand();
      break;
    case 'ingest':
      await ingestCommand(args.slice(1));
      break;
    case 'review':
      await reviewCommand(args.slice(1));
      break;
    case 'migrate':
      await migrateCommand();
      break;
    case 'migrate-hubs':
      await migrateHubsCommand();
      break;
    case 'migrate-markers':
      await migrateMarkersCommand();
      break;
    case 'reingest':
      await reingestCommand(args.slice(1));
      break;
    case 'reprocess-agent':
      await reprocessAgentCommand();
      break;
    case 'import-sessions':
      await importSessionsCommand(args.slice(1));
      break;
    case 'import-cursor-sessions':
      await importCursorSessionsCommand(args.slice(1));
      break;
    case 'clean':
      await cleanCommand();
      break;
    case 'merge':
      await mergeCommand(args.slice(1));
      break;
    case 'synthesize':
      await synthesizeCommand(args.slice(1));
      break;
    case 'check-decay':
      await checkDecayCommand();
      break;
    case 'cross-project':
      await crossProjectCommand();
      break;
    case 'skills':
      await skillsCommand(args.slice(1));
      break;
    case 'spec-versions':
      await specVersionsCommand(args.slice(1));
      break;
    case 'curator':
      await curatorCommand();
      break;
    case 'touch':
      await touchCommand(args.slice(1));
      break;
    case 'intel':
      await intelCommand(args.slice(1));
      break;
    default:
      process.stdout.write(
        [
          'Usage: karpathy <command>',
          '',
          'Commands:',
          '  init [vault-path]   Initialize a new vault',
          '  status              Show vault status',
          '  maintain            Run deterministic maintenance',
          '  maintenance <flags>  Hybrid-search maintenance:',
          '                        --populate-fts          Build/refresh the FTS5 keyword index',
          '                        --re-embed              Re-embed wiki notes with the current provider',
          '                        --prune-provider <id>   Drop rows under a stale provider id',
          '  drain-queue         Drain pending jobs (used by background hooks)',
          '  ingest <file> [--enrich]  Ingest a raw source file (--enrich for LLM enrichment)',
          '  reingest [--no-enrich]    Re-ingest all raw files through the pipeline',
          '  reprocess-agent          Run agent pipeline on unprocessed AI conversations',
          '  import-sessions [--all] [--enrich]  Import Claude Code session history',
          '  import-cursor-sessions [--enrich]   Import Cursor IDE session history',
          '  clean               Delete all generated content (wiki/, outputs/, etc.), keep raw/',
          '  merge <src> <tgt>   Merge one entity into another',
          '  merge --detect      Detect potential duplicate entities',
          '  merge --auto        Auto-merge high-confidence duplicates',
          '  migrate             Migrate vault (delete old summaries, backfill frontmatter)',
          '  migrate-hubs        Migrate legacy single-page projects to hub model',
          '  migrate-markers     Migrate <!-- PROTECTED --> markers to %% syntax',
          '  hook <event>        Handle a Claude Code hook event',
          '  install-mcp         Register MCP server in Claude Code + Cursor',
          '  mcp                 Start MCP server (stdio transport)',
          '  review              Show review queue',
          '  synthesize <slug>   Run full re-synthesis for a project (Opus model)',
          '  check-decay         Check for stale project specs and trigger re-synthesis',
          '  cross-project       Detect cross-project patterns and shared entities',
          '  skills              List synthesis skills',
          '  skills seed         Seed built-in skills',
          '  skills generate     Generate new skills from unmatched conversations',
          '  spec-versions       List superseded spec versions',
          '  spec-versions archive [description]  Archive current spec',
          '  curator             Interactive entity reconciliation queue walkthrough',
          '  touch <note-path>   Re-run entity extraction on a wiki note you edited',
          '  intel <subcommand>  Intelligence pipeline (run "intel help" for subcommands)',
          '',
        ].join('\n'),
      );
      break;
  }
}

main().catch((err) => {
  log.error('Fatal error', { error: (err as Error).message });
  process.exit(1);
});

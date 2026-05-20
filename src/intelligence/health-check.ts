// Health check: machine- and human-readable status across every moving part.
//
// Used by:
//   - `karpathy intel health [--json]`            (one-shot)
//   - `karpathy intel serve --port N`             (long-running HTTP /health)
//
// A control center polls either form to know whether this project is wired,
// running, drained, and current.
//
// Exit codes (CLI mode):
//   0  — all checks pass
//   1  — at least one CRITICAL check failed
//   2  — only WARN-level issues (still useful, but degraded)
//
// HTTP mode returns the same JSON with HTTP status 200/503/207 respectively.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { KarpathyConfig } from '../config/schema.js';
import { GLOBAL_CONFIG_PATH } from '../config/defaults.js';
import { readResearchQueue } from '../maintenance/research-queue.js';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { openStoreFromConfig } from '../embeddings/factory.js';
import { readSchedulerState } from './scheduler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckLevel = 'ok' | 'warn' | 'critical' | 'info';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export interface HealthReport {
  projectName: string;
  projectRoot: string;
  vaultPath: string | null;
  generatedAt: string;
  overall: 'ok' | 'warn' | 'critical';
  checks: CheckResult[];
  /** Quick-glance counts — what's in motion right now. */
  metrics: {
    queuePending: number;
    queueFailed: number;
    queueRetrying: number;
    embeddingChunks: number;
    researchPending: number;
    researchApproved: number;
    researchCompleted: number;
    rawFilesLast24h: number;
    rawFilesLast7d: number;
    lastRawIngest: string | null;
    lastSchedulerTick: string | null;
    lastQueueRun: string | null;
  };
}

// ---------------------------------------------------------------------------
// Individual probes
// ---------------------------------------------------------------------------

function checkBuild(projectRoot: string): CheckResult {
  const path = join(projectRoot, 'dist/bin/karpathy.js');
  if (!existsSync(path)) {
    return { id: 'build', level: 'critical', message: 'dist/bin/karpathy.js missing — run `pnpm build`', detail: { path } };
  }
  const stat = statSync(path);
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  return {
    id: 'build',
    level: 'ok',
    message: `dist/bin/karpathy.js present (${stat.size} bytes, ${ageHours.toFixed(1)}h old)`,
    detail: { path, builtAt: stat.mtime.toISOString() },
  };
}

function checkConfig(config: KarpathyConfig | null): CheckResult {
  if (!config) {
    return {
      id: 'config',
      level: 'critical',
      message: `No config at ${GLOBAL_CONFIG_PATH}. Create one or run \`karpathy init\`.`,
    };
  }
  if (!config.vaultPath) {
    return { id: 'config', level: 'critical', message: 'config has no vaultPath' };
  }
  if (!existsSync(config.vaultPath)) {
    return {
      id: 'config',
      level: 'critical',
      message: `vaultPath does not exist: ${config.vaultPath}`,
    };
  }
  return { id: 'config', level: 'ok', message: `config OK, vault: ${config.vaultPath}` };
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; type?: string }> }>>;
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

/**
 * Claude Code reads hooks + MCP server configuration from two possible files:
 *   - `~/.claude/settings.json` (user-level — the canonical install target for hooks)
 *   - `~/.claude.json`          (project state file; sometimes also has hooks
 *                                 nested under `projects[absPath]`)
 *
 * We merge both, with settings.json taking precedence (it's the source of truth
 * users edit directly).
 */
function loadClaudeJson(projectRoot: string): { settings: ClaudeSettings; sources: string[] } {
  const sources: string[] = [];
  const merged: ClaudeSettings = { hooks: {}, mcpServers: {} };

  const userSettings = join(homedir(), '.claude/settings.json');
  if (existsSync(userSettings)) {
    try {
      const j = JSON.parse(readFileSync(userSettings, 'utf-8')) as ClaudeSettings;
      Object.assign(merged.hooks!, j.hooks ?? {});
      Object.assign(merged.mcpServers!, j.mcpServers ?? {});
      sources.push(userSettings);
    } catch {
      /* tolerate */
    }
  }

  const stateFile = join(homedir(), '.claude.json');
  if (existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as ClaudeSettings & {
        projects?: Record<string, ClaudeSettings>;
      };
      // Top-level hooks/mcpServers (legacy layout — fill if not already present).
      for (const [event, val] of Object.entries(raw.hooks ?? {})) {
        if (!merged.hooks![event]) merged.hooks![event] = val;
      }
      for (const [name, val] of Object.entries(raw.mcpServers ?? {})) {
        if (!merged.mcpServers![name]) merged.mcpServers![name] = val;
      }
      // Project-scoped overrides (newer layout).
      const proj = raw.projects?.[projectRoot];
      if (proj) {
        for (const [event, val] of Object.entries(proj.hooks ?? {})) {
          if (!merged.hooks![event]) merged.hooks![event] = val;
        }
        for (const [name, val] of Object.entries(proj.mcpServers ?? {})) {
          if (!merged.mcpServers![name]) merged.mcpServers![name] = val;
        }
      }
      sources.push(stateFile);
    } catch {
      /* tolerate */
    }
  }

  return { settings: merged, sources };
}

function checkClaudeHooks(projectRoot: string): CheckResult {
  const { settings, sources } = loadClaudeJson(projectRoot);
  if (sources.length === 0) {
    return {
      id: 'claude-hooks',
      level: 'critical',
      message: `Neither ~/.claude/settings.json nor ~/.claude.json could be read`,
    };
  }
  const expected = join(projectRoot, 'dist/bin/karpathy.js');
  const required = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostCompact', 'Stop'];
  const installed: string[] = [];
  const wrongPath: string[] = [];
  for (const event of required) {
    const entries = settings.hooks?.[event] ?? [];
    let found = false;
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes('karpathy') || h.command?.includes('carpathi')) {
          found = true;
          if (!h.command.includes(expected)) wrongPath.push(`${event}: ${h.command}`);
        }
      }
    }
    if (found) installed.push(event);
  }
  if (installed.length === 0) {
    return {
      id: 'claude-hooks',
      level: 'critical',
      message: 'No Claude Code hooks point at this project',
      detail: { sources, required },
    };
  }
  if (wrongPath.length > 0) {
    return {
      id: 'claude-hooks',
      level: 'critical',
      message: `${wrongPath.length} hook(s) point at wrong binary (old carpathi.js?)`,
      detail: { wrongPath, expected },
    };
  }
  if (installed.length < required.length) {
    const missing = required.filter((r) => !installed.includes(r));
    return {
      id: 'claude-hooks',
      level: 'warn',
      message: `${installed.length}/${required.length} hooks installed; missing: ${missing.join(', ')}`,
      detail: { installed, missing },
    };
  }
  return {
    id: 'claude-hooks',
    level: 'ok',
    message: `All ${installed.length} Claude Code hooks installed and pointing at the current binary`,
  };
}

function checkClaudeMcp(projectRoot: string): CheckResult {
  const { settings } = loadClaudeJson(projectRoot);
  const expected = join(projectRoot, 'dist/mcp/server.js');
  const mcp = settings.mcpServers ?? {};
  // Accept either `karpathy` or legacy `carpathi` as the server name.
  const entry = mcp.karpathy ?? mcp.carpathi;
  if (!entry) {
    return {
      id: 'claude-mcp',
      level: 'warn',
      message: 'MCP server not registered in ~/.claude.json (Claude sessions cannot query the vault directly)',
    };
  }
  const cmd = `${entry.command ?? ''} ${(entry.args ?? []).join(' ')}`;
  if (!cmd.includes(expected)) {
    return {
      id: 'claude-mcp',
      level: 'warn',
      message: 'MCP server registered but pointing at a different path (likely stale)',
      detail: { configured: cmd, expected },
    };
  }
  return { id: 'claude-mcp', level: 'ok', message: 'MCP server registered with current binary path' };
}

function checkLaunchd(): CheckResult {
  const path = join(homedir(), 'Library/LaunchAgents/com.karpathy.tick.plist');
  if (!existsSync(path)) {
    return {
      id: 'launchd',
      level: 'warn',
      message: 'No launchd plist installed — scheduled jobs (digest, decay, rot, propose) will not fire automatically',
      detail: { expectedPath: path },
    };
  }
  return { id: 'launchd', level: 'ok', message: 'launchd plist installed', detail: { path } };
}

function checkBedrockCreds(config: KarpathyConfig | null): CheckResult {
  if (!config || config.llm.provider !== 'bedrock') {
    return { id: 'bedrock-creds', level: 'info', message: 'LLM provider not bedrock — skipping' };
  }
  const hasBearer = !!process.env.AWS_BEARER_TOKEN_BEDROCK;
  const hasIamKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const hasProfile = !!process.env.AWS_PROFILE;
  if (!hasBearer && !hasIamKeys && !hasProfile) {
    return {
      id: 'bedrock-creds',
      level: 'critical',
      message: 'No AWS credentials reachable from this shell (no AWS_BEARER_TOKEN_BEDROCK, IAM keys, or AWS_PROFILE) — Bedrock-backed jobs will fail',
    };
  }
  return {
    id: 'bedrock-creds',
    level: 'ok',
    message: `Bedrock auth available via ${hasBearer ? 'bearer token' : hasIamKeys ? 'IAM keys' : 'AWS_PROFILE'}`,
  };
}

interface QueueEntry {
  type: string;
  status: string;
  retryCount?: number;
  error?: string;
  completedAt?: string;
  createdAt?: string;
}

function loadQueue(projectRoot: string, stateDir: string): QueueEntry[] {
  const path = join(projectRoot, stateDir, 'job-queue.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as QueueEntry[];
  } catch {
    return [];
  }
}

function checkQueue(queue: QueueEntry[]): CheckResult {
  const pending = queue.filter((j) => j.status === 'pending' && !j.retryCount).length;
  const retrying = queue.filter((j) => j.status === 'pending' && (j.retryCount ?? 0) > 0).length;
  const failed = queue.filter((j) => j.status === 'failed' || (j.status === 'pending' && (j.retryCount ?? 0) >= 3)).length;
  if (failed > 0) {
    const recent = queue.filter((j) => j.error).slice(-3).map((j) => ({ type: j.type, error: j.error }));
    return {
      id: 'job-queue',
      level: 'warn',
      message: `Queue: ${pending} pending, ${retrying} retrying, ${failed} failed`,
      detail: { recentErrors: recent },
    };
  }
  if (pending > 100) {
    return {
      id: 'job-queue',
      level: 'warn',
      message: `Queue has ${pending} pending jobs — runner may be stalled. Run \`karpathy drain-queue\` or \`karpathy intel tick\`.`,
    };
  }
  return { id: 'job-queue', level: 'ok', message: `Queue: ${pending} pending, ${retrying} retrying` };
}

async function checkVaultActivity(config: KarpathyConfig | null): Promise<{
  check: CheckResult;
  metrics: Pick<HealthReport['metrics'], 'rawFilesLast24h' | 'rawFilesLast7d' | 'lastRawIngest'>;
}> {
  if (!config || !config.vaultPath || !existsSync(config.vaultPath)) {
    return {
      check: { id: 'vault-activity', level: 'info', message: 'vault not reachable — skipping' },
      metrics: { rawFilesLast24h: 0, rawFilesLast7d: 0, lastRawIngest: null },
    };
  }
  // Activity == any markdown in the configured watchPaths (or `raw/` for legacy).
  // We scan whichever exists.
  const candidates = (config.ingest?.watchPaths ?? []).map((p) => join(config.vaultPath, p));
  candidates.push(join(config.vaultPath, 'raw'));
  const dirs = candidates.filter((d) => existsSync(d));
  if (dirs.length === 0) {
    return {
      check: { id: 'vault-activity', level: 'warn', message: 'no watch directories exist yet' },
      metrics: { rawFilesLast24h: 0, rawFilesLast7d: 0, lastRawIngest: null },
    };
  }

  const cutoff24h = Date.now() - 86_400_000;
  const cutoff7d = Date.now() - 7 * 86_400_000;
  let last24h = 0;
  let last7d = 0;
  let mostRecent = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full, depth + 1);
      } else if (stat.isFile() && name.endsWith('.md')) {
        if (stat.mtimeMs > cutoff7d) last7d += 1;
        if (stat.mtimeMs > cutoff24h) last24h += 1;
        if (stat.mtimeMs > mostRecent) mostRecent = stat.mtimeMs;
      }
    }
  }
  for (const d of dirs) {
    await walk(d, 0);
  }

  const level: CheckLevel = mostRecent === 0 ? 'warn' : last7d === 0 ? 'warn' : 'ok';
  return {
    check: {
      id: 'vault-activity',
      level,
      message:
        mostRecent === 0
          ? 'watch directories have no markdown files yet'
          : `${last24h} files in last 24h, ${last7d} in last 7d across watch paths`,
    },
    metrics: {
      rawFilesLast24h: last24h,
      rawFilesLast7d: last7d,
      lastRawIngest: mostRecent > 0 ? new Date(mostRecent).toISOString() : null,
    },
  };
}

async function checkEmbeddingStore(
  config: KarpathyConfig | null,
  projectRoot: string,
): Promise<{ check: CheckResult; count: number }> {
  if (!config) {
    return { check: { id: 'embedding-store', level: 'info', message: 'no config' }, count: 0 };
  }
  try {
    const store = openStoreFromConfig(config, projectRoot);
    try {
      const count = store.count();
      if (count === 0) {
        return {
          check: {
            id: 'embedding-store',
            level: 'warn',
            message: 'Embedding store is empty. Run `karpathy intel reindex` to populate.',
          },
          count,
        };
      }
      return {
        check: { id: 'embedding-store', level: 'ok', message: `${count} embedding chunks` },
        count,
      };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      check: {
        id: 'embedding-store',
        level: 'warn',
        message: `Embedding store unreachable: ${(err as Error).message}`,
      },
      count: 0,
    };
  }
}

async function checkResearchQueue(
  config: KarpathyConfig | null,
): Promise<{ check: CheckResult; counts: { pending: number; approved: number; completed: number } }> {
  if (!config || !existsSync(config.vaultPath)) {
    return {
      check: { id: 'research-queue', level: 'info', message: 'vault not reachable' },
      counts: { pending: 0, approved: 0, completed: 0 },
    };
  }
  const vault = createFsAdapter(config.vaultPath);
  const queue = await readResearchQueue(vault);
  const pending = queue.candidates.filter((c) => c.status === 'pending' && !c.decision).length;
  const approved = queue.candidates.filter((c) => c.status === 'pending' && c.decision && c.decision !== 'skip').length;
  const completed = queue.candidates.filter((c) => c.status === 'completed').length;
  const message = `Research queue: ${pending} pending, ${approved} approved, ${completed} completed`;
  return {
    check: { id: 'research-queue', level: 'ok', message },
    counts: { pending, approved, completed },
  };
}

function checkScheduler(projectRoot: string, stateDir: string): { check: CheckResult; lastTick: string | null } {
  try {
    const state = readSchedulerState(join(projectRoot, stateDir));
    const fires = Object.values(state.lastFire);
    if (fires.length === 0) {
      return {
        check: {
          id: 'scheduler',
          level: 'warn',
          message: 'Scheduler has never fired any jobs. Run `karpathy intel tick` or install launchd.',
        },
        lastTick: null,
      };
    }
    const newest = fires.sort().slice(-1)[0];
    const ageHours = (Date.now() - new Date(newest).getTime()) / 3_600_000;
    const level: CheckLevel = ageHours > 26 ? 'warn' : 'ok';
    return {
      check: {
        id: 'scheduler',
        level,
        message:
          level === 'warn'
            ? `Last scheduler activity ${ageHours.toFixed(1)}h ago — launchd may not be firing`
            : `Scheduler healthy (last fire ${ageHours.toFixed(1)}h ago)`,
        detail: state.lastFire,
      },
      lastTick: newest,
    };
  } catch {
    return {
      check: { id: 'scheduler', level: 'info', message: 'no scheduler state yet' },
      lastTick: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export interface RunHealthCheckOptions {
  projectRoot: string;
  config: KarpathyConfig | null;
  /** When set, used to override the default stateDir lookup. */
  stateDir?: string;
}

export async function runHealthCheck(opts: RunHealthCheckOptions): Promise<HealthReport> {
  const checks: CheckResult[] = [];
  const stateDir = opts.stateDir ?? opts.config?.stateDir ?? '.karpathy/state';

  checks.push(checkBuild(opts.projectRoot));
  checks.push(checkConfig(opts.config));
  checks.push(checkClaudeHooks(opts.projectRoot));
  checks.push(checkClaudeMcp(opts.projectRoot));
  checks.push(checkLaunchd());
  checks.push(checkBedrockCreds(opts.config));

  const queue = loadQueue(opts.projectRoot, stateDir);
  checks.push(checkQueue(queue));

  const vaultResult = await checkVaultActivity(opts.config);
  checks.push(vaultResult.check);

  const embeddingResult = await checkEmbeddingStore(opts.config, opts.projectRoot);
  checks.push(embeddingResult.check);

  const researchResult = await checkResearchQueue(opts.config);
  checks.push(researchResult.check);

  const schedResult = checkScheduler(opts.projectRoot, stateDir);
  checks.push(schedResult.check);

  // Overall status: critical wins; warn second; otherwise ok.
  let overall: HealthReport['overall'] = 'ok';
  for (const c of checks) {
    if (c.level === 'critical') overall = 'critical';
    else if (c.level === 'warn' && overall === 'ok') overall = 'warn';
  }

  const lastQueueRun =
    queue
      .filter((j) => j.completedAt)
      .map((j) => j.completedAt!)
      .sort()
      .slice(-1)[0] ?? null;

  const projectName = (() => {
    const pkg = join(opts.projectRoot, 'package.json');
    if (!existsSync(pkg)) return 'karpathy';
    try {
      const j = JSON.parse(readFileSync(pkg, 'utf-8')) as { name?: string };
      return j.name ?? 'karpathy';
    } catch {
      return 'karpathy';
    }
  })();

  return {
    projectName,
    projectRoot: opts.projectRoot,
    vaultPath: opts.config?.vaultPath ?? null,
    generatedAt: new Date().toISOString(),
    overall,
    checks,
    metrics: {
      queuePending: queue.filter((j) => j.status === 'pending' && !j.retryCount).length,
      queueFailed: queue.filter((j) => j.status === 'failed' || (j.status === 'pending' && (j.retryCount ?? 0) >= 3)).length,
      queueRetrying: queue.filter((j) => j.status === 'pending' && (j.retryCount ?? 0) > 0).length,
      embeddingChunks: embeddingResult.count,
      researchPending: researchResult.counts.pending,
      researchApproved: researchResult.counts.approved,
      researchCompleted: researchResult.counts.completed,
      ...vaultResult.metrics,
      lastSchedulerTick: schedResult.lastTick,
      lastQueueRun,
    },
  };
}

// ---------------------------------------------------------------------------
// Pretty printing for the CLI
// ---------------------------------------------------------------------------

const ICONS: Record<CheckLevel, string> = {
  ok: '✓',
  warn: '⚠',
  critical: '✗',
  info: '·',
};

export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`Karpathy health — ${report.projectName} @ ${report.generatedAt}`);
  lines.push(`Project: ${report.projectRoot}`);
  lines.push(`Vault:   ${report.vaultPath ?? '(not configured)'}`);
  lines.push(`Overall: ${ICONS[report.overall === 'ok' ? 'ok' : report.overall === 'warn' ? 'warn' : 'critical']} ${report.overall.toUpperCase()}`);
  lines.push('');
  lines.push('Checks:');
  for (const c of report.checks) {
    lines.push(`  ${ICONS[c.level]} [${c.id}] ${c.message}`);
  }
  lines.push('');
  lines.push('Metrics:');
  const m = report.metrics;
  lines.push(`  queue:           ${m.queuePending} pending, ${m.queueRetrying} retrying, ${m.queueFailed} failed`);
  lines.push(`  research queue:  ${m.researchPending} pending, ${m.researchApproved} approved, ${m.researchCompleted} completed`);
  lines.push(`  embedding store: ${m.embeddingChunks} chunks`);
  lines.push(`  raw/ activity:   ${m.rawFilesLast24h} files (24h), ${m.rawFilesLast7d} (7d)`);
  lines.push(`  last raw file:   ${m.lastRawIngest ?? '(none)'}`);
  lines.push(`  last queue run:  ${m.lastQueueRun ?? '(none)'}`);
  lines.push(`  last sched tick: ${m.lastSchedulerTick ?? '(none)'}`);
  return lines.join('\n');
}

// HTTP status code mapping for the serve mode.
export function httpStatusForReport(report: HealthReport): number {
  switch (report.overall) {
    case 'ok':
      return 200;
    case 'warn':
      return 207; // Multi-Status — partial success.
    case 'critical':
      return 503;
  }
}

// Avoid unused-import warning when only readResearchQueue's type is referenced.
export const _typeAnchor = { dirname };

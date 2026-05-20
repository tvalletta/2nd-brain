// `karpathy intel` — CLI subcommand surface for the intelligence pipeline.
//
// Each subcommand enqueues the matching job and drains the queue synchronously
// so the user can run it ad-hoc and see the result.

import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { createJobQueue } from '../jobs/queue.js';
import { createFileLock } from '../jobs/lock.js';
import { createJobRunner } from '../jobs/runner.js';
import { createHandlerRegistry } from '../jobs/handlers/index.js';
import { resolveStateDir, resolveLockDir } from '../config/defaults.js';
import { createBedrockClient, createNoopClient } from '../enrichment/llm-client.js';
import { backfillTimeAwareFields } from '../maintenance/backfill-time-aware.js';
import { rebuildVaultIndex } from '../maintenance/vault-index.js';
import { runRotScan } from '../intelligence/rot-scan.js';
import {
  readResearchQueue,
  writeResearchQueue,
  RESEARCH_QUEUE_PATH,
} from '../maintenance/research-queue.js';
import { tickScheduler, readSchedulerState } from '../intelligence/scheduler.js';
import { maybeRunAutoBackfill } from '../intelligence/auto-backfill.js';
import { importNewCursorSessions } from '../session/import-cursor-sessions.js';
import {
  runHealthCheck,
  formatHealthReport,
  httpStatusForReport,
} from '../intelligence/health-check.js';
import { loadConfigOrNull } from '../config/loader.js';
import { parseSlackReply, applyDecisions } from '../intelligence/slack-notify.js';
import { openStoreFromConfig } from '../embeddings/factory.js';
import { VAULT_LOG_PATH } from '../maintenance/vault-log.js';
import { VAULT_HEALTH_PATH } from '../intelligence/rot-scan.js';
import type { JobCreateInput, JobType } from '../jobs/types.js';
import type { KarpathyConfig } from '../config/schema.js';

const HELP = `Usage: karpathy intel <subcommand>

Subcommands:
  backfill                  Backfill time-aware frontmatter (last_verified, stability, tldr, ...)
  reindex [folder]          Re-embed all notes under \`folder\` (default: wiki). Use after upgrading.
  digest                    Run weekly hot-topics digest now.
  decay                     Run decay scan now (enqueues topic refreshes).
  rot                       Run vault rot diagnostic (writes wiki/_system/vault-health.md).
  propose                   Run gap detection. Updates research queue. Sends Slack if configured.
  refresh <path>            Refresh a single topic note by path.
  research <slug> <depth>   Execute approved research at depth (light|medium|heavy).
  queue                     Print the current research queue.
  index                     Rebuild vault root index.md.
  tick                      Self-pacing scheduler — fires whichever scheduled jobs are due.
                            Wire this to system cron / launchd / a Claude Code hook at any frequency.
  schedule                  Print scheduler state (last fire per job type).
  approve "<reply>"         Apply Slack-style picks to the queue without going through Slack.
                            Examples: "1 heavy, 2 medium, skip 3"; "fsrs heavy, raptor light".
  status                    Pipeline health overview — counts, latest digest, scheduler state.
  health [--json]           Structured health check. Exit 0 OK, 1 critical, 2 warn-only.
                            JSON form is the canonical input for external control centers.
  serve [--port N]          Long-running HTTP server exposing /health (JSON). Default port 9123.
                            Use this when a control center polls.
  help                      Show this message.
`;

function llmFor(config: KarpathyConfig) {
  if (config.llm.provider === 'bedrock') {
    return createBedrockClient({
      region: config.llm.region,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
    });
  }
  return createNoopClient();
}

interface Drained {
  enqueued: number;
  processed: number;
}

async function enqueueAndDrain(
  config: KarpathyConfig,
  inputs: JobCreateInput[],
): Promise<Drained> {
  const stateDir = resolveStateDir(config);
  const lockDir = resolveLockDir(config);
  const queue = createJobQueue(join(stateDir, 'job-queue.json'));
  await queue.load();
  for (const i of inputs) await queue.enqueue(i);
  const vault = createFsAdapter(config.vaultPath);
  const runner = createJobRunner({
    queue,
    lock: createFileLock(lockDir),
    handlers: createHandlerRegistry(),
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm: llmFor(config),
    vault,
    config,
  });
  const processed = await runner.runAll();
  return { enqueued: inputs.length, processed };
}

export async function intelCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'help';
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP);
    return;
  }

  switch (sub) {
    case 'backfill': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const result = await backfillTimeAwareFields(vault);
      process.stdout.write(
        `Backfill: scanned ${result.filesScanned}, updated ${result.filesUpdated}.\n` +
          `Fields added: ${JSON.stringify(result.fieldsAdded)}\n`,
      );
      return;
    }
    case 'reindex': {
      const config = await loadConfig();
      const folder = args[1] ?? 'wiki';
      const result = await enqueueAndDrain(config, [
        {
          type: 'embedding-index' as JobType,
          payload: { folder },
          priority: 45,
          trigger: 'cli',
          dedupeKey: `reindex:${folder}`,
        },
      ]);
      process.stdout.write(`Reindex of ${folder}: ${result.processed} job(s) processed.\n`);
      return;
    }
    case 'digest': {
      const config = await loadConfig();
      const result = await enqueueAndDrain(config, [
        {
          type: 'digest-weekly' as JobType,
          priority: 90,
          trigger: 'cli',
          dedupeKey: 'digest-weekly',
        },
      ]);
      process.stdout.write(`Digest: ${result.processed} job(s) processed.\n`);
      return;
    }
    case 'decay': {
      const config = await loadConfig();
      const result = await enqueueAndDrain(config, [
        {
          type: 'decay-scan' as JobType,
          priority: 95,
          trigger: 'cli',
          dedupeKey: 'decay-scan',
        },
      ]);
      process.stdout.write(`Decay scan: ${result.processed} job(s) processed.\n`);
      return;
    }
    case 'rot': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const result = await runRotScan(vault);
      process.stdout.write(
        `Rot scan: scanned ${result.scanned}, ${result.candidates.length} candidate(s) flagged.\n` +
          `Report: ${result.reportPath}\n`,
      );
      return;
    }
    case 'propose': {
      const config = await loadConfig();
      const result = await enqueueAndDrain(config, [
        {
          type: 'research-propose' as JobType,
          priority: 90,
          trigger: 'cli',
          dedupeKey: 'research-propose',
        },
      ]);
      process.stdout.write(`Research-propose: ${result.processed} job(s) processed.\n`);
      return;
    }
    case 'refresh': {
      const path = args[1];
      if (!path) {
        process.stderr.write('Usage: karpathy intel refresh <path>\n');
        process.exit(1);
      }
      const config = await loadConfig();
      const result = await enqueueAndDrain(config, [
        {
          type: 'topic-refresh' as JobType,
          targetPath: path,
          priority: 75,
          trigger: 'cli',
          dedupeKey: `topic-refresh:${path}`,
        },
      ]);
      process.stdout.write(`Refresh of ${path}: ${result.processed} job(s) processed.\n`);
      return;
    }
    case 'research': {
      const slug = args[1];
      const depth = args[2];
      if (!slug || !['light', 'medium', 'heavy'].includes(depth ?? '')) {
        process.stderr.write('Usage: karpathy intel research <slug> <light|medium|heavy>\n');
        process.exit(1);
      }
      const config = await loadConfig();
      const result = await enqueueAndDrain(config, [
        {
          type: 'research-execute' as JobType,
          payload: { slug, depth },
          priority: 80,
          trigger: 'cli',
          dedupeKey: `research-execute:${slug}`,
        },
      ]);
      process.stdout.write(`Research ${slug} (${depth}): ${result.processed} job(s) processed.\n`);
      return;
    }
    case 'queue': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const queue = await readResearchQueue(vault);
      if (queue.candidates.length === 0) {
        process.stdout.write('Research queue is empty.\n');
        return;
      }
      const sorted = [...queue.candidates].sort((a, b) => b.score - a.score);
      process.stdout.write(`Research queue (${sorted.length} candidates):\n`);
      sorted.forEach((c, i) => {
        const decision = c.decision ? ` [${c.decision}]` : '';
        const status = c.status === 'completed' ? ` ✓ ${c.completedDepth ?? ''}` : '';
        process.stdout.write(
          `  ${i + 1}. (${c.score.toFixed(2)}) ${c.title}${decision}${status} — ${c.reason}\n`,
        );
      });
      return;
    }
    case 'index': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const result = await rebuildVaultIndex(vault, config.layout);
      process.stdout.write(`${config.layout.vaultIndex} rebuilt with ${result.entries} entries.\n`);
      return;
    }
    case 'tick': {
      const config = await loadConfig();
      const stateDir = resolveStateDir(config);

      // First-run backfill: idempotent, only runs once per state dir.
      const vaultForBackfill = createFsAdapter(config.vaultPath);
      const backfill = await maybeRunAutoBackfill(vaultForBackfill, stateDir);
      if (backfill.ran) {
        process.stdout.write(
          `Auto-backfill (first run): updated ${backfill.filesUpdated} files. Fields: ${JSON.stringify(backfill.fieldsAdded)}\n`,
        );
      }

      // Import any new Cursor sessions before the scheduler fires. Newly
      // exported staging files get picked up by the file watcher / file-mtime
      // ingest path. Silent unless something was exported.
      try {
        const cursor = await importNewCursorSessions(config, stateDir);
        if (cursor.exported > 0) {
          process.stdout.write(
            `Cursor sessions: ${cursor.exported} new exported (${cursor.skipped} skipped of ${cursor.total} total)\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`Cursor import failed (non-fatal): ${(err as Error).message}\n`);
      }

      const queue = createJobQueue(join(stateDir, 'job-queue.json'));
      await queue.load();
      const tickResult = await tickScheduler({
        stateDir,
        enqueue: async (i) => queue.enqueue(i),
      });
      // Drain whatever was just enqueued.
      const vault = createFsAdapter(config.vaultPath);
      const runner = createJobRunner({
        queue,
        lock: createFileLock(resolveLockDir(config)),
        handlers: createHandlerRegistry(),
        vaultPath: config.vaultPath,
        projectRoot: config.projectRoot!,
        llm: llmFor(config),
        vault,
        config,
      });
      const processed = await runner.runAll();
      const fired = tickResult.fired.map((f) => `${f.type} (${f.reason})`).join(', ') || 'nothing';
      const skipped = tickResult.skipped.length;
      process.stdout.write(
        `Scheduler tick: fired ${fired}; skipped ${skipped}; drained ${processed} job(s).\n`,
      );
      return;
    }
    case 'schedule': {
      const config = await loadConfig();
      const stateDir = resolveStateDir(config);
      const state = readSchedulerState(stateDir);
      if (Object.keys(state.lastFire).length === 0) {
        process.stdout.write('Scheduler has not fired any jobs yet. Run `karpathy intel tick`.\n');
        return;
      }
      process.stdout.write('Scheduler state:\n');
      for (const [jobType, last] of Object.entries(state.lastFire)) {
        process.stdout.write(`  ${jobType}: last fire ${last}\n`);
      }
      return;
    }
    case 'approve': {
      const reply = args.slice(1).join(' ').trim();
      if (!reply) {
        process.stderr.write('Usage: karpathy intel approve "<reply>"\n');
        process.stderr.write('Examples:\n');
        process.stderr.write('  karpathy intel approve "1 heavy, 2 medium, skip 3"\n');
        process.stderr.write('  karpathy intel approve "fsrs heavy, raptor light"\n');
        process.exit(1);
      }
      const decisions = parseSlackReply(reply);
      if (decisions.length === 0) {
        process.stderr.write(`Could not parse any decisions from: ${JSON.stringify(reply)}\n`);
        process.exit(1);
      }
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const queue = await readResearchQueue(vault);
      if (queue.candidates.length === 0) {
        process.stdout.write('Queue is empty — nothing to approve. Run `karpathy intel propose` first.\n');
        return;
      }
      applyDecisions(queue.candidates, decisions);
      await writeResearchQueue(vault, queue);
      const sorted = [...queue.candidates].sort((a, b) => b.score - a.score);
      process.stdout.write(`Applied ${decisions.length} decision(s) to ${RESEARCH_QUEUE_PATH}:\n`);
      for (const d of decisions) {
        const target =
          d.match.index !== undefined ? sorted[d.match.index - 1] : queue.candidates.find((c) => c.slug.toLowerCase() === d.match.slug);
        if (target) {
          process.stdout.write(`  - ${target.title} → ${d.depth}\n`);
        } else {
          const ref = d.match.index !== undefined ? `#${d.match.index}` : d.match.slug;
          process.stdout.write(`  - (no match for ${ref})\n`);
        }
      }
      const ready = queue.candidates.filter(
        (c) => c.status === 'pending' && c.decision && c.decision !== 'skip',
      );
      if (ready.length > 0) {
        process.stdout.write(
          `\nNext: run \`karpathy intel research <slug> <depth>\` for each, or wait for the next \`tick\` to drain them.\n`,
        );
      }
      return;
    }
    case 'status': {
      const config = await loadConfig();
      const vault = createFsAdapter(config.vaultPath);
      const stateDir = resolveStateDir(config);

      // Embedding store size.
      let embeddingCount = 0;
      try {
        const store = openStoreFromConfig(config, config.projectRoot!);
        try {
          embeddingCount = store.count();
        } finally {
          store.close();
        }
      } catch {
        embeddingCount = -1;
      }

      // Latest digest.
      let latestDigest = '(none)';
      if (await vault.exists(config.layout.digests)) {
        const files = (await vault.listMarkdownFiles(config.layout.digests))
          .filter((p) => !p.endsWith('/_index.md'))
          .sort()
          .reverse();
        if (files.length > 0) latestDigest = files[0];
      }

      // Research queue stats.
      const queue = await readResearchQueue(vault);
      const pending = queue.candidates.filter((c) => c.status === 'pending' && !c.decision).length;
      const decided = queue.candidates.filter((c) => c.status === 'pending' && c.decision && c.decision !== 'skip').length;
      const completed = queue.candidates.filter((c) => c.status === 'completed').length;

      // Scheduler state.
      const sched = readSchedulerState(stateDir);

      // Vault rot.
      const rotExists = await vault.exists(VAULT_HEALTH_PATH);

      // Log presence.
      const logExists = await vault.exists(VAULT_LOG_PATH);

      process.stdout.write(
        [
          'Karpathy intelligence — status',
          '',
          `vault:                 ${config.vaultPath}`,
          `embedding store:       ${embeddingCount >= 0 ? `${embeddingCount} chunks` : 'unavailable'}`,
          `embedding provider:    ${config.embeddings.provider}`,
          `web search provider:   ${config.intelligence.research.search.provider}`,
          `latest digest:         ${latestDigest}`,
          `research queue:        ${pending} pending · ${decided} approved · ${completed} completed`,
          `scheduler last fires:  ${
            Object.keys(sched.lastFire).length === 0
              ? '(never run)'
              : Object.entries(sched.lastFire).map(([t, d]) => `${t}=${d.slice(0, 10)}`).join(', ')
          }`,
          `vault log:             ${logExists ? VAULT_LOG_PATH : '(not yet written)'}`,
          `vault rot report:      ${rotExists ? VAULT_HEALTH_PATH : '(not yet generated)'}`,
          `slack notifications:   ${config.notifications.slack.enabled ? 'enabled' : 'off'}`,
          '',
        ].join('\n'),
      );
      return;
    }
    case 'health': {
      const wantJson = args.includes('--json');
      const projectRoot = process.cwd();
      const config = await loadConfigOrNull(projectRoot);
      const report = await runHealthCheck({ projectRoot, config });
      if (wantJson) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        process.stdout.write(formatHealthReport(report) + '\n');
      }
      if (report.overall === 'critical') process.exit(1);
      if (report.overall === 'warn') process.exit(2);
      return;
    }
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 && args[portIdx + 1] ? Number.parseInt(args[portIdx + 1], 10) : 9123;
      if (Number.isNaN(port)) {
        process.stderr.write(`Invalid port: ${args[portIdx + 1]}\n`);
        process.exit(1);
      }
      const projectRoot = process.cwd();
      const { createServer } = await import('node:http');
      const server = createServer(async (req, res) => {
        if (!req.url) {
          res.writeHead(400).end();
          return;
        }
        const url = new URL(req.url, `http://localhost`);
        if (url.pathname === '/health' || url.pathname === '/') {
          try {
            const config = await loadConfigOrNull(projectRoot);
            const report = await runHealthCheck({ projectRoot, config });
            res.writeHead(httpStatusForReport(report), { 'content-type': 'application/json' });
            res.end(JSON.stringify(report));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }
        res.writeHead(404).end();
      });
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(`karpathy health server listening on http://127.0.0.1:${port}/health\n`);
      });
      // Block forever; user kills with Ctrl-C or launchd shutdown.
      await new Promise<void>(() => {});
      return;
    }
    default:
      process.stderr.write(`Unknown intel subcommand: ${sub}\n`);
      process.stderr.write(HELP);
      process.exit(1);
  }
}

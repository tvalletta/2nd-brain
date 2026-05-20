import { StopInputSchema } from './types.js';
import type { HookOutput } from './types.js';
import type { HookContext } from './dispatch.js';
import { todayStamp } from '../shared/date-utils.js';
import { resolveStateDir } from '../config/defaults.js';
import { exportSessionToRaw } from '../session/export-session.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:stop');

export async function handleStop(
  input: unknown,
  ctx: HookContext,
): Promise<HookOutput> {
  const parsed = StopInputSchema.parse(input);

  await ctx.sessionLog.getOrCreateSessionNote(parsed.session_id, parsed.cwd);

  // Finalize the session note
  await ctx.sessionLog.finalize(parsed.session_id, parsed.last_assistant_message ?? undefined);

  // Update hot cache with session entry
  await ctx.hotCache.appendSession({
    date: todayStamp(),
    summary: parsed.last_assistant_message
      ? parsed.last_assistant_message.slice(0, 80)
      : 'Session ended',
    noteLink: `session-${todayStamp()}-${parsed.session_id.slice(0, 8)}`,
  });

  await ctx.hotCache.flush();

  // Export session transcript to raw/ for ingest pipeline
  if (ctx.config.session.exportToRaw && parsed.transcript_path) {
    try {
      const stateDir = resolveStateDir(ctx.config);
      const { layoutFromConfig } = await import('../vault/paths.js');
      const result = await exportSessionToRaw(
        parsed.transcript_path,
        stateDir,
        {
          minTurns: ctx.config.session.minTurns,
          vaultPath: ctx.config.vaultPath,
          layout: layoutFromConfig(ctx.config),
        },
      );

      if (result.exported && result.stagingPath) {
        await ctx.queue.enqueue({
          type: 'ingest-raw-file',
          payload: {
            filePath: result.stagingPath,
            vaultRawPath: result.vaultRawPath,
          },
          trigger: 'hook',
          priority: 20,
          dedupeKey: `ingest-session:${result.sessionId}`,
        });
        await ctx.queue.flush();
        log.info('Session exported for ingest', {
          sessionId: result.sessionId,
          stagingPath: result.stagingPath,
          vaultRawPath: result.vaultRawPath,
        });
      }
    } catch (err) {
      log.warn('Session export failed', { error: (err as Error).message });
    }
  }

  // Drain the job queue in a background process (non-blocking)
  ctx.backgroundDrain();

  log.info('Session stopped (background drain spawned)', {
    sessionId: parsed.session_id,
  });

  return { continue: true };
}

import type { Job } from './types.js';
import type { JobQueue } from './queue.js';
import type { KarpathyConfig } from '../config/schema.js';
import { sendSlackNotification } from '../intelligence/slack-notify.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('stuck-alert');

export function formatStuckJobAlert(job: Job, ageMs: number): string {
  const ageMinutes = Math.round(ageMs / 60_000);
  return [
    `*Karpathy job stuck retrying* — ${job.type} (\`${job.id}\`)`,
    `First failed ${ageMinutes} min ago, ${job.transientRetryCount} transient retries so far.`,
    `Latest error: ${job.error ?? '(none recorded)'}`,
    `This will keep retrying indefinitely — cancel it manually if this looks like a dead credential rather than a network outage.`,
  ].join('\n');
}

export async function checkStuckJobAlert(job: Job, config: KarpathyConfig, queue: JobQueue): Promise<void> {
  if (!config.notifications.slack.enabled) return;
  if (!job.transientSince || job.transientAlertSentAt) return;

  const ageMs = Date.now() - Date.parse(job.transientSince);
  if (ageMs < config.jobs.transientRetry.alertAfterMs) return;

  const message = formatStuckJobAlert(job, ageMs);
  const sent = await sendSlackNotification(
    { webhookUrl: config.notifications.slack.webhookUrl ?? '', channel: config.notifications.slack.target },
    message,
  );
  if (sent) {
    await queue.markAlerted(job.id);
  } else {
    log.warn('Stuck-job Slack alert not sent (webhook missing or request failed)', { jobId: job.id });
  }
}

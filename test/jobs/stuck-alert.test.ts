import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobQueue } from '../../src/jobs/queue.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

vi.mock('../../src/intelligence/slack-notify.js', () => ({
  sendSlackNotification: vi.fn(async () => true),
}));

import { sendSlackNotification } from '../../src/intelligence/slack-notify.js';
import { checkStuckJobAlert, formatStuckJobAlert } from '../../src/jobs/stuck-alert.js';

describe('checkStuckJobAlert', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-stuck-alert-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function configWithSlack(enabled: boolean, alertAfterMs = 3_600_000) {
    return KarpathyConfigSchema.parse({
      vaultPath: tempDir,
      notifications: { slack: { enabled, webhookUrl: 'https://example.com/webhook' } },
      jobs: { transientRetry: { alertAfterMs } },
    });
  }

  it('does not alert before the threshold', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    job.transientSince = new Date().toISOString();
    await checkStuckJobAlert(job, configWithSlack(true), queue);
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('does nothing when transientSince is unset (job has never failed transiently)', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    await checkStuckJobAlert(job, configWithSlack(true, 0), queue);
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('alerts exactly once after crossing the threshold', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    job.transientSince = new Date(Date.now() - 3_700_000).toISOString();
    const config = configWithSlack(true);

    await checkStuckJobAlert(job, config, queue);
    expect(sendSlackNotification).toHaveBeenCalledTimes(1);

    const [stamped] = await queue.list();
    await checkStuckJobAlert(stamped, config, queue);
    expect(sendSlackNotification).toHaveBeenCalledTimes(1); // still 1
  });

  it('never alerts when slack is disabled', async () => {
    const queue = createJobQueue(join(tempDir, 'queue.json'));
    const job = await queue.enqueue({ type: 'rebuild-index' });
    job.transientSince = new Date(Date.now() - 3_700_000).toISOString();
    await checkStuckJobAlert(job, configWithSlack(false), queue);
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('formatStuckJobAlert includes type, id, retry count, and latest error', () => {
    const job = {
      id: 'abc123', type: 'summarize-source', transientRetryCount: 7, error: 'boom',
    } as Parameters<typeof formatStuckJobAlert>[0];
    const message = formatStuckJobAlert(job, 3_700_000);
    expect(message).toContain('summarize-source');
    expect(message).toContain('abc123');
    expect(message).toContain('7');
    expect(message).toContain('boom');
  });
});

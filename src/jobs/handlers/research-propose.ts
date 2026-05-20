// D1: Research-propose handler.
//
// Runs gap detection and emits a Slack notification (when configured) so the
// user is nudged to make picks. The queue itself is the source of truth.

import type { JobHandler } from '../types.js';
import { proposeResearch } from '../../intelligence/research-propose.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import {
  formatQueueDigest,
  sendSlackNotification,
} from '../../intelligence/slack-notify.js';
import { RESEARCH_QUEUE_PATH } from '../../maintenance/research-queue.js';

export const researchProposeHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.research.enabled) return;
    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      const result = await proposeResearch({ vault: ctx.vault, config: ctx.config, store });
      if (
        ctx.config.notifications.slack.enabled &&
        ctx.config.notifications.slack.webhookUrl
      ) {
        const message = formatQueueDigest({
          totalPending: result.proposed,
          topCandidates: result.topCandidates.filter((c) => !c.decision),
          queuePath: RESEARCH_QUEUE_PATH,
        });
        await sendSlackNotification(
          {
            webhookUrl: ctx.config.notifications.slack.webhookUrl,
            channel: ctx.config.notifications.slack.target,
          },
          message,
        );
      }
    } finally {
      store.close();
    }
  },
};

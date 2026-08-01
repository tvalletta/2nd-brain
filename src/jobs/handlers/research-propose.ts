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
import { researchQueuePath } from '../../maintenance/research-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const researchProposeHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.research.enabled) return;
    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      const result = await proposeResearch({
        vault: ctx.vault,
        config: ctx.config,
        store,
        enqueue: ctx.enqueue, // G1: auto-drain, gated inside proposeResearch itself
      });
      if (
        ctx.config.notifications.slack.enabled &&
        ctx.config.notifications.slack.webhookUrl
      ) {
        const message = formatQueueDigest({
          totalPending: result.proposed,
          topCandidates: result.topCandidates.filter((c) => !c.decision),
          // (found while implementing G1, same bug class as G0): this used
          // to be the hardcoded legacy RESEARCH_QUEUE_PATH constant
          // ('wiki/_system/...'), which would show the wrong path in the
          // Slack message under any non-default layout.system. Dormant
          // today (notifications.slack.enabled is false in the real
          // config), but it's the same class of bug G0 fixes everywhere
          // else, so fixed here too while this file is already being touched.
          queuePath: researchQueuePath(layoutFromConfig(ctx.config)),
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

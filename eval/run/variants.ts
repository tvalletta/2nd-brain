import { join } from 'node:path';
import type { KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from './open-store.js';
import type { Variant } from './types.js';

/** The Phase-1 arms. grep-first + as-deployed both read the LIVE index; the
 * full-coverage-hybrid arm (needs an embedded copy) is added by a later plan. */
export function buildVariants(config: KarpathyConfig, projectRoot: string, topK = 10): Variant[] {
  const liveDb = join(projectRoot, config.stateDir, 'embeddings.sqlite');
  return [
    {
      name: 'grep-first',
      keywordOnly: true,
      topK,
      openStore: () => openVariantStore(config, liveDb, { keywordOnly: true }),
      profile: {
        runtimeDeps: [],
        storageGbBeyondFts: 0,
        maintenanceJobs: [],
        silentDegradationModes: [],
        codeSurface: 'low',
      },
    },
    {
      name: 'as-deployed',
      keywordOnly: false,
      topK,
      openStore: () => openVariantStore(config, liveDb, {}),
      profile: {
        runtimeDeps: ['ollama'],
        storageGbBeyondFts: 1,
        maintenanceJobs: ['embedding-index'],
        silentDegradationModes: ['provider-down->keyword-only'],
        codeSurface: 'high',
      },
    },
  ];
}

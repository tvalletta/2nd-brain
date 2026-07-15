import { join } from 'node:path';
import type { KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from './open-store.js';
import type { Variant, VariantProfile } from './types.js';

/** Static simplicity-rubric facts per arm (spec §4.6, §6.1), shared between
 * `buildVariants` (which wires these into the real harness-executable
 * `Variant`s) and `eval/score/build-bakeoff.ts` (which scores the bake-off
 * composite from these same facts) — a single source of truth so the
 * harness and the scoring never drift apart. `full-cov-hybrid`'s
 * `storageGbBeyondFts: 1.3` is the REAL measured value from
 * `eval/results/2026-07-14-arm-b-backfill.json`'s `db_size_delta_gb`
 * (spec §11 addendum — use real facts, not the design doc's `~1.0`
 * placeholder). */
export const VARIANT_PROFILES: Record<'grep-first' | 'as-deployed' | 'full-cov-hybrid', VariantProfile> = {
  'grep-first': {
    runtimeDeps: [],
    storageGbBeyondFts: 0,
    maintenanceJobs: [],
    silentDegradationModes: [],
    codeSurface: 'low',
  },
  'as-deployed': {
    runtimeDeps: ['ollama'],
    storageGbBeyondFts: 1,
    maintenanceJobs: ['embedding-index'],
    silentDegradationModes: ['provider-down->keyword-only'],
    codeSurface: 'high',
  },
  'full-cov-hybrid': {
    runtimeDeps: ['ollama'],
    storageGbBeyondFts: 1.3,
    maintenanceJobs: ['embedding-index', 'embedding-sync'],
    silentDegradationModes: ['provider-down->keyword-only'],
    codeSurface: 'high',
  },
};

/** The bake-off's 3 arms: 2 real contenders (grep-first, full-cov-hybrid)
 * plus as-deployed as a free reference (not a contender — spec §4.1). */
export function buildVariants(config: KarpathyConfig, projectRoot: string, topK = 10): Variant[] {
  const liveDb = join(projectRoot, config.stateDir, 'embeddings.sqlite');
  const fullCovDb = join(projectRoot, 'eval', 'state', 'bakeoff-fullcov.sqlite');
  return [
    {
      name: 'grep-first',
      keywordOnly: true,
      topK,
      openStore: () => openVariantStore(config, liveDb, { keywordOnly: true }),
      profile: VARIANT_PROFILES['grep-first'],
    },
    {
      name: 'as-deployed',
      keywordOnly: false,
      topK,
      openStore: () => openVariantStore(config, liveDb, {}),
      profile: VARIANT_PROFILES['as-deployed'],
    },
    {
      name: 'full-cov-hybrid',
      keywordOnly: false,
      topK,
      openStore: () => openVariantStore(config, fullCovDb, {}),
      profile: VARIANT_PROFILES['full-cov-hybrid'],
    },
  ];
}

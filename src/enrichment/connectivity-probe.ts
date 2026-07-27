import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { TransientLLMError } from '../shared/errors.js';
import type { LLMClient } from './llm-client.js';
import type { KarpathyConfig } from '../config/schema.js';

const log = createLogger('connectivity-probe');

export interface ProbeState {
  reachable: boolean;
  checkedAt: string;
  error?: string;
}

export interface ConnectivityProbe {
  shouldSkip(providerId: string): boolean;
  recordOutcome(providerId: string, ok: boolean, error?: string): void;
}

function loadState(filePath: string): Record<string, ProbeState> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, ProbeState>;
  } catch {
    log.warn('Failed to parse connectivity-probe state, starting fresh', { filePath });
    return {};
  }
}

function saveState(filePath: string, state: Record<string, ProbeState>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function createConnectivityProbe(stateDir: string, trustWindowMs: number): ConnectivityProbe {
  const filePath = join(stateDir, 'connectivity-probe.json');

  // Deliberately not cached in a closure: separate `ConnectivityProbe` instances
  // (e.g. one created directly, one created internally by `withConnectivityProbe`)
  // may point at the same stateDir and must observe each other's writes.
  return {
    shouldSkip(providerId) {
      const state = loadState(filePath);
      const entry = state[providerId];
      if (!entry || entry.reachable) return false;
      const age = Date.now() - Date.parse(entry.checkedAt);
      return age < trustWindowMs;
    },
    recordOutcome(providerId, ok, error) {
      const state = loadState(filePath);
      state[providerId] = { reachable: ok, checkedAt: new Date().toISOString(), error: ok ? undefined : error };
      saveState(filePath, state);
    },
  };
}

export function withConnectivityProbe(
  client: LLMClient,
  providerId: string,
  config: KarpathyConfig,
  stateDir: string,
): LLMClient {
  const probe = createConnectivityProbe(stateDir, config.jobs.transientRetry.probeTrustWindowMs);

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (probe.shouldSkip(providerId)) {
      throw new TransientLLMError(`Skipped: ${providerId} marked unreachable within the trust window`);
    }
    try {
      const result = await fn();
      probe.recordOutcome(providerId, true);
      return result;
    } catch (err) {
      if (err instanceof TransientLLMError) probe.recordOutcome(providerId, false, err.message);
      throw err;
    }
  }

  return {
    complete: (prompt, options) => guarded(() => client.complete(prompt, options)),
    extractStructured: (prompt, schema) => guarded(() => client.extractStructured(prompt, schema)),
  };
}

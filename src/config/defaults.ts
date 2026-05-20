import { join } from 'node:path';
import { homedir } from 'node:os';
import type { KarpathyConfig } from './schema.js';

export const GLOBAL_CONFIG_PATH = join(homedir(), '.karpathy', 'config.json');

export const DEFAULT_VAULT_DIRS = [
  'raw',
  'raw/ai-conversations',
  'raw/ai-conversations/claude',
  'raw/ai-conversations/cursor',
  'wiki',
  'wiki/entities',
  'wiki/projects',
  'wiki/decisions',
  'wiki/concepts',
  'wiki/topics',
  'wiki/tools',
  'wiki/organizations',
  'wiki/meetings',
  'wiki/notes',
  'wiki/insights',
  'wiki/_system',
  'wiki/_system/skills',
  'outputs',
  'outputs/source-summaries',
  'outputs/session-summaries',
  'outputs/extractions',
  'outputs/reviews',
  'indexes',
  'review',
] as const;

export const CONFIG_FILENAME = 'karpathy.config.json';

export function resolveStateDir(config: KarpathyConfig): string {
  return config.projectRoot
    ? `${config.projectRoot}/${config.stateDir}`
    : config.stateDir;
}

export function resolveLockDir(config: KarpathyConfig): string {
  return config.projectRoot
    ? `${config.projectRoot}/${config.lockDir}`
    : config.lockDir;
}

export function resolveLogDir(config: KarpathyConfig): string {
  return config.projectRoot
    ? `${config.projectRoot}/${config.logDir}`
    : config.logDir;
}

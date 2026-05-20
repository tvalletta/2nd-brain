import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GlobalConfigSchema,
  KarpathyConfigSchema,
  type KarpathyConfig,
  type ProjectOverride,
} from './schema.js';
import { GLOBAL_CONFIG_PATH } from './defaults.js';
import { ConfigError } from '../shared/errors.js';
import { fileExists } from '../shared/fs-utils.js';

/**
 * Deep-merge two plain objects. Values in `override` take precedence over
 * `base`. Only one level of nesting is merged (sub-config objects like `llm`
 * are merged shallowly). Undefined values in `override` are ignored.
 */
function mergeOverride(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof base[key] === 'object' &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = {
        ...(base[key] as Record<string, unknown>),
        ...(val as Record<string, unknown>),
      };
    } else {
      result[key] = val;
    }
  }
  return result;
}

async function readGlobalConfig(): Promise<
  ReturnType<typeof GlobalConfigSchema.parse> | null
> {
  if (!(await fileExists(GLOBAL_CONFIG_PATH))) {
    return null;
  }

  const raw = await readFile(GLOBAL_CONFIG_PATH, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Invalid JSON in ${GLOBAL_CONFIG_PATH}`);
  }

  const result = GlobalConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config in ${GLOBAL_CONFIG_PATH}:\n${issues}`);
  }

  return result.data;
}

/**
 * Load and resolve Karpathy config for the given project root (defaults to
 * cwd). Returns null when the global config file does not exist or no
 * vaultPath can be determined — callers that need a hard error (CLI commands)
 * should use `loadConfig()` instead.
 */
export async function loadConfigOrNull(
  projectRoot?: string,
): Promise<KarpathyConfig | null> {
  const root = resolve(projectRoot ?? process.cwd());
  const global = await readGlobalConfig();

  if (!global) return null;

  const defaults = global.defaults as Record<string, unknown>;
  const projectOverride = (global.projects[root] ?? {}) as ProjectOverride;

  const merged = mergeOverride(defaults, projectOverride as Record<string, unknown>);

  if (!merged['vaultPath']) return null;

  const result = KarpathyConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(
      `Resolved config for ${root} is invalid:\n${issues}`,
    );
  }

  return {
    ...result.data,
    projectRoot: root,
    vaultPath: resolve(result.data.vaultPath),
  };
}

/**
 * Load and resolve Karpathy config, throwing a ConfigError when the global
 * config is missing or vaultPath cannot be determined.
 */
export async function loadConfig(projectRoot?: string): Promise<KarpathyConfig> {
  const root = resolve(projectRoot ?? process.cwd());
  const global = await readGlobalConfig();

  if (!global) {
    throw new ConfigError(
      `Global config not found at ${GLOBAL_CONFIG_PATH}. Run "karpathy init" first.`,
    );
  }

  const defaults = global.defaults as Record<string, unknown>;
  const projectOverride = (global.projects[root] ?? {}) as ProjectOverride;

  const merged = mergeOverride(defaults, projectOverride as Record<string, unknown>);

  if (!merged['vaultPath']) {
    throw new ConfigError(
      `No vaultPath configured for ${root}. Add it to the defaults or projects section in ${GLOBAL_CONFIG_PATH}.`,
    );
  }

  const result = KarpathyConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(
      `Resolved config for ${root} is invalid:\n${issues}`,
    );
  }

  return {
    ...result.data,
    projectRoot: root,
    vaultPath: resolve(result.data.vaultPath),
  };
}

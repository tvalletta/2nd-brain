import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load `<repoRoot>/.env` into process.env synchronously, without
 * overriding any variable already set. Mirrors the logic in
 * src/bin/karpathy.ts (the production CLI's entry point) so that eval
 * scripts get the same Bedrock credentials without requiring `.env` to be
 * sourced manually before every run.
 */
export function loadEvalEnv(repoRoot: string): void {
  try {
    const env = readFileSync(join(repoRoot, '.env'), 'utf-8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env — fine */
  }
}

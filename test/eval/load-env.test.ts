import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEvalEnv } from '../../eval/shared/load-env.js';

describe('loadEvalEnv', () => {
  let dir: string;
  const KEY = 'KARPATHY_EVAL_TEST_VAR';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-load-env-'));
    delete process.env[KEY];
  });

  afterEach(async () => {
    delete process.env[KEY];
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a var from .env into process.env when not already set', async () => {
    await writeFile(join(dir, '.env'), `${KEY}=hello-world\n# a comment\n\nOTHER=1\n`);
    loadEvalEnv(dir);
    expect(process.env[KEY]).toBe('hello-world');
  });

  it('does not override a var already present in process.env', async () => {
    process.env[KEY] = 'already-set';
    await writeFile(join(dir, '.env'), `${KEY}=from-file\n`);
    loadEvalEnv(dir);
    expect(process.env[KEY]).toBe('already-set');
  });

  it('does not throw when .env is missing', () => {
    expect(() => loadEvalEnv(dir)).not.toThrow();
  });

  it('strips matching surrounding quotes from values', async () => {
    await writeFile(join(dir, '.env'), `${KEY}="quoted-value"\n`);
    loadEvalEnv(dir);
    expect(process.env[KEY]).toBe('quoted-value');
  });
});

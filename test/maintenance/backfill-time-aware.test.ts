import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { backfillTimeAwareFields, deriveTldr } from '../../src/maintenance/backfill-time-aware.js';
import { parseNote } from '../../src/vault/frontmatter.js';

function toISO(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error('expected string or Date');
}

describe('backfill-time-aware', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-backfill-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('deriveTldr', () => {
    it('extracts first sentence', () => {
      expect(deriveTldr('FSRS is a spaced repetition algorithm. It models stability.')).toBe(
        'FSRS is a spaced repetition algorithm.',
      );
    });

    it('strips headings and bullets', () => {
      const body = '# Heading\n\n- bullet\n\nThe meaningful sentence here. More.';
      expect(deriveTldr(body)).toBe('The meaningful sentence here.');
    });

    it('truncates over 120 chars with ellipsis', () => {
      const long = 'a'.repeat(200);
      const result = deriveTldr(long);
      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(120);
      expect(result!.endsWith('…')).toBe(true);
    });

    it('returns null on empty body', () => {
      expect(deriveTldr('')).toBeNull();
      expect(deriveTldr('# Only a heading')).toBeNull();
    });
  });

  it('backfills missing time-aware fields', async () => {
    const note = `---
id: test-concept
type: concept
title: FSRS
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
---
FSRS is a spaced repetition scheduler. Cool.`;
    await vault.create('wiki/concepts/fsrs.md', note);

    const result = await backfillTimeAwareFields(vault);

    expect(result.filesScanned).toBe(1);
    expect(result.filesUpdated).toBe(1);
    expect(result.fieldsAdded.last_verified).toBe(1);
    expect(result.fieldsAdded.stability).toBe(1);
    expect(result.fieldsAdded.half_life_domain).toBe(1);
    expect(result.fieldsAdded.tldr).toBe(1);

    const updated = await vault.read('wiki/concepts/fsrs.md');
    const { data } = parseNote(updated);
    expect(toISO(data.last_verified)).toBe('2026-04-15T00:00:00.000Z');
    expect(data.half_life_domain).toBe('concept');
    expect(data.stability).toBe(180);
    expect(data.tldr).toBe('FSRS is a spaced repetition scheduler.');
  });

  it('is idempotent', async () => {
    const note = `---
id: x
type: concept
title: X
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
---
A sentence.`;
    await vault.create('wiki/concepts/x.md', note);

    await backfillTimeAwareFields(vault);
    const second = await backfillTimeAwareFields(vault);

    expect(second.filesUpdated).toBe(0);
  });

  it('preserves existing values', async () => {
    const note = `---
id: y
type: concept
title: Y
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-04-15T00:00:00Z
last_verified: 2026-04-20T00:00:00Z
stability: 999
tldr: Custom tldr
---
Body.`;
    await vault.create('wiki/concepts/y.md', note);

    await backfillTimeAwareFields(vault);

    const { data } = parseNote(await vault.read('wiki/concepts/y.md'));
    expect(toISO(data.last_verified)).toBe('2026-04-20T00:00:00.000Z');
    expect(data.stability).toBe(999);
    expect(data.tldr).toBe('Custom tldr');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { ingestFile } from '../../src/ingest/pipeline.js';

describe('ingestFile', () => {
  let tempDir: string;
  let vaultDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-ingest-'));
    vaultDir = join(tempDir, 'vault');
    vault = createFsAdapter(vaultDir);
    await vault.ensureFolder('raw');
    await vault.ensureFolder('outputs/source-summaries');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ingests a markdown file', async () => {
    const sourcePath = join(tempDir, 'meeting-notes.md');
    await writeFile(sourcePath, '# Team Meeting\n\nWe decided to use TypeScript.\n', 'utf-8');

    const result = await ingestFile(sourcePath, vault);

    expect(result.sourceType).toBe('markdown');
    expect(result.rawPath).toContain('raw/');
    expect(result.rawPath).toContain('meeting-notes.md');
    expect(result.sourceSummaryPath).toContain('outputs/source-summaries/');
    expect(result.sourceHash).toBeTruthy();

    // Verify raw copy exists
    const rawContent = await vault.read(result.rawPath);
    expect(rawContent).toContain('Team Meeting');

    // Verify source summary exists
    const summaryContent = await vault.read(result.sourceSummaryPath);
    expect(summaryContent).toContain('meeting-notes');
    expect(summaryContent).toContain('source_summary');
    expect(summaryContent).toContain('We decided to use TypeScript');
  });

  it('ingests a plaintext file', async () => {
    const sourcePath = join(tempDir, 'notes.txt');
    await writeFile(sourcePath, 'Some plain text notes.\n', 'utf-8');

    const result = await ingestFile(sourcePath, vault);
    expect(result.sourceType).toBe('plaintext');
  });

  it('preserves raw file immutability (no overwrite)', async () => {
    const sourcePath = join(tempDir, 'test.md');
    await writeFile(sourcePath, 'Version 1', 'utf-8');

    const result1 = await ingestFile(sourcePath, vault);

    // Modify source file
    await writeFile(sourcePath, 'Version 2', 'utf-8');

    // Raw copy should still have original content
    const rawContent = await vault.read(result1.rawPath);
    expect(rawContent).toBe('Version 1');
  });

  it('generates unique summary paths for same-name files', async () => {
    const source1 = join(tempDir, 'doc.md');
    await writeFile(source1, 'Content 1', 'utf-8');
    const result1 = await ingestFile(source1, vault);

    // Write a different file but same name from another path
    const subDir = join(tempDir, 'sub');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(subDir, { recursive: true });
    const source2 = join(subDir, 'doc.md');
    await writeFile(source2, 'Content 2', 'utf-8');
    const result2 = await ingestFile(source2, vault);

    expect(result1.sourceSummaryPath).not.toBe(result2.sourceSummaryPath);
  });

  it('ingests a JSON file with structured extraction', async () => {
    const sourcePath = join(tempDir, 'data.json');
    await writeFile(sourcePath, JSON.stringify({ users: [1, 2, 3], version: '1.0' }), 'utf-8');

    const result = await ingestFile(sourcePath, vault);
    expect(result.sourceType).toBe('json');

    const summaryContent = await vault.read(result.sourceSummaryPath);
    expect(summaryContent).toContain('JSON Object');
    expect(summaryContent).toContain('users');
  });

  it('ingests a CSV file with structured extraction', async () => {
    const sourcePath = join(tempDir, 'report.csv');
    await writeFile(sourcePath, 'name,score,grade\nAlice,95,A\nBob,87,B\n', 'utf-8');

    const result = await ingestFile(sourcePath, vault);
    expect(result.sourceType).toBe('csv');

    const summaryContent = await vault.read(result.sourceSummaryPath);
    expect(summaryContent).toContain('CSV');
    expect(summaryContent).toContain('3 columns');
    expect(summaryContent).toContain('name');
  });

  it('ingests a code file with signature extraction', async () => {
    const sourcePath = join(tempDir, 'utils.ts');
    await writeFile(sourcePath, 'export function greet(name: string): string {\n  return `Hello ${name}`;\n}\n', 'utf-8');

    const result = await ingestFile(sourcePath, vault);
    expect(result.sourceType).toBe('code');

    const summaryContent = await vault.read(result.sourceSummaryPath);
    expect(summaryContent).toContain('Code');
    expect(summaryContent).toContain('export function greet');
  });
});

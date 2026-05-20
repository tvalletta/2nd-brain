import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';

describe('FsAdapter', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-test-'));
    vault = createFsAdapter(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ensureFolder creates nested directories', async () => {
    await vault.ensureFolder('wiki/entities/people');
    expect(await vault.exists('wiki/entities/people')).toBe(true);
  });

  it('create and read a file', async () => {
    await vault.ensureFolder('wiki');
    await vault.create('wiki/test.md', '# Test\n\nContent.');
    const content = await vault.read('wiki/test.md');
    expect(content).toBe('# Test\n\nContent.');
  });

  it('create fails if file already exists', async () => {
    await vault.ensureFolder('wiki');
    await vault.create('wiki/test.md', 'first');
    await expect(vault.create('wiki/test.md', 'second')).rejects.toThrow('already exists');
  });

  it('write overwrites existing file', async () => {
    await vault.ensureFolder('wiki');
    await vault.create('wiki/test.md', 'first');
    await vault.write('wiki/test.md', 'second');
    expect(await vault.read('wiki/test.md')).toBe('second');
  });

  it('exists returns false for missing files', async () => {
    expect(await vault.exists('nonexistent.md')).toBe(false);
  });

  it('listMarkdownFiles finds .md files recursively', async () => {
    await vault.ensureFolder('wiki/entities');
    await vault.create('wiki/test1.md', 'a');
    await vault.create('wiki/entities/test2.md', 'b');
    await vault.create('wiki/entities/test3.txt', 'c');

    const files = await vault.listMarkdownFiles('wiki');
    expect(files.sort()).toEqual(['wiki/entities/test2.md', 'wiki/test1.md']);
  });

  it('listMarkdownFiles returns empty for missing dir', async () => {
    const files = await vault.listMarkdownFiles('nonexistent');
    expect(files).toEqual([]);
  });

  it('atomicWrite creates file atomically', async () => {
    await vault.atomicWrite('wiki/atomic.md', '# Atomic\n');
    expect(await vault.read('wiki/atomic.md')).toBe('# Atomic\n');
  });

  it('getModifiedTime returns a timestamp', async () => {
    await vault.ensureFolder('wiki');
    await vault.create('wiki/timed.md', 'content');
    const mtime = await vault.getModifiedTime('wiki/timed.md');
    expect(mtime).toBeGreaterThan(0);
  });

  it('getModifiedTime returns 0 for missing file', async () => {
    const mtime = await vault.getModifiedTime('missing.md');
    expect(mtime).toBe(0);
  });

  describe('path traversal prevention', () => {
    it('rejects relative traversal', async () => {
      await expect(vault.read('../../etc/passwd')).rejects.toThrow('Path traversal detected');
    });

    it('rejects absolute paths outside vault', async () => {
      await expect(vault.read('/etc/passwd')).rejects.toThrow('Path traversal detected');
    });

    it('rejects embedded traversal', async () => {
      await expect(vault.read('wiki/../../etc/shadow')).rejects.toThrow('Path traversal detected');
    });

    it('allows normal nested paths', async () => {
      await vault.ensureFolder('wiki/entities');
      await vault.create('wiki/entities/test.md', 'content');
      const content = await vault.read('wiki/entities/test.md');
      expect(content).toBe('content');
    });

    it('allows paths resolving to vault root', async () => {
      await expect(vault.ensureFolder('.')).resolves.not.toThrow();
    });
  });
});

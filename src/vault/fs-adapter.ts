import { readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join, relative, extname, resolve as pathResolve, sep } from 'node:path';
import type { VaultAdapter } from './adapter.js';
import { atomicWrite as atomicWriteUtil, ensureDir, fileExists } from '../shared/fs-utils.js';
import { VaultError } from '../shared/errors.js';

export function createFsAdapter(vaultRoot: string): VaultAdapter {
  const normalizedRoot = pathResolve(vaultRoot);

  function resolve(path: string): string {
    const resolved = pathResolve(normalizedRoot, path);
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
      throw new VaultError(`Path traversal detected: ${path}`);
    }
    return resolved;
  }

  async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await collectMarkdownFiles(fullPath);
        results.push(...nested);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        results.push(relative(vaultRoot, fullPath));
      }
    }
    return results;
  }

  return {
    async ensureFolder(path) {
      await ensureDir(resolve(path));
    },

    async listMarkdownFiles(folder) {
      return collectMarkdownFiles(resolve(folder));
    },

    async listFiles(folder, pattern) {
      const results: string[] = [];
      const dirPath = resolve(folder);
      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
      } catch {
        return results;
      }

      for (const entry of entries) {
        if (entry.isFile()) {
          const relPath = relative(vaultRoot, join(entry.parentPath ?? dirPath, entry.name));
          if (!pattern || relPath.endsWith(pattern)) {
            results.push(relPath);
          }
        }
      }
      return results;
    },

    async read(path) {
      try {
        return await readFile(resolve(path), 'utf-8');
      } catch (err) {
        throw new VaultError(`Failed to read ${path}: ${(err as Error).message}`);
      }
    },

    async write(path, content) {
      const fullPath = resolve(path);
      await ensureDir(join(fullPath, '..'));
      await writeFile(fullPath, content, 'utf-8');
    },

    async create(path, content) {
      const fullPath = resolve(path);
      if (await fileExists(fullPath)) {
        throw new VaultError(`File already exists: ${path}`);
      }
      await ensureDir(join(fullPath, '..'));
      await writeFile(fullPath, content, 'utf-8');
    },

    async exists(path) {
      return fileExists(resolve(path));
    },

    async getModifiedTime(path) {
      try {
        const s = await stat(resolve(path));
        return s.mtimeMs;
      } catch {
        return 0;
      }
    },

    async atomicWrite(path, content) {
      await atomicWriteUtil(resolve(path), content);
    },

    async delete(path) {
      try {
        await unlink(resolve(path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new VaultError(`Failed to delete ${path}: ${(err as Error).message}`);
        }
      }
    },
  };
}

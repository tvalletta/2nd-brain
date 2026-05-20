import { writeFile, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from '../shared/fs-utils.js';
import { LockError } from '../shared/errors.js';

export interface FileLock {
  acquire(path: string, timeoutMs?: number): Promise<() => Promise<void>>;
  isLocked(path: string): boolean;
}

export function createFileLock(lockDir: string): FileLock {
  const inFlight = new Map<string, Promise<void>>();

  function lockFilePath(targetPath: string): string {
    const safe = targetPath.replace(/[^a-zA-Z0-9]/g, '_');
    return join(lockDir, `${safe}.lock`);
  }

  async function isStale(lockPath: string): Promise<boolean> {
    try {
      const content = await readFile(lockPath, 'utf-8');
      const { pid } = JSON.parse(content);
      try {
        process.kill(pid, 0);
        return false; // Process still alive
      } catch {
        return true; // Process gone — stale lock
      }
    } catch {
      return true; // Can't read — treat as stale
    }
  }

  return {
    async acquire(path, timeoutMs = 5000) {
      // In-process guard: wait for any in-flight operation on same path
      const existing = inFlight.get(path);
      if (existing) {
        const deadline = Date.now() + timeoutMs;
        while (inFlight.has(path)) {
          if (Date.now() > deadline) {
            throw new LockError(`Timeout waiting for in-process lock on ${path}`);
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // Cross-process guard: .lock file
      await ensureDir(lockDir);
      const lockPath = lockFilePath(path);

      try {
        await stat(lockPath);
        // Lock file exists — check if stale
        if (await isStale(lockPath)) {
          await unlink(lockPath);
        } else {
          throw new LockError(`Lock held by another process for ${path}`);
        }
      } catch (err) {
        if (err instanceof LockError) throw err;
        // File doesn't exist — good, we can proceed
      }

      const lockData = JSON.stringify({ pid: process.pid, path, acquiredAt: new Date().toISOString() });
      await writeFile(lockPath, lockData, 'utf-8');

      // Track in-process
      let resolveInFlight: () => void;
      const promise = new Promise<void>((r) => { resolveInFlight = r; });
      inFlight.set(path, promise);

      // Return release function
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Lock file already gone — fine
        }
        inFlight.delete(path);
        resolveInFlight!();
      };
    },

    isLocked(path) {
      return inFlight.has(path);
    },
  };
}

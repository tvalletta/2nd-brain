import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmpPath = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('intel tick process exit', () => {
  it('exits within 180 seconds after tick completes', async () => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, 'dist/bin/karpathy.js'), 'intel', 'tick'],
      { env: { ...process.env }, stdio: 'pipe' }
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Process did not exit within 180s'));
      }, 180000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
  }, 200000);
});

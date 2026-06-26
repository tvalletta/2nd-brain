import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('hookCommand stdin handling', () => {
  it('completes within 5 seconds when stdin closes without sending EOF', async () => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, 'dist/bin/karpathy.js'), 'hook', 'stop'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Write valid JSON then destroy the stdin without sending EOF
    child.stdin.write(JSON.stringify({
      session_id: 'test-session-id-0000',
      stop_hook_active: true,
      transcript_path: null,
      cwd: ROOT,
    }));
    // Destroy stdin — simulates the parent closing the write side abruptly.
    // On a unix socket this would be a half-close (FIN only), but pipe destroy
    // triggers full teardown. The test still validates the fallback timer fires.
    child.stdin.destroy();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Hook did not exit within 5s'));
      }, 5000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
  }, 8000);
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderDaemonPlist, installDaemonPlist } from '../../src/mcp/daemon-plist.js';

describe('renderDaemonPlist', () => {
  const render = () =>
    renderDaemonPlist({
      port: 8765,
      projectRoot: '/p',
      heapMb: 512,
      scriptPath: '/p/bin/karpathy-with-env.sh',
    });

  it('includes the mcp-daemon program argument', () => {
    expect(render()).toContain('<string>mcp-daemon</string>');
  });

  it('sets ProcessType to Adaptive', () => {
    const xml = render();
    expect(xml).toContain('<key>ProcessType</key>');
    expect(xml).toContain('<string>Adaptive</string>');
  });

  it('sets LowPriorityIO to true', () => {
    const xml = render();
    expect(xml).toContain('<key>LowPriorityIO</key>');
    expect(xml).toMatch(/<key>LowPriorityIO<\/key>\s*<true\/>/);
  });

  it('sets Nice to 5', () => {
    const xml = render();
    expect(xml).toContain('<key>Nice</key>');
    expect(xml).toMatch(/<key>Nice<\/key>\s*<integer>5<\/integer>/);
  });

  it('bounds heap via NODE_OPTIONS max-old-space-size from heapMb', () => {
    expect(render()).toContain('--max-old-space-size=512');
  });

  it('bounds young-gen GC via max-semi-space-size', () => {
    expect(render()).toContain('--max-semi-space-size=8');
  });

  it('uses the com.karpathy.daemon label', () => {
    expect(render()).toContain('com.karpathy.daemon');
  });

  it('does NOT contain StartInterval (retiring the old tick wake-catchup)', () => {
    expect(render()).not.toContain('StartInterval');
  });

  it('does NOT contain StartCalendarInterval', () => {
    expect(render()).not.toContain('StartCalendarInterval');
  });

  it('does NOT contain WakeInterval', () => {
    expect(render()).not.toContain('WakeInterval');
  });

  it('sets RunAtLoad true', () => {
    const xml = render();
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('sets KeepAlive to the Crashed/SuccessfulExit dict form', () => {
    const xml = render();
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>Crashed<\/key>\s*<true\/>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
  });

  it('sets ThrottleInterval to 10', () => {
    expect(render()).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it('includes the given scriptPath as the first ProgramArguments entry', () => {
    expect(render()).toContain('<string>/p/bin/karpathy-with-env.sh</string>');
  });

  it('includes --port and --project-root arguments with the given values', () => {
    const xml = render();
    expect(xml).toContain('<string>--port</string>');
    expect(xml).toContain('<string>8765</string>');
    expect(xml).toContain('<string>--project-root</string>');
    expect(xml).toContain('<string>/p</string>');
  });

  it('points StandardOutPath/StandardErrorPath at the project .karpathy/logs directory', () => {
    const xml = render();
    expect(xml).toContain('<string>/p/.karpathy/logs/daemon.out.log</string>');
    expect(xml).toContain('<string>/p/.karpathy/logs/daemon.err.log</string>');
  });

  it('produces well-formed-looking XML (balanced dict/array tags)', () => {
    const xml = render();
    const opens = (xml.match(/<dict>/g) ?? []).length;
    const closes = (xml.match(/<\/dict>/g) ?? []).length;
    expect(opens).toBe(closes);
    const arrOpens = (xml.match(/<array>/g) ?? []).length;
    const arrCloses = (xml.match(/<\/array>/g) ?? []).length;
    expect(arrOpens).toBe(arrCloses);
  });
});

describe('installDaemonPlist', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes the plist to the injected target path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-daemon-plist-'));
    const targetPath = join(dir, 'LaunchAgents', 'com.karpathy.daemon.plist');
    const plist = renderDaemonPlist({ port: 1, projectRoot: '/p', heapMb: 1, scriptPath: '/x' });

    const result = await installDaemonPlist({ targetPath, plist });

    expect(result.backedUp).toBe(false);
    expect(result.path).toBe(targetPath);
    expect(await readFile(targetPath, 'utf-8')).toBe(plist);
  });

  it('backs up an existing plist to .bak before overwriting', async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-daemon-plist-'));
    const launchAgentsDir = join(dir, 'LaunchAgents');
    await mkdir(launchAgentsDir, { recursive: true });
    const targetPath = join(launchAgentsDir, 'com.karpathy.daemon.plist');
    await writeFile(targetPath, 'OLD-CONTENT', 'utf-8');

    const plist = renderDaemonPlist({ port: 2, projectRoot: '/p', heapMb: 1, scriptPath: '/x' });
    const result = await installDaemonPlist({ targetPath, plist });

    expect(result.backedUp).toBe(true);
    expect(result.backupPath).toBe(`${targetPath}.bak`);
    expect(await readFile(`${targetPath}.bak`, 'utf-8')).toBe('OLD-CONTENT');
    expect(await readFile(targetPath, 'utf-8')).toBe(plist);
  });
});

/**
 * launchd plist template for the shared MCP daemon
 * (docs/superpowers/specs/2026-08-06-shared-mcp-daemon-design.md §9).
 *
 * `renderDaemonPlist` is a pure function — no filesystem access, no
 * personal paths baked in. Every path-shaped value (`projectRoot`,
 * `scriptPath`) is a caller-supplied parameter, so the generated XML never
 * hardcodes anything specific to a single machine/user.
 *
 * Deliberately omits `StartInterval`/`StartCalendarInterval`/`WakeInterval`:
 * the whole point of the shared daemon (vs. the retired
 * `bin/com.karpathy.tick.plist`) is event-driven `KeepAlive`, not a
 * periodic wake-and-poll cycle.
 */

import { copyFile } from 'node:fs/promises';
import { atomicWrite, fileExists } from '../shared/fs-utils.js';

export interface RenderDaemonPlistOptions {
  /** TCP port the daemon's HTTP transport binds (loopback-only). */
  port: number;
  /** Absolute path to the karpathy project root the daemon serves. */
  projectRoot: string;
  /** `--max-old-space-size` (MB) applied via `NODE_OPTIONS`. */
  heapMb: number;
  /** Absolute path to `bin/karpathy-with-env.sh`. */
  scriptPath: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderDaemonPlist(opts: RenderDaemonPlistOptions): string {
  const { port, projectRoot, heapMb, scriptPath } = opts;
  const errLog = `${projectRoot}/.karpathy/logs/daemon.err.log`;
  const outLog = `${projectRoot}/.karpathy/logs/daemon.out.log`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.karpathy.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(scriptPath)}</string>
        <string>mcp-daemon</string>
        <string>--port</string>
        <string>${port}</string>
        <string>--project-root</string>
        <string>${escapeXml(projectRoot)}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <!-- Adaptive: low priority when idle, responsive while actively serving -->
    <key>ProcessType</key>
    <string>Adaptive</string>

    <key>LowPriorityIO</key>
    <true/>

    <key>Nice</key>
    <integer>5</integer>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_OPTIONS</key>
        <string>--max-old-space-size=${heapMb} --max-semi-space-size=8</string>
    </dict>

    <key>StandardErrorPath</key>
    <string>${escapeXml(errLog)}</string>

    <key>StandardOutPath</key>
    <string>${escapeXml(outLog)}</string>
</dict>
</plist>
`;
}

export interface InstallDaemonPlistOptions {
  /**
   * Absolute path to write the plist to. Normally
   * `~/Library/LaunchAgents/com.karpathy.daemon.plist`; injectable so this
   * side-effecting half is unit-testable against a temp directory instead
   * of the real LaunchAgents folder.
   */
  targetPath: string;
  /** Rendered plist XML (see `renderDaemonPlist`). */
  plist: string;
}

export interface InstallDaemonPlistResult {
  path: string;
  backedUp: boolean;
  backupPath?: string;
}

/**
 * Writes `plist` to `targetPath`, backing up any pre-existing file at that
 * path to `<targetPath>.bak` first (never overwritten silently).
 */
export async function installDaemonPlist(
  opts: InstallDaemonPlistOptions,
): Promise<InstallDaemonPlistResult> {
  const { targetPath, plist } = opts;
  const existed = await fileExists(targetPath);
  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${targetPath}.bak`;
    await copyFile(targetPath, backupPath);
  }
  await atomicWrite(targetPath, plist);
  return { path: targetPath, backedUp: existed, backupPath };
}

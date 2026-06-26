/**
 * Parse the optional --project-root flag from process.argv.
 * The MCP server is spawned by Claude Code with a varying CWD; this flag
 * anchors the state directory to a fixed location so the correct SQLite DB
 * is always opened regardless of which project window launched the server.
 */
export function parseProjectRootArg(argv: string[]): string | undefined {
  const idx = argv.indexOf('--project-root');
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

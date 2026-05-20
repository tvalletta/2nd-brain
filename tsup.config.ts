import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry — needs shebang for direct execution
  {
    entry: { 'bin/karpathy': 'src/bin/karpathy.ts' },
    format: ['esm'],
    target: 'node18',
    sourcemap: true,
    clean: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['better-sqlite3'],
  },
  // Library + MCP server — no shebang (stdout is JSON-RPC)
  {
    entry: {
      index: 'src/index.ts',
      'mcp/server': 'src/mcp/server.ts',
    },
    format: ['esm'],
    target: 'node18',
    sourcemap: true,
    clean: false,
    dts: false,
  },
]);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPContext } from './context.js';
import { TOOL_DEFINITIONS } from './tools/index.js';
import { handleToolCall } from './tools/router.js';
import { RESOURCE_DEFINITIONS, handleResourceRead } from './resources.js';
import { buildInstructions } from './instructions.js';

/**
 * Builds a fully-wired MCP `Server` — ListTools/CallTool/ListResources/
 * ReadResource handlers plus layout-derived instructions — without
 * connecting any transport. Shared by the stdio server (`server.ts`) and
 * the HTTP daemon (Task 6), so both build an identical server from one
 * place.
 */
export function createMcpServer(ctx: MCPContext): Server {
  const server = new Server(
    { name: 'karpathy', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: buildInstructions(ctx.config.layout),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params, ctx),
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCE_DEFINITIONS,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    handleResourceRead(request.params, ctx),
  );

  return server;
}

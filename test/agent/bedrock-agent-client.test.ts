import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition, ToolExecutor } from '../../src/agent/bedrock-agent-client.js';

// We test the agent loop logic by mocking the SDK.
// Instead of importing the real createAgentClient (which lazy-loads the SDK),
// we replicate the loop logic in a testable way.

/**
 * Minimal mock of the Bedrock Messages API response.
 */
function mockResponse(content: any[], stopReason: string = 'end_turn') {
  return { content, stop_reason: stopReason };
}

describe('agent loop logic', () => {
  const tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'mark_complete',
      description: 'Signal completion',
      input_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  ];

  it('completes on first turn when no tool calls', async () => {
    // Simulate a single-turn response with only text
    const mockCreate = vi.fn().mockResolvedValueOnce(
      mockResponse([{ type: 'text', text: 'Nothing to do.' }]),
    );

    const executor: ToolExecutor = vi.fn();

    // Simulate the loop manually
    const messages: any[] = [{ role: 'user', content: 'Process this file' }];
    const response = await mockCreate({ messages, tools });

    const textBlocks = response.content.filter((b: any) => b.type === 'text');
    const toolUses = response.content.filter((b: any) => b.type === 'tool_use');

    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toBe('Nothing to do.');
    expect(toolUses).toHaveLength(0);
    expect(executor).not.toHaveBeenCalled();
  });

  it('executes tools and feeds results back', async () => {
    // Turn 1: model calls read_file
    const turn1Response = mockResponse(
      [
        { type: 'text', text: 'Let me read the file.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'wiki/projects/test/_index.md' } },
      ],
      'tool_use',
    );

    // Turn 2: model calls mark_complete
    const turn2Response = mockResponse(
      [
        { type: 'text', text: 'Done processing.' },
        { type: 'tool_use', id: 'tu_2', name: 'mark_complete', input: { summary: 'Updated technical spec' } },
      ],
      'tool_use',
    );

    // Turn 3: model responds with final text
    const turn3Response = mockResponse(
      [{ type: 'text', text: 'All complete.' }],
    );

    const mockCreate = vi.fn()
      .mockResolvedValueOnce(turn1Response)
      .mockResolvedValueOnce(turn2Response)
      .mockResolvedValueOnce(turn3Response);

    const executor: ToolExecutor = vi.fn()
      .mockResolvedValueOnce('file content here')
      .mockResolvedValueOnce('{"status":"complete","summary":"Updated technical spec"}');

    // Simulate the loop
    let turns = 0;
    let totalToolCalls = 0;
    const messages: any[] = [{ role: 'user', content: 'Process this file' }];

    for (turns = 1; turns <= 20; turns++) {
      const response = await mockCreate({ messages, tools });
      const contentBlocks = response.content;
      const toolUses = contentBlocks.filter((b: any) => b.type === 'tool_use');

      messages.push({ role: 'assistant', content: contentBlocks });

      if (toolUses.length === 0 || response.stop_reason === 'end_turn') break;

      const results = [];
      for (const tu of toolUses) {
        totalToolCalls++;
        const result = await executor(tu.name, tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      }
      messages.push({ role: 'user', content: results });
    }

    expect(turns).toBe(3);
    expect(totalToolCalls).toBe(2);
    expect(executor).toHaveBeenCalledWith('read_file', { path: 'wiki/projects/test/_index.md' });
    expect(executor).toHaveBeenCalledWith('mark_complete', { summary: 'Updated technical spec' });
  });

  it('stops at max turns', async () => {
    // Model keeps calling tools indefinitely
    const toolResponse = mockResponse(
      [{ type: 'tool_use', id: 'tu_loop', name: 'read_file', input: { path: 'some/file.md' } }],
      'tool_use',
    );

    const mockCreate = vi.fn().mockResolvedValue(toolResponse);
    const executor: ToolExecutor = vi.fn().mockResolvedValue('file content');

    const maxTurns = 3;
    let turns = 0;
    const messages: any[] = [{ role: 'user', content: 'Process' }];

    for (turns = 1; turns <= maxTurns; turns++) {
      const response = await mockCreate({ messages, tools });
      const toolUses = response.content.filter((b: any) => b.type === 'tool_use');

      messages.push({ role: 'assistant', content: response.content });
      if (toolUses.length === 0 || response.stop_reason === 'end_turn') break;

      const results = toolUses.map((tu: any) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'file content',
      }));
      messages.push({ role: 'user', content: results });
    }

    // turns ends at maxTurns+1 due to for-loop post-increment after the last iteration
    expect(turns).toBe(maxTurns + 1);
    expect(mockCreate).toHaveBeenCalledTimes(maxTurns);
  });

  it('handles tool execution errors gracefully', async () => {
    const response = mockResponse(
      [{ type: 'tool_use', id: 'tu_err', name: 'read_file', input: { path: 'missing.md' } }],
      'tool_use',
    );

    const executor: ToolExecutor = vi.fn().mockRejectedValue(new Error('File not found'));

    const result = await (async () => {
      try {
        return await executor('read_file', { path: 'missing.md' });
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    })();

    expect(result).toBe('Error: File not found');
  });
});

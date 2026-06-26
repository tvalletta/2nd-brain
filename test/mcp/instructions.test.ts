import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../../src/mcp/instructions.js';

describe('buildInstructions', () => {
  const instructions = buildInstructions();

  it('routes keyword search to "search" not "search_vault"', () => {
    // The "Which search tool" table must not recommend search_vault for keyword lookups
    expect(instructions).not.toMatch(/keyword.*search_vault/i);
  });

  it('mentions "search" as the primary tool for finding notes', () => {
    expect(instructions).toMatch(/\bsearch\b/);
  });

  it('marks search_vault as deprecated in the instructions', () => {
    expect(instructions.toLowerCase()).toMatch(/search_vault.*deprecated|deprecated.*search_vault/);
  });
});

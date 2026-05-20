import { describe, it, expect } from 'vitest';
import { isNoiseEntity } from '../../src/enrichment/entity-filter.js';

describe('isNoiseEntity', () => {
  it('filters names shorter than 2 characters', () => {
    expect(isNoiseEntity('A', 'person')).toBe(true);
    expect(isNoiseEntity('x', 'concept')).toBe(true);
    expect(isNoiseEntity('', 'tool')).toBe(true);
  });

  it('allows names with 2+ characters', () => {
    expect(isNoiseEntity('AI', 'concept')).toBe(true); // blocklisted
    expect(isNoiseEntity('Go', 'concept')).toBe(false); // not blocklisted, 2 chars
  });

  it('filters built-in blocklist entries (case-insensitive)', () => {
    expect(isNoiseEntity('User', 'person')).toBe(true);
    expect(isNoiseEntity('ASSISTANT', 'person')).toBe(true);
    expect(isNoiseEntity('system', 'concept')).toBe(true);
    expect(isNoiseEntity('The User', 'person')).toBe(true);
    expect(isNoiseEntity('N/A', 'concept')).toBe(true);
    expect(isNoiseEntity('null', 'concept')).toBe(true);
    expect(isNoiseEntity('undefined', 'concept')).toBe(true);
    expect(isNoiseEntity('API', 'tool')).toBe(true);
    expect(isNoiseEntity('cli', 'tool')).toBe(true);
  });

  it('allows legitimate names that are not blocklisted', () => {
    expect(isNoiseEntity('Alice', 'person')).toBe(false);
    expect(isNoiseEntity('React', 'concept')).toBe(false);
    expect(isNoiseEntity('Auth Module', 'project')).toBe(false);
    expect(isNoiseEntity('Kubernetes', 'tool')).toBe(false);
  });

  it('filters agent tool names (hyphenated)', () => {
    expect(isNoiseEntity('classify-cwd', 'tool')).toBe(true);
    expect(isNoiseEntity('create-entity', 'tool')).toBe(true);
    expect(isNoiseEntity('read-file', 'tool')).toBe(true);
    expect(isNoiseEntity('search-wiki', 'tool')).toBe(true);
    expect(isNoiseEntity('update-protected-region', 'tool')).toBe(true);
  });

  it('filters agent tool names (underscore MCP style)', () => {
    expect(isNoiseEntity('classify_cwd', 'tool')).toBe(true);
    expect(isNoiseEntity('create_entity', 'tool')).toBe(true);
    expect(isNoiseEntity('read_file', 'tool')).toBe(true);
    expect(isNoiseEntity('search_wiki', 'tool')).toBe(true);
  });

  it('filters agent tool names regardless of kind', () => {
    expect(isNoiseEntity('read-file', 'concept')).toBe(true);
    expect(isNoiseEntity('create-page', 'project')).toBe(true);
  });

  it('filters custom blocklist entries', () => {
    const custom = ['Jira', 'Confluence', 'internal-tool'];
    expect(isNoiseEntity('Jira', 'tool', custom)).toBe(true);
    expect(isNoiseEntity('jira', 'tool', custom)).toBe(true);
    expect(isNoiseEntity('CONFLUENCE', 'tool', custom)).toBe(true);
    expect(isNoiseEntity('internal-tool', 'concept', custom)).toBe(true);
  });

  it('does not filter valid names that are not in custom blocklist', () => {
    const custom = ['Jira'];
    expect(isNoiseEntity('Slack', 'tool', custom)).toBe(false);
    expect(isNoiseEntity('GitHub', 'tool', custom)).toBe(false);
  });

  it('trims whitespace before checking', () => {
    expect(isNoiseEntity('  user  ', 'person')).toBe(true);
    expect(isNoiseEntity('  Alice  ', 'person')).toBe(false);
  });
});

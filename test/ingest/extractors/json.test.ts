import { describe, it, expect } from 'vitest';
import { extractJson } from '../../../src/ingest/extractors/json.js';

describe('extractJson', () => {
  it('extracts top-level keys from JSON object', () => {
    const content = JSON.stringify({ name: 'Alice', age: 30, role: 'engineer' });
    const result = extractJson(content);
    expect(result).toContain('**JSON Object**');
    expect(result).toContain('3 keys');
    expect(result).toContain('name');
    expect(result).toContain('Alice');
  });

  it('extracts array summary with count and sample', () => {
    const content = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    const result = extractJson(content);
    expect(result).toContain('**JSON Array**');
    expect(result).toContain('5 items');
    expect(result).toContain('Sample (first 3)');
  });

  it('handles invalid JSON gracefully', () => {
    const content = 'this is not json {{{';
    const result = extractJson(content);
    expect(result).toBe(content);
  });

  it('truncates long string values', () => {
    const longVal = 'x'.repeat(500);
    const content = JSON.stringify({ text: longVal });
    const result = extractJson(content);
    expect(result).toContain('...');
    expect(result).not.toContain('x'.repeat(500));
  });

  it('handles JSON primitives', () => {
    const result = extractJson('"hello world"');
    expect(result).toContain('**JSON Primitive:**');
    expect(result).toContain('hello world');
  });
});

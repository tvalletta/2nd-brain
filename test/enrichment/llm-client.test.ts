import { describe, it, expect } from 'vitest';
import { extractJSON } from '../../src/enrichment/llm-client.js';

describe('extractJSON', () => {
  it('parses a fenced ```json object block (existing behavior, unaffected)', () => {
    const raw = 'Here is the result:\n```json\n{"a":1}\n```\nDone.';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('parses a fenced ```json array block (existing behavior, unaffected)', () => {
    const raw = '```json\n[{"a":1},{"b":2}]\n```';
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('falls back to a bare object when no fence is present', () => {
    const raw = 'some prose {"a":1} more prose';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('does NOT overshoot past trailing prose containing a stray closing brace (the I10 root cause)', () => {
    const raw = 'prose {"a":1} more prose mentioning a config block } stray brace';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('falls back to a bare ARRAY when no fence is present (previously unsupported — the fallback only handled objects)', () => {
    const raw = 'prose [{"a":1},{"b":2}] trailing text with a stray } brace too';
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('respects string boundaries when counting braces (a value containing a brace-like character does not break scanning)', () => {
    const raw = 'prose {"reason":"see the {config} block"} trailing prose with another }';
    expect(extractJSON(raw)).toEqual({ reason: 'see the {config} block' });
  });
});

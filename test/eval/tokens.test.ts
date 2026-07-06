import { describe, it, expect } from 'vitest';
import { measurePayload } from '../../eval/score/tokens.js';

describe('measurePayload', () => {
  it('counts exact JSON chars and estimates tokens at chars/4', () => {
    const payload = [{ path: 'a/b.md', excerpt: 'hello world' }];
    const json = JSON.stringify(payload);
    const { chars, tokensEst } = measurePayload(payload);
    expect(chars).toBe(json.length);
    expect(tokensEst).toBe(Math.ceil(json.length / 4));
  });

  it('treats null/undefined as the literal null payload', () => {
    expect(measurePayload(undefined).chars).toBe('null'.length);
  });
});

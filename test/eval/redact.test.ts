import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../eval/pool/redact.js';

describe('redactSecrets', () => {
  it('redacts an assignment-style fake secret (KEY="value")', () => {
    const input = 'Config dump: CONFLUENCE_PERSONAL_TOKEN="fake1234567890abcdefFAKE" was set.';
    const output = redactSecrets(input);
    expect(output).not.toContain('fake1234567890abcdefFAKE');
    expect(output).toContain('CONFLUENCE_PERSONAL_TOKEN=[REDACTED]');
  });

  it('redacts a colon-prefixed long token string', () => {
    const input = 'Bearer token for user-FAKEUSER-DEV-at-000000000000:zzFakeTokenValue1234567890abcdef end.';
    const output = redactSecrets(input);
    expect(output).not.toContain('zzFakeTokenValue1234567890abcdef');
    expect(output).toContain('user-FAKEUSER-DEV-at-000000000000:[REDACTED]');
  });

  it('redacts a short, already-truncated colon-prefixed fragment (e.g. a partial pasted key)', () => {
    const input = 'Partial fragment seen in the note: user-FAKEUSER-DEV-at-000000000000:zzFake12... was pasted by mistake.';
    const output = redactSecrets(input);
    expect(output).not.toContain('zzFake12');
    expect(output).toContain('user-FAKEUSER-DEV-at-000000000000:[REDACTED]');
  });

  it('does not mangle an ordinary URL (the "://" scheme separator is excluded)', () => {
    const input = 'See https://example.com/some-really-long-path-fragment-here for details.';
    expect(redactSecrets(input)).toBe(input);
  });

  it('does not mangle short structural word:value syntax (e.g. Obsidian fold-comment markers)', () => {
    const input = '%% begin:abc12345 %%\nSome folded note content here.\n%% end:abc12345 %%';
    expect(redactSecrets(input)).toBe(input);
  });

  it('leaves ordinary prose with no secret-like patterns completely unchanged', () => {
    const input =
      'We discussed the eval pipeline design today and decided to pool candidates ' +
      'from four sources before running the judge. No credentials were mentioned here.';
    expect(redactSecrets(input)).toBe(input);
  });
});

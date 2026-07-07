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

  it('leaves ordinary prose with no secret-like patterns completely unchanged', () => {
    const input =
      'We discussed the eval pipeline design today and decided to pool candidates ' +
      'from four sources before running the judge. No credentials were mentioned here.';
    expect(redactSecrets(input)).toBe(input);
  });
});

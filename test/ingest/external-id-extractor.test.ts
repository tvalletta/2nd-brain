import { describe, it, expect } from 'vitest';
import { extractSlackHandleIds } from '../../src/ingest/external-id-extractor.js';

// Reproduced verbatim from the real vault finding (B2c design §0.1):
// raw/2026-05-15/Directors Squad Offsite - Jan 2025.md
const REAL_FIXTURE = `
* [@pino](https://adobe.enterprise.slack.com/team/U01FZCB8X29)
Ownership: PM, PMM ([@pvaughn](https://adobe.enterprise.slack.com/team/U08C58CF45A))
Ownership: Eng, UX ([@brownf](https://adobe.enterprise.slack.com/team/U01MCKEDYAH))
Ownership: PgM ([@mewing](https://adobe.enterprise.slack.com/team/W5S3UAN8M))
`;

describe('extractSlackHandleIds', () => {
  it('extracts all four handle -> ID pairs from the real vault fixture', () => {
    const map = extractSlackHandleIds(REAL_FIXTURE);
    expect(map.get('pino')).toBe('slack:U01FZCB8X29');
    expect(map.get('pvaughn')).toBe('slack:U08C58CF45A');
    expect(map.get('brownf')).toBe('slack:U01MCKEDYAH');
    expect(map.get('mewing')).toBe('slack:W5S3UAN8M');
    expect(map.size).toBe(4);
  });

  it('ignores a non-Slack markdown link', () => {
    const map = extractSlackHandleIds('[@someone](https://example.com/team/U01FZCB8X29)');
    expect(map.size).toBe(0);
  });

  it('ignores a Slack link with a malformed/too-short ID', () => {
    const map = extractSlackHandleIds('[@x](https://foo.slack.com/team/U01)');
    expect(map.size).toBe(0);
  });

  it('keeps the first ID seen for a duplicate handle', () => {
    const text = '[@pino](https://foo.slack.com/team/U01FZCB8X29) ... [@pino](https://foo.slack.com/team/U0OTHERID1)';
    const map = extractSlackHandleIds(text);
    expect(map.get('pino')).toBe('slack:U01FZCB8X29');
  });

  it('lowercases the handle key', () => {
    const map = extractSlackHandleIds('[@Pino](https://foo.slack.com/team/U01FZCB8X29)');
    expect(map.has('pino')).toBe(true);
  });

  it('returns an empty map for text with no Slack links', () => {
    expect(extractSlackHandleIds('Just some plain text.').size).toBe(0);
  });
});

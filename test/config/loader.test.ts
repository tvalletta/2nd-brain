import { describe, it, expect } from 'vitest';
import { lifecycleConfigWarnings } from '../../src/config/loader.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('lifecycleConfigWarnings', () => {
  it('returns no warnings when staleDraftArchiveDays >= staleDraftReportDays (the default relationship)', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(lifecycleConfigWarnings(config)).toEqual([]);
  });

  it('warns when staleDraftArchiveDays < staleDraftReportDays', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { lifecycle: { staleDraftArchiveDays: 5, staleDraftReportDays: 14 } },
    });
    const warnings = lifecycleConfigWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('staleDraftArchiveDays');
    expect(warnings[0]).toContain('staleDraftReportDays');
  });

  it('does not warn when the two thresholds are equal', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { lifecycle: { staleDraftArchiveDays: 14, staleDraftReportDays: 14 } },
    });
    expect(lifecycleConfigWarnings(config)).toEqual([]);
  });
});

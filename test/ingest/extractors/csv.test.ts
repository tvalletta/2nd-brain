import { describe, it, expect } from 'vitest';
import { extractCsv } from '../../../src/ingest/extractors/csv.js';

describe('extractCsv', () => {
  it('extracts headers and row count', () => {
    const content = 'name,age,role\nAlice,30,engineer\nBob,25,designer';
    const result = extractCsv(content);
    expect(result).toContain('**CSV**');
    expect(result).toContain('3 columns');
    expect(result).toContain('2 data rows');
    expect(result).toContain('- name');
    expect(result).toContain('- age');
    expect(result).toContain('- role');
  });

  it('shows sample rows', () => {
    const rows = ['id,value', ...Array.from({ length: 10 }, (_, i) => `${i},val-${i}`)];
    const content = rows.join('\n');
    const result = extractCsv(content);
    expect(result).toContain('Sample Rows (first 5)');
    expect(result).toContain('0,val-0');
    expect(result).toContain('4,val-4');
    expect(result).not.toContain('5,val-5');
  });

  it('handles empty CSV', () => {
    const result = extractCsv('');
    expect(result).toBe('');
  });
});

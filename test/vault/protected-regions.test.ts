import { describe, it, expect } from 'vitest';
import {
  extractProtectedRegions,
  getProtectedRegion,
  updateProtectedRegion,
  hasProtectedRegion,
  OPEN_TAG,
  CLOSE_TAG,
  REGION_BLOCK,
  PINNED_MARKER,
} from '../../src/vault/protected-regions.js';

const SAMPLE_DOC = `# Test Document

## Section A
%% begin:section-a %%
Content of section A.
%% end:section-a %%

## Section B
%% begin:section-b %%
Line 1 of B.
Line 2 of B.
%% end:section-b %%

## Unprotected
This is not protected.
`;

const LEGACY_DOC = `# Test Document

## Section A
<!-- PROTECTED:section-a -->
Content of section A.
<!-- /PROTECTED:section-a -->

## Section B
<!-- PROTECTED:section-b -->
Line 1 of B.
Line 2 of B.
<!-- /PROTECTED:section-b -->

## Unprotected
This is not protected.
`;

describe('extractProtectedRegions', () => {
  it('extracts all protected regions', () => {
    const regions = extractProtectedRegions(SAMPLE_DOC);
    expect(regions).toHaveLength(2);
    expect(regions[0].id).toBe('section-a');
    expect(regions[0].content).toBe('Content of section A.');
    expect(regions[1].id).toBe('section-b');
    expect(regions[1].content).toBe('Line 1 of B.\nLine 2 of B.');
  });

  it('returns empty array for no protected regions', () => {
    const regions = extractProtectedRegions('# No regions here');
    expect(regions).toEqual([]);
  });

  it('handles empty protected regions', () => {
    const doc = '%% begin:empty %%\n%% end:empty %%';
    const regions = extractProtectedRegions(doc);
    expect(regions).toHaveLength(1);
    expect(regions[0].content).toBe('');
  });

  it('parses legacy HTML comment format', () => {
    const regions = extractProtectedRegions(LEGACY_DOC);
    expect(regions).toHaveLength(2);
    expect(regions[0].id).toBe('section-a');
    expect(regions[0].content).toBe('Content of section A.');
    expect(regions[1].id).toBe('section-b');
    expect(regions[1].content).toBe('Line 1 of B.\nLine 2 of B.');
  });

  it('handles empty legacy regions', () => {
    const doc = '<!-- PROTECTED:empty -->\n<!-- /PROTECTED:empty -->';
    const regions = extractProtectedRegions(doc);
    expect(regions).toHaveLength(1);
    expect(regions[0].content).toBe('');
  });
});

describe('getProtectedRegion', () => {
  it('returns content for existing region', () => {
    expect(getProtectedRegion(SAMPLE_DOC, 'section-a')).toBe('Content of section A.');
  });

  it('returns null for nonexistent region', () => {
    expect(getProtectedRegion(SAMPLE_DOC, 'nonexistent')).toBeNull();
  });

  it('returns content from legacy format', () => {
    expect(getProtectedRegion(LEGACY_DOC, 'section-a')).toBe('Content of section A.');
  });
});

describe('updateProtectedRegion', () => {
  it('replaces content of existing region', () => {
    const updated = updateProtectedRegion(SAMPLE_DOC, 'section-a', 'New content.');
    expect(getProtectedRegion(updated, 'section-a')).toBe('New content.');
    // Other region should be unchanged
    expect(getProtectedRegion(updated, 'section-b')).toBe('Line 1 of B.\nLine 2 of B.');
  });

  it('appends region if it does not exist', () => {
    const updated = updateProtectedRegion(SAMPLE_DOC, 'new-region', 'Brand new.');
    expect(hasProtectedRegion(updated, 'new-region')).toBe(true);
    expect(getProtectedRegion(updated, 'new-region')).toBe('Brand new.');
  });

  it('preserves surrounding content', () => {
    const updated = updateProtectedRegion(SAMPLE_DOC, 'section-a', 'Replaced.');
    expect(updated).toContain('# Test Document');
    expect(updated).toContain('## Section A');
    expect(updated).toContain('## Section B');
    expect(updated).toContain('## Unprotected');
  });

  it('migrates legacy format to new format on update', () => {
    const updated = updateProtectedRegion(LEGACY_DOC, 'section-a', 'Migrated.');
    expect(updated).toContain('%% begin:section-a %%');
    expect(updated).toContain('%% end:section-a %%');
    expect(updated).not.toContain('<!-- PROTECTED:section-a -->');
    expect(updated).not.toContain('<!-- /PROTECTED:section-a -->');
    expect(getProtectedRegion(updated, 'section-a')).toBe('Migrated.');
    // Other legacy region should still be readable
    expect(getProtectedRegion(updated, 'section-b')).toBe('Line 1 of B.\nLine 2 of B.');
  });

  it('appended regions use new format', () => {
    const updated = updateProtectedRegion(LEGACY_DOC, 'new-region', 'New.');
    expect(updated).toContain('%% begin:new-region %%');
    expect(updated).toContain('%% end:new-region %%');
  });
});

describe('hasProtectedRegion', () => {
  it('returns true for existing region', () => {
    expect(hasProtectedRegion(SAMPLE_DOC, 'section-a')).toBe(true);
  });

  it('returns false for nonexistent region', () => {
    expect(hasProtectedRegion(SAMPLE_DOC, 'nope')).toBe(false);
  });

  it('returns true for legacy format region', () => {
    expect(hasProtectedRegion(LEGACY_DOC, 'section-a')).toBe(true);
  });
});

describe('exported helpers', () => {
  it('OPEN_TAG produces correct format', () => {
    expect(OPEN_TAG('backlinks')).toBe('%% begin:backlinks %%');
  });

  it('CLOSE_TAG produces correct format', () => {
    expect(CLOSE_TAG('backlinks')).toBe('%% end:backlinks %%');
  });

  it('REGION_BLOCK produces open+close pair', () => {
    expect(REGION_BLOCK('backlinks')).toBe('%% begin:backlinks %%\n%% end:backlinks %%');
  });

  it('PINNED_MARKER is correct', () => {
    expect(PINNED_MARKER).toBe('%% pinned %%');
  });
});

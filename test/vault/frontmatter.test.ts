import { describe, it, expect } from 'vitest';
import {
  parseNote,
  serializeNote,
  validateFrontmatter,
  BaseFrontmatterSchema,
  SourceSummarySchema,
  SessionSummarySchema,
  EntitySchema,
  ContradictionSchema,
  IndexFrontmatterSchema,
} from '../../src/vault/frontmatter.js';

describe('parseNote', () => {
  it('parses frontmatter and body from markdown', () => {
    const content = `---
id: test-1
type: entity
title: Test Entity
status: active
created_at: "2026-04-11T00:00:00.000Z"
updated_at: "2026-04-11T00:00:00.000Z"
---

# Test Entity

Some body content.
`;
    const { data, body } = parseNote(content);
    expect(data.id).toBe('test-1');
    expect(data.type).toBe('entity');
    expect(data.title).toBe('Test Entity');
    expect(body).toContain('# Test Entity');
    expect(body).toContain('Some body content.');
  });

  it('handles content with no frontmatter', () => {
    const content = '# Just a heading\n\nSome content.';
    const { data, body } = parseNote(content);
    expect(Object.keys(data)).toHaveLength(0);
    expect(body).toContain('# Just a heading');
  });

  it('handles empty content', () => {
    const { data, body } = parseNote('');
    expect(Object.keys(data)).toHaveLength(0);
    expect(body).toBe('');
  });
});

describe('serializeNote', () => {
  it('round-trips frontmatter and body', () => {
    const originalData = {
      id: 'round-trip-1',
      type: 'concept',
      title: 'Round Trip Test',
      status: 'active',
    };
    const originalBody = '\n# Round Trip Test\n\nBody here.\n';

    const serialized = serializeNote(originalData, originalBody);
    const { data, body } = parseNote(serialized);

    expect(data.id).toBe('round-trip-1');
    expect(data.type).toBe('concept');
    expect(data.title).toBe('Round Trip Test');
    expect(body).toContain('# Round Trip Test');
    expect(body).toContain('Body here.');
  });
});

describe('validateFrontmatter', () => {
  it('validates correct base frontmatter', () => {
    const result = validateFrontmatter({
      id: 'valid-1',
      type: 'entity',
      title: 'Valid Entity',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = validateFrontmatter({ id: 'no-type' });
    expect(result.success).toBe(false);
  });

  it('applies defaults for optional fields', () => {
    const result = BaseFrontmatterSchema.parse({
      id: 'defaults-1',
      type: 'concept',
      title: 'Defaults Test',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    });
    expect(result.status).toBe('draft');
    expect(result.review_state).toBe('unreviewed');
    expect(result.source_refs).toEqual([]);
    expect(result.aliases).toEqual([]);
    expect(result.change_origin).toBe('human');
  });
});

describe('type-specific schemas', () => {
  it('validates source_summary', () => {
    const result = SourceSummarySchema.safeParse({
      id: 'src-1',
      type: 'source_summary',
      title: 'Meeting Notes',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      source_type: 'transcript',
      source_path: 'raw/meeting.md',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ingest_status).toBe('detected');
    }
  });

  it('validates session_summary', () => {
    const result = SessionSummarySchema.safeParse({
      id: 'sess-1',
      type: 'session_summary',
      title: 'Session 2026-04-11',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      session_id: 'abc-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files_changed).toEqual([]);
    }
  });

  it('validates entity', () => {
    const result = EntitySchema.safeParse({
      id: 'ent-1',
      type: 'entity',
      title: 'Alice',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      entity_kind: 'person',
      canonical_name: 'Alice Smith',
    });
    expect(result.success).toBe(true);
  });

  it('validates contradiction', () => {
    const result = ContradictionSchema.safeParse({
      id: 'contra-1',
      type: 'contradiction',
      title: 'Deadline conflict',
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      conflict_type: 'direct_factual',
      claim_a: 'Deadline is March 1',
      claim_b: 'Deadline is April 1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolution_state).toBe('open');
    }
  });

  it('validates index with optional fields', () => {
    const result = IndexFrontmatterSchema.safeParse({
      id: 'idx-1',
      type: 'index',
      title: 'Wiki Index',
      created_at: '2026-04-14T00:00:00.000Z',
      updated_at: '2026-04-14T00:00:00.000Z',
      index_category: 'wiki',
      entry_count: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.index_category).toBe('wiki');
      expect(result.data.entry_count).toBe(42);
    }
  });

  it('validates index without optional fields', () => {
    const result = IndexFrontmatterSchema.safeParse({
      id: 'idx-2',
      type: 'index',
      title: 'Minimal Index',
      created_at: '2026-04-14T00:00:00.000Z',
      updated_at: '2026-04-14T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects index with wrong type literal', () => {
    const result = IndexFrontmatterSchema.safeParse({
      id: 'idx-3',
      type: 'entity',
      title: 'Not an index',
      created_at: '2026-04-14T00:00:00.000Z',
      updated_at: '2026-04-14T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

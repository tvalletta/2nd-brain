import { describe, it, expect } from 'vitest';
import { chunkDocument, type Chunk } from '../../src/ingest/chunker.js';

const HASH = 'abc123def456';

describe('chunkDocument', () => {
  describe('single chunk (small files)', () => {
    it('returns a single chunk for short markdown', () => {
      const content = '# Hello\n\nSome text here.';
      const result = chunkDocument(content, 'markdown', HASH);

      expect(result.strategy).toBe('single');
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content).toBe(content);
      expect(result.chunks[0].index).toBe(0);
      expect(result.chunks[0].totalChunks).toBe(1);
      expect(result.chunks[0].charOffset).toBe(0);
      expect(result.chunks[0].charLength).toBe(content.length);
    });

    it('returns a single chunk for empty content', () => {
      const result = chunkDocument('', 'markdown', HASH);
      expect(result.strategy).toBe('single');
      expect(result.chunks).toHaveLength(1);
    });

    it('returns a single chunk for csv regardless of size', () => {
      const bigCsv = 'a,b,c\n'.repeat(5000);
      const result = chunkDocument(bigCsv, 'csv', HASH);
      expect(result.strategy).toBe('single');
      expect(result.chunks).toHaveLength(1);
    });

    it('returns a single chunk for json regardless of size', () => {
      const bigJson = JSON.stringify({ data: 'x'.repeat(20000) });
      const result = chunkDocument(bigJson, 'json', HASH);
      expect(result.strategy).toBe('single');
      expect(result.chunks).toHaveLength(1);
    });

    it('returns a single chunk for code regardless of size', () => {
      const bigCode = 'function foo() {}\n'.repeat(2000);
      const result = chunkDocument(bigCode, 'code', HASH);
      expect(result.strategy).toBe('single');
      expect(result.chunks).toHaveLength(1);
    });
  });

  describe('deterministic chunk IDs', () => {
    it('produces the same chunk IDs for the same input', () => {
      const content = '## Section A\n\nText A.\n\n## Section B\n\nText B.';
      const r1 = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 20 });
      const r2 = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 20 });

      expect(r1.chunks.map((c) => c.chunkId)).toEqual(r2.chunks.map((c) => c.chunkId));
    });

    it('produces different chunk IDs for different source hashes', () => {
      const content = '## Section A\n\nText A.\n\n## Section B\n\nText B.';
      const r1 = chunkDocument(content, 'markdown', 'hash1', { maxChunkSize: 20 });
      const r2 = chunkDocument(content, 'markdown', 'hash2', { maxChunkSize: 20 });

      expect(r1.chunks[0].chunkId).not.toBe(r2.chunks[0].chunkId);
    });

    it('produces unique IDs within the same document', () => {
      const sections = Array.from({ length: 5 }, (_, i) => `## Section ${i}\n\n${'x'.repeat(100)}`);
      const content = sections.join('\n\n');
      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 150 });

      const ids = result.chunks.map((c) => c.chunkId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('markdown section splitting', () => {
    it('splits on ## headings', () => {
      const content = [
        '## Introduction',
        '',
        'Intro text here.',
        '',
        '## Architecture',
        '',
        'Architecture text here.',
        '',
        '## Conclusion',
        '',
        'Conclusion text.',
      ].join('\n');

      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 50 });

      expect(result.strategy).toBe('markdown-sections');
      expect(result.chunks.length).toBe(3);
      expect(result.chunks[0].content).toContain('Introduction');
      expect(result.chunks[1].content).toContain('Architecture');
      expect(result.chunks[2].content).toContain('Conclusion');
    });

    it('includes heading context for each chunk', () => {
      const content = [
        '## Introduction',
        '',
        'Intro.',
        '',
        '## Architecture',
        '',
        'Arch.',
      ].join('\n');

      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 30 });

      expect(result.chunks[0].headingContext).toBe('Introduction');
      expect(result.chunks[1].headingContext).toBe('Architecture');
    });

    it('splits large sections on ### sub-headings', () => {
      const longContent = 'x'.repeat(200);
      const content = [
        '## Big Section',
        '',
        `### Part A`,
        '',
        longContent,
        '',
        '### Part B',
        '',
        longContent,
      ].join('\n');

      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 300 });

      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      // Heading context should show hierarchy
      const contexts = result.chunks.map((c) => c.headingContext);
      expect(contexts.some((c) => c.includes('Part A'))).toBe(true);
      expect(contexts.some((c) => c.includes('Part B'))).toBe(true);
    });

    it('falls back to paragraph splitting for huge sections without sub-headings', () => {
      const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(100)}`);
      const content = `## Huge Section\n\n${paragraphs.join('\n\n')}`;

      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 500 });

      expect(result.chunks.length).toBeGreaterThan(1);
      // All content should be present across chunks
      const allText = result.chunks.map((c) => c.content).join('');
      for (let i = 0; i < 10; i++) {
        expect(allText).toContain(`Paragraph ${i}`);
      }
    });

    it('preserves content fidelity — no bytes lost', () => {
      const sections = Array.from({ length: 4 }, (_, i) =>
        `## Section ${i}\n\nContent for section ${i} with details.`,
      );
      const content = sections.join('\n\n');

      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 60 });

      // Every section's content must appear in some chunk
      for (let i = 0; i < 4; i++) {
        const found = result.chunks.some((c) => c.content.includes(`Content for section ${i}`));
        expect(found).toBe(true);
      }
    });
  });

  describe('plaintext window splitting', () => {
    it('splits large plaintext into overlapping windows', () => {
      const content = 'x'.repeat(3000);
      const result = chunkDocument(content, 'plaintext', HASH, {
        maxChunkSize: 1000,
        overlap: 200,
      });

      expect(result.strategy).toBe('plaintext-window');
      expect(result.chunks.length).toBeGreaterThan(1);

      // Each chunk should be at most maxChunkSize
      for (const chunk of result.chunks) {
        expect(chunk.charLength).toBeLessThanOrEqual(1000);
      }
    });

    it('prefers paragraph boundaries for splitting', () => {
      const para1 = 'First paragraph. '.repeat(30);
      const para2 = 'Second paragraph. '.repeat(30);
      const para3 = 'Third paragraph. '.repeat(30);
      const content = `${para1}\n\n${para2}\n\n${para3}`;

      const result = chunkDocument(content, 'plaintext', HASH, {
        maxChunkSize: 600,
        overlap: 100,
      });

      expect(result.strategy).toBe('plaintext-window');
      expect(result.chunks.length).toBeGreaterThan(1);
    });

    it('does not split small plaintext', () => {
      const content = 'Short text.';
      const result = chunkDocument(content, 'plaintext', HASH);

      expect(result.strategy).toBe('single');
      expect(result.chunks).toHaveLength(1);
    });

    it('tracks charOffset for each window', () => {
      const content = 'x'.repeat(5000);
      const result = chunkDocument(content, 'plaintext', HASH, {
        maxChunkSize: 2000,
        overlap: 500,
      });

      // First chunk starts at 0
      expect(result.chunks[0].charOffset).toBe(0);

      // Subsequent chunks have increasing offsets
      for (let i = 1; i < result.chunks.length; i++) {
        expect(result.chunks[i].charOffset).toBeGreaterThan(result.chunks[i - 1].charOffset);
      }
    });

    it('covers the entire document with overlapping windows', () => {
      const content = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n');
      const result = chunkDocument(content, 'plaintext', HASH, {
        maxChunkSize: 200,
        overlap: 50,
      });

      // The last chunk should cover the end of the document
      const lastChunk = result.chunks[result.chunks.length - 1];
      expect(lastChunk.charOffset + lastChunk.charLength).toBeGreaterThanOrEqual(content.length - 1);
    });
  });

  describe('chunk metadata', () => {
    it('tracks sourceHash on every chunk', () => {
      const content = '## A\n\nText.\n\n## B\n\nMore.';
      const result = chunkDocument(content, 'markdown', 'myhash123', { maxChunkSize: 20 });

      for (const chunk of result.chunks) {
        expect(chunk.sourceHash).toBe('myhash123');
      }
    });

    it('sets totalChunks correctly', () => {
      const content = '## A\n\nText.\n\n## B\n\nMore.\n\n## C\n\nEnd.';
      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 20 });

      for (const chunk of result.chunks) {
        expect(chunk.totalChunks).toBe(result.chunks.length);
      }
    });

    it('indexes chunks sequentially from 0', () => {
      const content = '## A\n\nText.\n\n## B\n\nMore.\n\n## C\n\nEnd.';
      const result = chunkDocument(content, 'markdown', HASH, { maxChunkSize: 20 });

      result.chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });
  });
});

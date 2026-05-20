import { createHash } from 'node:crypto';
import type { SourceType } from './classifier.js';

export interface Chunk {
  chunkId: string;
  sourceHash: string;
  index: number;
  totalChunks: number;
  content: string;
  headingContext: string;
  charOffset: number;
  charLength: number;
}

export interface ChunkResult {
  chunks: Chunk[];
  strategy: 'markdown-sections' | 'plaintext-window' | 'single';
  sourceHash: string;
}

const DEFAULT_MAX_CHUNK_SIZE = 12000;
const DEFAULT_OVERLAP = 1000;

export interface ChunkOptions {
  maxChunkSize?: number;
  overlap?: number;
}

export function chunkDocument(
  content: string,
  sourceType: SourceType,
  sourceHash: string,
  options?: ChunkOptions,
): ChunkResult {
  const maxSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;

  if (!content.trim()) {
    return {
      chunks: [makeChunk(content, sourceHash, 0, 1, '', 0)],
      strategy: 'single',
      sourceHash,
    };
  }

  if (sourceType === 'markdown') {
    const sections = splitMarkdownSections(content, maxSize);
    if (sections.length <= 1) {
      return {
        chunks: [makeChunk(content, sourceHash, 0, 1, '', 0)],
        strategy: 'single',
        sourceHash,
      };
    }
    const chunks = sections.map((s, i) =>
      makeChunk(s.content, sourceHash, i, sections.length, s.headingContext, s.charOffset),
    );
    return { chunks, strategy: 'markdown-sections', sourceHash };
  }

  if (sourceType === 'plaintext') {
    if (content.length <= maxSize) {
      return {
        chunks: [makeChunk(content, sourceHash, 0, 1, '', 0)],
        strategy: 'single',
        sourceHash,
      };
    }
    const windows = splitPlaintextWindows(content, maxSize, overlap);
    const chunks = windows.map((w, i) =>
      makeChunk(w.content, sourceHash, i, windows.length, '', w.charOffset),
    );
    return { chunks, strategy: 'plaintext-window', sourceHash };
  }

  // csv, json, code, pdf, unknown — single chunk
  return {
    chunks: [makeChunk(content, sourceHash, 0, 1, '', 0)],
    strategy: 'single',
    sourceHash,
  };
}

function makeChunk(
  content: string,
  sourceHash: string,
  index: number,
  totalChunks: number,
  headingContext: string,
  charOffset: number,
): Chunk {
  const chunkId = createHash('sha256')
    .update(`${sourceHash}:${index}`)
    .digest('hex')
    .slice(0, 12);

  return {
    chunkId,
    sourceHash,
    index,
    totalChunks,
    content,
    headingContext,
    charOffset,
    charLength: content.length,
  };
}

// --- Markdown section splitting ---

interface MarkdownSection {
  content: string;
  headingContext: string;
  charOffset: number;
}

function splitMarkdownSections(content: string, maxSize: number): MarkdownSection[] {
  // Split on ## headings first
  const h2Sections = splitOnHeadingLevel(content, 2);

  const result: MarkdownSection[] = [];

  for (const section of h2Sections) {
    if (section.content.length <= maxSize) {
      result.push(section);
      continue;
    }

    // Section too large — try splitting on ### headings within it
    const h3Sections = splitOnHeadingLevel(section.content, 3, section.headingContext, section.charOffset);

    for (const sub of h3Sections) {
      if (sub.content.length <= maxSize) {
        result.push(sub);
        continue;
      }

      // Still too large — split on paragraph breaks
      const paragraphSections = splitOnParagraphs(sub.content, maxSize, sub.headingContext, sub.charOffset);
      result.push(...paragraphSections);
    }
  }

  return result;
}

function splitOnHeadingLevel(
  content: string,
  level: number,
  parentContext: string = '',
  baseOffset: number = 0,
): MarkdownSection[] {
  const prefix = '#'.repeat(level) + ' ';
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];

  let currentLines: string[] = [];
  let currentHeading = '';
  let currentOffset = baseOffset;

  for (const line of lines) {
    if (line.startsWith(prefix) && !line.startsWith(prefix + '#')) {
      // Found a heading at the target level — flush previous section
      if (currentLines.length > 0) {
        const sectionContent = currentLines.join('\n');
        const context = buildHeadingContext(parentContext, currentHeading);
        sections.push({
          content: sectionContent,
          headingContext: context,
          charOffset: currentOffset,
        });
        currentOffset += sectionContent.length + 1; // +1 for the \n between sections
      }
      currentHeading = line.replace(/^#+\s*/, '').trim();
      currentLines = [line];
    } else {
      if (sections.length === 0 && currentLines.length === 0 && !line.trim()) {
        // Skip leading blank lines before first heading
        currentOffset += line.length + 1;
        continue;
      }
      currentLines.push(line);
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    const sectionContent = currentLines.join('\n');
    const context = buildHeadingContext(parentContext, currentHeading);
    sections.push({
      content: sectionContent,
      headingContext: context,
      charOffset: currentOffset,
    });
  }

  // If no headings found at this level, return content as a single section
  if (sections.length <= 1 && sections[0]?.content === content) {
    return [{
      content,
      headingContext: parentContext,
      charOffset: baseOffset,
    }];
  }

  return sections;
}

function splitOnParagraphs(
  content: string,
  maxSize: number,
  headingContext: string,
  baseOffset: number,
): MarkdownSection[] {
  const paragraphs = content.split(/\n\n+/);
  const sections: MarkdownSection[] = [];
  let current = '';
  let currentOffset = baseOffset;

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxSize && current) {
      sections.push({
        content: current,
        headingContext,
        charOffset: currentOffset,
      });
      currentOffset += current.length + 2; // +2 for \n\n
      current = para;
    } else {
      current = candidate;
    }
  }

  if (current) {
    sections.push({
      content: current,
      headingContext,
      charOffset: currentOffset,
    });
  }

  return sections;
}

function buildHeadingContext(parent: string, heading: string): string {
  if (!heading) return parent;
  if (!parent) return heading;
  return `${parent} > ${heading}`;
}

// --- Plaintext window splitting ---

interface PlaintextWindow {
  content: string;
  charOffset: number;
}

function splitPlaintextWindows(
  content: string,
  windowSize: number,
  overlap: number,
): PlaintextWindow[] {
  const windows: PlaintextWindow[] = [];
  let offset = 0;

  while (offset < content.length) {
    let end = Math.min(offset + windowSize, content.length);

    // Try to break at a paragraph boundary
    if (end < content.length) {
      const breakPoint = findParagraphBreak(content, end, overlap);
      if (breakPoint > offset) {
        end = breakPoint;
      }
    }

    windows.push({
      content: content.slice(offset, end),
      charOffset: offset,
    });

    if (end >= content.length) break;

    // Advance by (end - overlap), but ensure forward progress
    const advance = Math.max(end - overlap, offset + 1);
    offset = advance;
  }

  return windows;
}

function findParagraphBreak(content: string, nearPosition: number, searchRange: number): number {
  // Look backward from nearPosition for a double-newline
  const searchStart = Math.max(nearPosition - searchRange, 0);
  const region = content.slice(searchStart, nearPosition);

  const lastBreak = region.lastIndexOf('\n\n');
  if (lastBreak !== -1) {
    return searchStart + lastBreak + 2; // after the \n\n
  }

  // Fall back to single newline
  const lastNewline = region.lastIndexOf('\n');
  if (lastNewline !== -1) {
    return searchStart + lastNewline + 1;
  }

  return nearPosition;
}

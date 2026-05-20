import { describe, it, expect } from 'vitest';
import { classifyFile } from '../../src/ingest/classifier.js';

describe('classifyFile', () => {
  it('classifies markdown files', () => {
    expect(classifyFile('notes.md')).toBe('markdown');
  });

  it('classifies plaintext files', () => {
    expect(classifyFile('readme.txt')).toBe('plaintext');
    expect(classifyFile('config.yaml')).toBe('plaintext');
  });

  it('classifies CSV files', () => {
    expect(classifyFile('data.csv')).toBe('csv');
    expect(classifyFile('data.tsv')).toBe('csv');
  });

  it('classifies JSON files', () => {
    expect(classifyFile('config.json')).toBe('json');
    expect(classifyFile('events.jsonl')).toBe('json');
  });

  it('classifies code files', () => {
    expect(classifyFile('app.ts')).toBe('code');
    expect(classifyFile('main.py')).toBe('code');
    expect(classifyFile('lib.rs')).toBe('code');
  });

  it('returns unknown for unrecognized extensions', () => {
    expect(classifyFile('image.png')).toBe('unknown');
    expect(classifyFile('binary.dat')).toBe('unknown');
  });
});

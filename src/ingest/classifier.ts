import { extname } from 'node:path';

export type SourceType =
  | 'markdown'
  | 'plaintext'
  | 'csv'
  | 'json'
  | 'pdf'
  | 'code'
  | 'unknown';

const EXT_MAP: Record<string, SourceType> = {
  '.md': 'markdown',
  '.txt': 'plaintext',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.json': 'json',
  '.jsonl': 'json',
  '.pdf': 'pdf',
  '.ts': 'code',
  '.js': 'code',
  '.py': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.yaml': 'plaintext',
  '.yml': 'plaintext',
  '.xml': 'plaintext',
  '.html': 'plaintext',
  '.log': 'plaintext',
};

export function classifyFile(filePath: string): SourceType {
  const ext = extname(filePath).toLowerCase();
  return EXT_MAP[ext] ?? 'unknown';
}

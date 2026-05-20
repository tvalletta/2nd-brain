import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { classifyFile } from './classifier.js';
import { extractMarkdownText } from './extractors/markdown.js';
import { extractPlaintext } from './extractors/plaintext.js';
import { serializeNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { slugify, resolveAvailablePath, DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('scanner');

// Extensions we can meaningfully ingest as text
const INGESTABLE_EXTS = new Set([
  '.md', '.txt', '.csv', '.tsv', '.json', '.jsonl',
  '.ts', '.js', '.py', '.go', '.rs', '.java',
  '.yaml', '.yml', '.xml', '.html', '.log',
]);

export interface ScanResult {
  scanned: number;
  ingested: number;
  skipped: number;
  errors: number;
}

/**
 * Ingest a file that already lives inside the vault's raw/ directory.
 * Skips the copy step — only creates a source summary if one doesn't exist.
 */
async function ingestExistingRawFile(
  rawPath: string,
  vault: VaultAdapter,
  existingHashes: Set<string>,
  existingSummaryPaths: Set<string>,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<boolean> {
  const fileName = basename(rawPath);
  const ext = '.' + fileName.split('.').pop()?.toLowerCase();
  if (!INGESTABLE_EXTS.has(ext)) return false;

  const sourceType = classifyFile(fileName);
  if (sourceType === 'unknown') return false;

  let content: string;
  try {
    content = await vault.read(rawPath);
  } catch {
    return false;
  }

  const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

  // Skip if we already have a summary for this hash
  if (existingHashes.has(sourceHash)) return false;

  const summaryDir = layout.sources;
  await vault.ensureFolder(summaryDir);

  const title = fileName.replace(/\.[^.]+$/, '');
  const slug = slugify(title);
  const summaryPath = resolveAvailablePath(summaryDir, `${slug}.md`, existingSummaryPaths);

  let extractedText: string;
  switch (sourceType) {
    case 'markdown':
      extractedText = extractMarkdownText(content);
      break;
    default:
      extractedText = extractPlaintext(content);
      break;
  }

  const frontmatter = {
    id: nanoid(),
    type: 'source_summary',
    title,
    status: 'draft',
    confidence: 'low',
    review_state: 'unreviewed',
    created_at: nowISO(),
    updated_at: nowISO(),
    source_type: sourceType,
    source_path: rawPath,
    ingest_status: 'detected',
    source_hash: sourceHash,
    source_refs: [rawPath],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'extraction',
    protected_regions: ['summary', 'entities', 'backlinks'],
  };

  const body = `
# ${title}

**Source:** \`${rawPath}\`
**Type:** ${sourceType}
**Hash:** ${sourceHash}

## Original Content (excerpt)

${extractedText.slice(0, 2000)}${extractedText.length > 2000 ? '\n\n*[truncated]*' : ''}

## Summary
${OPEN_TAG('summary')}
Pending extraction.
${CLOSE_TAG('summary')}

## Extracted Entities
${OPEN_TAG('entities')}
No entities extracted yet.
${CLOSE_TAG('entities')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

  const noteContent = serializeNote(frontmatter, body);
  await vault.create(summaryPath, noteContent);

  // Track the new path so we don't collide on subsequent files with same slug
  existingSummaryPaths.add(summaryPath);
  existingHashes.add(sourceHash);

  return true;
}

/**
 * Scan all files in raw/ and create source summaries for any that don't have one yet.
 */
export async function scanRawDirectory(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };

  // Collect existing source summaries and their hashes
  const existingHashes = new Set<string>();
  const existingSummaryPaths = new Set<string>();
  try {
    const summaryFiles = await vault.listMarkdownFiles(layout.sources);
    for (const file of summaryFiles) {
      existingSummaryPaths.add(file);
      try {
        const content = await vault.read(file);
        const hashMatch = content.match(/source_hash:\s*["']?([a-f0-9]+)["']?/);
        if (hashMatch) existingHashes.add(hashMatch[1]);
      } catch {
        // Skip unreadable summaries
      }
    }
  } catch {
    // No existing summaries — that's fine
  }

  log.info('Starting raw directory scan', { existingSummaries: existingSummaryPaths.size, existingHashes: existingHashes.size });

  // List all files in raw/ recursively
  let rawFiles: string[];
  try {
    rawFiles = await vault.listFiles('raw');
  } catch {
    log.warn('No raw directory found');
    return result;
  }

  for (const rawPath of rawFiles) {
    result.scanned++;
    try {
      const ingested = await ingestExistingRawFile(rawPath, vault, existingHashes, existingSummaryPaths, layout);
      if (ingested) {
        result.ingested++;
        if (result.ingested % 25 === 0) {
          log.info('Scan progress', { scanned: result.scanned, ingested: result.ingested });
        }
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.errors++;
      log.error('Failed to ingest raw file', { rawPath, error: (err as Error).message });
    }
  }

  log.info('Raw directory scan complete', { ...result });
  return result;
}

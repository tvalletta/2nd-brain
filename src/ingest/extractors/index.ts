import type { ContentCategory } from '../content-router.js';
import type { SourceType } from '../classifier.js';
import { extractMarkdownText } from './markdown.js';
import { extractPlaintext } from './plaintext.js';
import { extractJson } from './json.js';
import { extractCsv } from './csv.js';
import { extractCode } from './code.js';

/**
 * Select extraction strategy based on content category (from routing) and
 * source type (from extension-based classification). Category takes precedence
 * for types that have dedicated extractors.
 */
export function extractText(
  category: ContentCategory,
  sourceType: SourceType,
  content: string,
): string {
  switch (category) {
    case 'data':
      return sourceType === 'csv' ? extractCsv(content) : extractJson(content);
    case 'code-artifact':
      return extractCode(content);
    default:
      return sourceType === 'markdown'
        ? extractMarkdownText(content)
        : extractPlaintext(content);
  }
}

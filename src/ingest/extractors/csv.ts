export function extractCsv(content: string, maxSampleRows = 5): string {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return content;

  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const dataRows = lines.slice(1);
  const sampleCount = Math.min(maxSampleRows, dataRows.length);

  const parts: string[] = [
    `**CSV** (${headers.length} columns, ${dataRows.length} data rows)`,
    '',
    '### Headers',
    headers.map((h) => `- ${h}`).join('\n'),
    '',
    `### Sample Rows (first ${sampleCount})`,
    '```',
    headerLine,
    ...dataRows.slice(0, maxSampleRows),
    '```',
  ];

  return parts.join('\n');
}

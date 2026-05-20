export function extractJson(content: string, maxLength = 8000): string {
  try {
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      const sample = JSON.stringify(parsed.slice(0, 3), null, 2);
      return `**JSON Array** (${parsed.length} items)\n\n### Sample (first 3)\n\`\`\`json\n${sample.slice(0, maxLength)}\n\`\`\``;
    }

    if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      const preview: Record<string, unknown> = {};
      for (const key of keys.slice(0, 20)) {
        const val = parsed[key];
        preview[key] =
          typeof val === 'string' && val.length > 200
            ? val.slice(0, 200) + '...'
            : val;
      }
      const previewStr = JSON.stringify(preview, null, 2);
      const keyList = keys.slice(0, 10).join(', ') + (keys.length > 10 ? ', ...' : '');
      return `**JSON Object** (${keys.length} keys: ${keyList})\n\n\`\`\`json\n${previewStr.slice(0, maxLength)}\n\`\`\``;
    }

    return `**JSON Primitive:** ${String(parsed).slice(0, 500)}`;
  } catch {
    return content.slice(0, maxLength);
  }
}

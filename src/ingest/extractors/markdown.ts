export function extractMarkdownText(content: string): string {
  // Strip frontmatter
  let text = content;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---\n', 3);
    if (end !== -1) {
      text = text.slice(end + 5);
    }
  }
  return text.trim();
}

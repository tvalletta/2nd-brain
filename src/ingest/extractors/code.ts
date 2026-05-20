export function extractCode(content: string, maxLength = 8000): string {
  const signatures: string[] = [];

  const patterns = [
    // Function/method signatures (JS/TS/Go/Rust/Python/Java)
    /^(?:export\s+)?(?:async\s+)?(?:function|def|fn|func)\s+\w+[^{;]*/gm,
    // Class declarations
    /^(?:export\s+)?(?:abstract\s+)?class\s+\w+[^{]*/gm,
    // Interface/type declarations (TS)
    /^(?:export\s+)?(?:interface|type)\s+\w+[^{;]*/gm,
    // Export statements
    /^export\s+(?:default\s+)?(?:const|let|var|enum)\s+\w+/gm,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      signatures.push(match[0].trim());
    }
  }

  if (signatures.length === 0) {
    return content.slice(0, maxLength);
  }

  const parts: string[] = [
    `**Code** (${signatures.length} exported symbols)`,
    '',
    '### Signatures',
    '```',
    ...signatures.slice(0, 50),
    '```',
  ];

  return parts.join('\n');
}

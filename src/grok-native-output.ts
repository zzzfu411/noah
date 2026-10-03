const CHUNK_LENGTH = 512;

/** Keep both code points and JSON escapes intact on short terminal lines. */
function contentChunks(content: string): string[] {
  const chunks: string[] = [];
  let chunk = '', escapedLength = 0;
  for (const character of content) {
    const escaped = JSON.stringify(character).length - 2;
    if (chunk.length + character.length > CHUNK_LENGTH || escapedLength + escaped > CHUNK_LENGTH) {
      chunks.push(chunk); chunk = ''; escapedLength = 0;
    }
    chunk += character; escapedLength += escaped;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function chunkBody(value: Record<string, unknown>): Record<string, unknown> {
  const { content, ...metadata } = value;
  if (typeof content !== 'string') return value;
  return { ...metadata, contentEncoding: 'concat', contentChunks: contentChunks(content) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The exact CLI wire text, also used to reserve the corresponding input bytes. */
export function formatGrokNativeOutput(value: unknown, toolName?: string): string {
  let output = value;
  if (isRecord(value)) {
    if (toolName === 'noah_read' && isRecord(value.message)) output = { ...value, message: chunkBody(value.message) };
    else if (toolName === 'noah_material') output = chunkBody(value);
  }
  return JSON.stringify(output, null, 2) + '\n';
}

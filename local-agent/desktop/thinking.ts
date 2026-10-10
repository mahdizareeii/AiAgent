/** Displayed local-model thoughts are bounded separately from the final answer. */
export const MAX_THINKING_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function prefixWithinBytes(text: string, limit: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  // Do not leave a partial UTF-8 character at the display/storage boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/** Retain the beginning of the supplied thoughts; never manufacture a summary. */
export function appendThinking(current: string, chunk: string): string {
  const retained = prefixWithinBytes(current, MAX_THINKING_BYTES);
  const remaining = MAX_THINKING_BYTES - encoder.encode(retained).length;
  return remaining > 0 ? retained + prefixWithinBytes(chunk, remaining) : retained;
}

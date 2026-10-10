/** Shared by the native host and renderer; a workspace name is one portable path component. */
export function workspaceNameError(name: string): string | undefined {
  if (!name || !name.trim()) return 'Enter a folder name.';
  if (name === '.' || name === '..') return 'Use a specific folder name.';
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return 'Folder names cannot contain control characters.';
  if (/[\\/<>:"|?*]/.test(name)) return 'Use a folder name without path separators or <>:"|?*.';
  if (/[.\s]$/.test(name)) return 'Folder names cannot end with a dot or space.';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/i.test(name)) {
    return 'That folder name is reserved by Windows. Choose another name.';
  }
  if (new TextEncoder().encode(name).byteLength > 255) return 'Use a shorter folder name (up to 255 UTF-8 bytes).';
  return undefined;
}

export const TEXT_SCALE_KEY = 'free-local-agent-text-scale';
export const TEXT_SCALE_MIN = 90;
export const TEXT_SCALE_MAX = 125;

/** Only text is scaled; workspace geometry and action hit targets stay stable. */
export function normalizeTextScale(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(number))) : 100;
}

export function readTextScale(storage: Pick<Storage, 'getItem'>): number {
  try { return normalizeTextScale(storage.getItem(TEXT_SCALE_KEY)); }
  catch { return 100; }
}

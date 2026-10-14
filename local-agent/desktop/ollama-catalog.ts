/** Metadata-only adapter for the public Ollama library.
 *
 * This module deliberately never starts an Ollama daemon or sends prompts to
 * a provider. It is only a bounded, permission-gated discovery request used
 * to help a user decide which GGUF to import into Free Local Agent.
 */
export interface OllamaCatalogModel {
  name: string;
  description: string;
  parameterSize?: string;
  contextLength?: number;
  quantization?: string;
  family?: string;
  updatedAt?: string;
  sizeBytes?: number;
  digest?: string;
  sourceUrl: string;
  compatibility: 'metadata-only' | 'compatible-gguf-unknown';
}

const ENDPOINT = 'https://ollama.com/api/tags';
const MAX_BODY_BYTES = 1_000_000;
const MAX_RESULTS = 30;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; rows: OllamaCatalogModel[] }>();

function text(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function modelName(raw: Record<string, unknown>): string | undefined {
  return text(raw.name) ?? text(raw.model);
}

export function normalizeOllamaModel(raw: unknown): OllamaCatalogModel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const name = modelName(row);
  if (!name) return null;
  const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details as Record<string, unknown> : {};
  const parameterSize = text(details.parameter_size) ?? text(row.parameter_size);
  const quantization = text(details.quantization_level) ?? text(row.quantization);
  const family = text(details.family) ?? text(row.family);
  const digest = text(row.digest, 128);
  return { name, description: text(row.description, 1000) ?? `${name} is listed in the public Ollama model library.`, parameterSize,
    contextLength: number(row.context_length) ?? number(details.context_length), quantization, family,
    updatedAt: text(row.modified_at) ?? text(row.updated_at), sizeBytes: number(row.size), digest,
    sourceUrl: `https://ollama.com/library/${encodeURIComponent(name.split(':')[0])}`, compatibility: 'metadata-only' };
}

function parsePayload(payload: unknown): OllamaCatalogModel[] {
  const rows = payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray((payload as { models?: unknown }).models)
    ? (payload as { models: unknown[] }).models : Array.isArray(payload) ? payload : [];
  const unique = new Map<string, OllamaCatalogModel>();
  for (const raw of rows) {
    const model = normalizeOllamaModel(raw);
    if (model && !unique.has(model.name.toLowerCase())) unique.set(model.name.toLowerCase(), model);
    if (unique.size >= MAX_RESULTS) break;
  }
  return [...unique.values()];
}

export function filterOllamaCatalog(models: readonly OllamaCatalogModel[], query: string): OllamaCatalogModel[] {
  const needle = query.trim().toLowerCase();
  return models.filter(model => !needle || `${model.name} ${model.description} ${model.family ?? ''}`.toLowerCase().includes(needle)).slice(0, MAX_RESULTS);
}

export async function searchOllamaCatalog(query: string, options: { enabled: boolean; fetcher?: typeof fetch; signal?: AbortSignal } ): Promise<OllamaCatalogModel[]> {
  if (!options.enabled) throw Object.assign(new Error('Enable Research and Allow web research in Plugins before searching the Ollama catalog.'), { code: 'RESEARCH_PERMISSION_REQUIRED' });
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rows.map(row => ({ ...row }));
  if (cached) cache.delete(key);
  const fetcher = options.fetcher ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(8_000);
  const response = await fetcher(ENDPOINT, { method: 'GET', headers: { accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`The Ollama catalog returned HTTP ${response.status}.`);
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new Error('The Ollama catalog response was too large.');
  const rows = filterOllamaCatalog(parsePayload(JSON.parse(body)), query);
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, rows });
  while (cache.size > 10) cache.delete(cache.keys().next().value!);
  return rows.map(row => ({ ...row }));
}


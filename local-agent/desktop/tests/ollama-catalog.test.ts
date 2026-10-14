import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOllamaCatalog, normalizeOllamaModel, searchOllamaCatalog } from '../ollama-catalog.ts';

test('normalizes public Ollama metadata without making it local validation', () => {
  const model = normalizeOllamaModel({ name: 'qwen2.5-coder:7b', size: 4_000, digest: 'sha256:abc', details: { family: 'qwen2', parameter_size: '7B', quantization_level: 'Q4_K_M' } });
  assert.equal(model?.name, 'qwen2.5-coder:7b');
  assert.equal(model?.parameterSize, '7B');
  assert.equal(model?.quantization, 'Q4_K_M');
  assert.equal(model?.compatibility, 'metadata-only');
});

test('filters and deduplicates catalog rows', async () => {
  const fetcher = async () => new Response(JSON.stringify({ models: [
    { name: 'llama3:8b', details: { family: 'llama', parameter_size: '8B' } },
    { name: 'qwen2.5-coder:7b', details: { family: 'qwen2', parameter_size: '7B' } },
    { name: 'qwen2.5-coder:7b', details: { family: 'qwen2', parameter_size: '7B' } },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const rows = await searchOllamaCatalog('qwen', { enabled: true, fetcher });
  assert.deepEqual(rows.map(row => row.name), ['qwen2.5-coder:7b']);
  assert.equal(filterOllamaCatalog(rows, 'missing').length, 0);
});

test('catalog search is blocked while Research/web permission is off', async () => {
  await assert.rejects(() => searchOllamaCatalog('qwen', { enabled: false }), /Enable Research/);
});


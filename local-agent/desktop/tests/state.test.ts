import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_UTILITIES, effectiveUtilities, emptyState, migrateState } from '../state.ts';

test('web research requires opt-in in Agent and Research and stays unavailable in Chat', () => {
  for (const mode of ['coding', 'research', 'assistant'] as const) {
    assert.equal(effectiveUtilities(mode, DEFAULT_UTILITIES).webResearch, false);
    assert.equal(effectiveUtilities(mode, { ...DEFAULT_UTILITIES, webResearch: true }).webResearch, mode !== 'assistant');
  }
  assert.equal(DEFAULT_UTILITIES.webResearch, false);
});

test('existing research consent and saved chat state survive the new Agent capability', () => {
  const existing = { ...emptyState(), selectedModel: 'qwen3.5:4b', mode: 'research' as const,
    utilities: { ...DEFAULT_UTILITIES, webResearch: true }, projectPath: '/project',
    sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Saved research', updatedAt: '2026-10-10T00:00:00Z',
      mode: 'research' as const, messages: [{ role: 'user' as const, content: 'Keep my sources' }], files: [{ name: 'notes.txt', path: '/project/notes.txt' }] }] };
  const migrated = migrateState(existing);
  assert.deepEqual(migrated, existing);
  assert.equal(effectiveUtilities('coding', migrated.utilities).webResearch, true);
  assert.equal(effectiveUtilities('assistant', migrated.utilities).webResearch, false);
});

test('research capability does not enable project mutations in read-only modes', () => {
  const optedIn = { ...DEFAULT_UTILITIES, webResearch: true };
  for (const mode of ['research', 'assistant'] as const) {
    const effective = effectiveUtilities(mode, optedIn);
    assert.equal(effective.fileEditing, false);
    assert.equal(effective.terminal, false);
    assert.equal(effective.projectSearch, false);
  }
});

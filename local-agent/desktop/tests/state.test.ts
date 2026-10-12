import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PLUGINS, DEFAULT_UTILITIES, effectiveUtilities, emptyState, migrateState, pluginSchema } from '../state.ts';
import { MAX_THINKING_BYTES } from '../thinking.ts';

test('v3 migration preserves existing task behavior and v4 retains outcomes and execution preferences', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Retained task', updatedAt: '2026-10-10T00:00:00Z', mode: 'coding', projectPath: '/project', files: [{ name: 'notes.txt', path: '/project/notes.txt' }], messages: [{ role: 'assistant', content: 'Readback retained.' }] };
  const migrated = migrateState({ version: 3, selectedModel: 'qwen3.5:4b', mode: 'coding', sessions: [session] });
  assert.deepEqual(migrated.sessions, [session]); assert.equal(migrated.sessions[0].taskEffort ?? 'standard', 'standard');
  assert.equal(migrated.defaultTaskEffort, 'careful'); assert.equal(migrated.memoryMode, 'automatic');
  const outcome = { status: 'timed-out', finishReason: 'active deadline', checks: [{ id: 'read:1', title: 'read_file', status: 'passed', detail: 'Literal 1: text\r\n', evidence: { operation: 'read_file', path: '/project/notes.txt', sha256: 'a'.repeat(64), complete: true } }] };
  const current = { ...migrated, memoryMode: 'low-memory', defaultTaskEffort: 'standard', sessions: [{ ...session, taskEffort: 'careful', messages: [{ role: 'assistant', content: 'Completed changes preserved.', outcome }] }] };
  assert.deepEqual(migrateState(current), current);
});

test('web research requires both the plugin and web permission and stays unavailable in Chat', () => {
  for (const mode of ['coding', 'research', 'assistant'] as const) {
    assert.equal(effectiveUtilities(mode, DEFAULT_UTILITIES).webResearch, false);
    assert.equal(effectiveUtilities(mode, DEFAULT_UTILITIES, { taskResearch: true }).webResearch, false);
    assert.equal(effectiveUtilities(mode, { ...DEFAULT_UTILITIES, webResearch: true }).webResearch, false);
    assert.equal(effectiveUtilities(mode, { ...DEFAULT_UTILITIES, webResearch: true }, { taskResearch: true }).webResearch, mode !== 'assistant');
  }
  assert.equal(DEFAULT_UTILITIES.webResearch, false);
  assert.deepEqual(emptyState().plugins, { taskResearch: false });
  assert.deepEqual(DEFAULT_PLUGINS, { taskResearch: false });
  assert.equal(emptyState().version, 4);
});

test('legacy explicit web consent migrates to the plugin while preserving model, project, chats and attachments', () => {
  const existing = { ...emptyState(), selectedModel: 'qwen3.5:4b', mode: 'research' as const,
    utilities: { ...DEFAULT_UTILITIES, webResearch: true }, projectPath: '/project',
    sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Saved research', updatedAt: '2026-10-10T00:00:00Z',
      mode: 'research' as const, messages: [{ role: 'user' as const, content: 'Keep my sources' }], files: [{ name: 'notes.txt', path: '/project/notes.txt' }] }] };
  const { plugins: _legacyMissingPlugins, ...legacy } = existing;
  for (const version of [undefined, 1, 2]) {
    const migrated = migrateState({ ...legacy, version });
    assert.deepEqual(migrated, { ...existing, plugins: { taskResearch: true } });
    assert.equal(effectiveUtilities('coding', migrated.utilities, migrated.plugins).webResearch, true);
    assert.equal(effectiveUtilities('assistant', migrated.utilities, migrated.plugins).webResearch, false);
  }
});

test('a current saved state with a missing plugin toggle defaults off even with retained web consent', () => {
  const { plugins: _missingPlugins, ...current } = emptyState();
  const migrated = migrateState({ ...current, utilities: { ...DEFAULT_UTILITIES, webResearch: true } });
  assert.deepEqual(migrated.plugins, { taskResearch: false });
  assert.equal(migrated.utilities.webResearch, true, 'Keep the separate web permission without inferring plugin activation.');
  assert.equal(effectiveUtilities('coding', migrated.utilities, migrated.plugins).webResearch, false);
});

test('saved explicit plugin choices survive migration without inheriting or removing web consent', () => {
  for (const taskResearch of [true, false]) {
    for (const webResearch of [true, false]) {
      const existing = { ...emptyState(), plugins: { taskResearch }, utilities: { ...DEFAULT_UTILITIES, webResearch } };
      const migrated = migrateState(existing);
      assert.deepEqual(migrated, existing);
      assert.equal(effectiveUtilities('coding', migrated.utilities, migrated.plugins).webResearch, taskResearch && webResearch);
    }
  }
});

test('missing legacy consent defaults plugin off and plugin IPC schema rejects unknown or nonboolean settings', () => {
  for (const version of [1, 2, 3]) {
    const { plugins: _missingPlugin, utilities: _missingUtilities, ...legacy } = emptyState();
    const migrated = migrateState({ ...legacy, version });
    assert.deepEqual(migrated.plugins, { taskResearch: false });
    assert.equal(migrated.utilities.webResearch, false);
  }
  assert.deepEqual(pluginSchema.parse({ taskResearch: true }), { taskResearch: true });
  for (const invalid of [{}, { taskResearch: 'true' }, { taskResearch: true, unknownPlugin: true }]) {
    assert.throws(() => pluginSchema.parse(invalid));
    assert.throws(() => migrateState({ ...emptyState(), plugins: invalid }));
  }
});

test('research capability does not enable project mutations in read-only modes', () => {
  const optedIn = { ...DEFAULT_UTILITIES, webResearch: true };
  for (const mode of ['research', 'assistant'] as const) {
    const effective = effectiveUtilities(mode, optedIn, { taskResearch: true });
    assert.equal(effective.fileEditing, false);
    assert.equal(effective.terminal, false);
    assert.equal(effective.projectSearch, false);
  }
});

test('saved local-model thoughts stay separate from answers and older chats remain compatible', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Task with work details', updatedAt: '2026-10-10T00:00:00Z',
    mode: 'coding' as const, projectPath: '/project', files: [{ name: 'notes.txt', path: '/project/notes.txt' }],
    messages: [
      { role: 'user' as const, content: 'Build the project' },
      { role: 'assistant' as const, content: 'Created the approved files.', thinking: 'Inspect the project before changing it. سلام 🌍' },
      { role: 'assistant' as const, content: '', thinking: 'Partial thought retained after interruption.' },
    ] };
  for (const version of [1, 2, 3]) {
    const migrated = migrateState({ ...emptyState(), version, sessions: [session] });
    assert.deepEqual(migrated.sessions, [session]);
    const legacyMessage = { role: 'assistant', content: 'An older reply without thoughts' };
    const older = migrateState({ ...emptyState(), version, sessions: [{ ...session, messages: [legacyMessage] }] });
    assert.deepEqual(older.sessions[0].messages, [legacyMessage]);
  }
});

test('migration bounds oversized thoughts while preserving the answer, attachments and user text', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Existing chat', updatedAt: '2026-10-10T00:00:00Z',
    mode: 'coding', files: [{ name: 'notes.txt', path: '/project/notes.txt' }], messages: [
      { role: 'user', content: 'Keep my request.', thinking: 'User messages are not model thoughts.' },
      { role: 'assistant', content: 'Keep my complete answer.', thinking: '🌍'.repeat(MAX_THINKING_BYTES) },
    ] };
  const migrated = migrateState({ ...emptyState(), sessions: [session] }).sessions[0];
  assert.deepEqual(migrated.messages[0], { role: 'user', content: 'Keep my request.' });
  assert.equal(migrated.messages[1].content, 'Keep my complete answer.');
  assert.equal(new TextEncoder().encode(migrated.messages[1].thinking).length, MAX_THINKING_BYTES);
  assert.ok(!migrated.messages[1].thinking?.includes('\ufffd'));
  assert.deepEqual(migrated.files, session.files);
});

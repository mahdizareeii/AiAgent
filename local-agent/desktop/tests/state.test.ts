import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindSessionTranscript, DEFAULT_PLUGINS, DEFAULT_UTILITIES, effectiveUtilities, emptyState, migrateState, pluginSchema } from '../state.ts';
import { MAX_THINKING_BYTES } from '../thinking.ts';
import { NORMAL_TASK_BUDGET_MS } from '../execution-policy.ts';
import { parseTaskBrief, taskBriefSchema, TaskVerificationLedger } from '../task-verification.ts';
import { createHash } from 'node:crypto';

// These compatibility cases assert every pre-v7 saved field. Workspace/model
// identity and route migration have their own explicit tests below.
function retained(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(retained);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['workspaces', 'workspaceId', 'defaultWorkspaceId', 'navigation', 'preferredModel', 'transcriptHistory'].includes(key)).map(([key, item]) => [key, retained(item)]));
}
function assertRetained(actual: unknown, expected: unknown, message?: string) { if (message === undefined) assert.deepEqual(retained(actual), retained(expected)); else assert.deepEqual(retained(actual), retained(expected), message); }

test('model switches cannot revive a canonical seed that omits intervening conversation', () => {
  const binding = { modelId: 'qwen3.8:27b', digest: 'a'.repeat(64), templateHash: 'b'.repeat(64), profileSignature: '32K' };
  const session = migrateState({ ...emptyState(), sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Retained task', updatedAt: '2026-10-10T00:00:00Z', mode: 'coding', files: [],
    messages: [{ role: 'user', content: 'First request' }, { role: 'assistant', content: 'First result' }], transcriptBinding: binding,
    canonicalTranscript: [{ role: 'user', content: 'First request' }, { role: 'assistant', content: 'First result', reasoning_content: 'Prior reasoning' }] }] }).sessions[0];
  const original = session.canonicalTranscript;
  assert.equal(bindSessionTranscript(session, { ...binding, profileSignature: '16K' }, true), original);
  assert.equal(bindSessionTranscript(session, { ...binding, modelId: 'qwen3.5:4b' }, false), undefined);
  session.messages.push({ role: 'user', content: 'Intervening legacy request' }, { role: 'assistant', content: 'Legacy result' });
  assert.equal(bindSessionTranscript(session, binding, true), undefined);
  assert.equal(session.messages.at(-1)?.content, 'Legacy result'); assert.equal(session.canonicalTranscript, undefined);
  session.canonicalTranscript = original;
  assert.equal(bindSessionTranscript(session, { ...binding, digest: 'c'.repeat(64) }, true), undefined);
});

test('legacy migration preserves task behavior and v5 retains outcomes and execution preferences', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Retained task', updatedAt: '2026-10-10T00:00:00Z', mode: 'coding', projectPath: '/project', files: [{ name: 'notes.txt', path: '/project/notes.txt' }], messages: [{ role: 'assistant', content: 'Readback retained.' }] };
  const migrated = migrateState({ version: 3, selectedModel: 'qwen3.5:4b', mode: 'coding', sessions: [session] });
  assertRetained(migrated.sessions, [{ ...session, executionBudgetMs: NORMAL_TASK_BUDGET_MS }]); assert.equal(migrated.sessions[0].taskEffort ?? 'standard', 'standard');
  assert.equal(migrated.defaultTaskEffort, 'careful'); assert.equal(migrated.memoryMode, 'automatic');
  const outcome = { status: 'timed-out', finishReason: 'active deadline', checks: [{ id: 'read:1', title: 'read_file', status: 'passed', detail: 'Literal 1: text\r\n', evidence: { operation: 'read_file', path: '/project/notes.txt', sha256: 'a'.repeat(64), complete: true } }] };
  const current = { ...migrated, memoryMode: 'low-memory', defaultTaskEffort: 'standard', sessions: [{ ...session, taskEffort: 'careful', messages: [{ role: 'assistant', content: 'Completed changes preserved.', outcome }] }] };
  assertRetained(migrateState(current), current);
});

test('verified task contracts and canonical tool history survive reopening without becoming tool execution', () => {
  const taskBrief = parseTaskBrief({ goal: 'Create note', deliverables: ['note.txt'], criteria: [{ id: 'bytes', description: 'Exact note', kind: 'exact_file', path: 'note.txt', content: 'ok\n' }] }, 'Create note.');
  const model = { id: 'qwen3.8:27b', digest: 'a'.repeat(64), runtime: 'b'.repeat(64), contextTokens: 16384, backend: 'metal', memoryMode: 'automatic',
    profileSignature: '16K-F16', nativeMemoryPlanDigest: 'c'.repeat(64),
    calibrationMeasurements: { sampledAt: '2026-10-14T00:00:00Z', residentBytes: 1024, physicalFootprintBytes: 1024, rssBytes: 1024, availableMemoryBytes: 2048, pressure: 'normal' } };
  const canonicalTranscript = [
    { role: 'user', content: 'Create note.' },
    { role: 'assistant', content: null, reasoning_content: 'Read before writing.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'reviewed_actions__write_file', arguments: '{"path":"note.txt","content":"ok\\n"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' },
    { role: 'assistant', content: 'The requested note was verified.' },
  ];
  const saved = { ...emptyState(), selectedModel: 'qwen3.8:27b', sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Note', updatedAt: '2026-10-14T00:00:00Z', mode: 'coding', projectPath: '/project', files: [], taskBrief,
    canonicalTranscript, transcriptIncomplete: false, transcriptBinding: { modelId: 'qwen3.8:27b', digest: 'a'.repeat(64), templateHash: 'b'.repeat(64), profileSignature: '32k' },
    messages: [{ role: 'assistant', content: 'Verified.', outcome: { status: 'completed', verification: 'passed', finishReason: 'end_turn', taskBrief, model, checks: [{ id: 'acceptance:bytes', title: 'Exact note', status: 'passed', detail: 'Current read', purpose: 'acceptance', checkIds: ['bytes'], evidence: { operation: 'verify_exact_file', path: 'note.txt', sha256: 'c'.repeat(64), inputDigest: 'd'.repeat(64), complete: true } }] } }] }] };
  assertRetained(migrateState(saved), saved);
  const malformed = structuredClone(saved); (malformed.sessions[0].canonicalTranscript[1] as any).unexpectedExecutable = 'run';
  assert.equal(migrateState(malformed).sessions[0].canonicalTranscript, undefined);
});

test('portable owned-process calibration diagnostics survive reopening without inferring a physical footprint', () => {
  const fixture = (measurements: unknown) => ({ ...emptyState(), sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Portable evidence', updatedAt: '2026-10-17T00:00:00Z', mode: 'coding', files: [], messages: [{ role: 'assistant', content: 'Recorded result', outcome: { status: 'blocked', finishReason: 'fixture', checks: [], model: { id: 'qwen3.5:4b', digest: 'a'.repeat(64), runtime: 'b'.repeat(64), contextTokens: 4096, backend: 'cpu', memoryMode: 'low-memory', calibrationMeasurements: measurements } } }] }] });
  const base = { sampledAt: '2026-10-17T00:00:00Z', residentBytes: 1024, rssBytes: 1024, availableMemoryBytes: 2048, pressure: 'normal' };
  const load = (measurements: unknown) => migrateState(JSON.parse(JSON.stringify(fixture(measurements)))).sessions[0].messages[0].outcome!.model!.calibrationMeasurements!;
  for (const platform of ['linux', 'win32'] as const) {
    const measurements = { ...base, privateCommitBytes: 4096, swapBytes: 0, monitor: { platform, source: platform === 'linux' ? 'proc/meminfo+smaps_rollup' : 'Win32_OperatingSystem+Process.WorkingSet64', pressureSource: 'available-headroom-policy', pid: 123, parentPid: 456 } };
    const loaded = load(measurements); assert.deepEqual(loaded, measurements);
    assert.equal(Object.hasOwn(loaded, 'physicalFootprintBytes'), false, 'Private commit remains separate from footprint.');
    assert.deepEqual(load({ ...measurements, physicalFootprintBytes: null, monitor: { ...measurements.monitor, pid: null, parentPid: null } }), { ...measurements, physicalFootprintBytes: null, monitor: { ...measurements.monitor, pid: null, parentPid: null } });
    for (const invalid of [{ ...measurements, privateCommitBytes: -1 }, { ...measurements, swapBytes: '0' }, { ...measurements, monitor: { ...measurements.monitor, platform: 'unknown' } }, { ...measurements, monitor: { ...measurements.monitor, pid: 0 } }, { ...measurements, monitor: { ...measurements.monitor, parentPid: 1.5 } }]) assert.throws(() => load(invalid));
  }
  assert.deepEqual(load(base), base, 'Legacy observations remain compatible without invented diagnostics.');
});

test('historical contradictory plans reopen unchanged while fresh execution rejects their semantics', () => {
  const request = 'Implement stats.mjs', taskBrief = { version: 1 as const, requestHash: createHash('sha256').update(request).digest('hex'),
    goal: request, deliverables: ['stats.mjs'], criteria: [{ id: 'file', description: 'stats.mjs must exist', kind: 'absence' as const, path: 'stats.mjs' }] };
  const saved = { ...emptyState(), sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Historical blocked task', updatedAt: '2026-10-14T00:00:00Z', mode: 'coding', projectPath: '/project', files: [], executionBudgetMs: NORMAL_TASK_BUDGET_MS, taskBrief,
    messages: [{ role: 'assistant', content: 'The task stopped before any coding action.', outcome: { status: 'blocked', verification: 'failed', finishReason: 'incomplete', taskBrief, checks: [] } }] }] };
  const loaded = migrateState(JSON.parse(JSON.stringify(saved)));
  assertRetained(loaded, saved); assertRetained(loaded.sessions[0].taskBrief, taskBrief);
  assertRetained(loaded.sessions[0].messages[0].outcome?.taskBrief, taskBrief);
  assert.equal(loaded.sessions[0].messages[0].outcome?.verification, 'failed');
  assertRetained(taskBriefSchema.parse(taskBrief), taskBrief, 'Reading saved evidence is structural, not a new certification.');
  assert.throws(() => parseTaskBrief(taskBrief, request), /Contradictory absence/);
  assert.throws(() => new TaskVerificationLedger(taskBrief, '/project'), /Contradictory absence/, 'A historical plan cannot bypass new-execution validation.');
});

test('historical extra command criteria are retained as evidence rather than rejected by new planning policy', () => {
  const request = 'Run exactly `node check.mjs`.', taskBrief = { version: 1 as const, requestHash: createHash('sha256').update(request).digest('hex'), goal: request, deliverables: ['stats.mjs'], criteria: [
    { id: 'check', description: 'Requested check', kind: 'command' as const, command: 'node check.mjs', cwd: '.', paths: ['stats.mjs', 'check.mjs'] },
    { id: 'bonus', description: 'Old unapproved extra check', kind: 'command' as const, command: 'node stats.mjs invalid | grep PASS', cwd: '.', paths: ['stats.mjs'] },
  ] };
  const saved = { ...emptyState(), sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Historical extra check', updatedAt: '2026-10-14T00:00:00Z', mode: 'coding', projectPath: '/project', files: [], executionBudgetMs: NORMAL_TASK_BUDGET_MS, taskBrief,
    messages: [{ role: 'assistant', content: 'Unapproved required check retained.', outcome: { status: 'blocked', verification: 'unverified', finishReason: 'incomplete', taskBrief, checks: [] } }] }] };
  assertRetained(migrateState(JSON.parse(JSON.stringify(saved))), saved);
  assertRetained(taskBriefSchema.parse(taskBrief), taskBrief);
  assert.throws(() => parseTaskBrief(taskBrief, request), /extra mandatory shell probes/);
});

test('web research requires both the plugin and web permission and stays unavailable in Chat', () => {
  for (const mode of ['coding', 'research', 'assistant'] as const) {
    assert.equal(effectiveUtilities(mode, DEFAULT_UTILITIES).webResearch, false);
    assert.equal(effectiveUtilities(mode, DEFAULT_UTILITIES, { taskResearch: true }).webResearch, false);
    assert.equal(effectiveUtilities(mode, { ...DEFAULT_UTILITIES, webResearch: true }).webResearch, false);
    assert.equal(effectiveUtilities(mode, { ...DEFAULT_UTILITIES, webResearch: true }, { taskResearch: true }).webResearch, mode !== 'assistant');
  }
  assert.equal(DEFAULT_UTILITIES.webResearch, false);
  assertRetained(emptyState().plugins, { taskResearch: false });
  assertRetained(DEFAULT_PLUGINS, { taskResearch: false });
  assert.equal(emptyState().version, 7);
});

test('legacy explicit web consent migrates to the plugin while preserving model, project, chats and attachments', () => {
  const existing = { ...emptyState(), selectedModel: 'qwen3.5:4b', mode: 'research' as const,
    utilities: { ...DEFAULT_UTILITIES, webResearch: true }, projectPath: '/project',
    sessions: [{ id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Saved research', updatedAt: '2026-10-10T00:00:00Z',
      mode: 'research' as const, messages: [{ role: 'user' as const, content: 'Keep my sources' }], files: [{ name: 'notes.txt', path: '/project/notes.txt' }] }] };
  const { plugins: _legacyMissingPlugins, ...legacy } = existing;
  for (const version of [undefined, 1, 2]) {
    const migrated = migrateState({ ...legacy, version });
    assertRetained(migrated, { ...existing, plugins: { taskResearch: true }, sessions: existing.sessions.map(session => ({ ...session, executionBudgetMs: NORMAL_TASK_BUDGET_MS })) });
    assert.equal(effectiveUtilities('coding', migrated.utilities, migrated.plugins).webResearch, true);
    assert.equal(effectiveUtilities('assistant', migrated.utilities, migrated.plugins).webResearch, false);
  }
});

test('a current saved state with a missing plugin toggle defaults off even with retained web consent', () => {
  const { plugins: _missingPlugins, ...current } = emptyState();
  const migrated = migrateState({ ...current, utilities: { ...DEFAULT_UTILITIES, webResearch: true } });
  assertRetained(migrated.plugins, { taskResearch: false });
  assert.equal(migrated.utilities.webResearch, true, 'Keep the separate web permission without inferring plugin activation.');
  assert.equal(effectiveUtilities('coding', migrated.utilities, migrated.plugins).webResearch, false);
});

test('saved explicit plugin choices survive migration without inheriting or removing web consent', () => {
  for (const taskResearch of [true, false]) {
    for (const webResearch of [true, false]) {
      const existing = { ...emptyState(), plugins: { taskResearch }, utilities: { ...DEFAULT_UTILITIES, webResearch } };
      const migrated = migrateState(existing);
      assertRetained(migrated, existing);
      assert.equal(effectiveUtilities('coding', migrated.utilities, migrated.plugins).webResearch, taskResearch && webResearch);
    }
  }
});

test('missing legacy consent defaults plugin off and plugin IPC schema rejects unknown or nonboolean settings', () => {
  for (const version of [1, 2, 3]) {
    const { plugins: _missingPlugin, utilities: _missingUtilities, ...legacy } = emptyState();
    const migrated = migrateState({ ...legacy, version });
    assertRetained(migrated.plugins, { taskResearch: false });
    assert.equal(migrated.utilities.webResearch, false);
  }
  assertRetained(pluginSchema.parse({ taskResearch: true }), { taskResearch: true });
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
    assertRetained(migrated.sessions, [{ ...session, executionBudgetMs: NORMAL_TASK_BUDGET_MS }]);
    const legacyMessage = { role: 'assistant', content: 'An older reply without thoughts' };
    const older = migrateState({ ...emptyState(), version, sessions: [{ ...session, messages: [legacyMessage] }] });
    assertRetained(older.sessions[0].messages, [legacyMessage]);
  }
});

test('migration bounds oversized thoughts while preserving the answer, attachments and user text', () => {
  const session = { id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Existing chat', updatedAt: '2026-10-10T00:00:00Z',
    mode: 'coding', files: [{ name: 'notes.txt', path: '/project/notes.txt' }], messages: [
      { role: 'user', content: 'Keep my request.', thinking: 'User messages are not model thoughts.' },
      { role: 'assistant', content: 'Keep my complete answer.', thinking: '🌍'.repeat(MAX_THINKING_BYTES) },
    ] };
  const migrated = migrateState({ ...emptyState(), sessions: [session] }).sessions[0];
  assertRetained(migrated.messages[0], { role: 'user', content: 'Keep my request.' });
  assert.equal(migrated.messages[1].content, 'Keep my complete answer.');
  assert.equal(new TextEncoder().encode(migrated.messages[1].thinking).length, MAX_THINKING_BYTES);
  assert.ok(!migrated.messages[1].thinking?.includes('\ufffd'));
  assertRetained(migrated.files, session.files);
});

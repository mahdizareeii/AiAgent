import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionForRenderer } from '../session-projection.ts';
import type { SavedSession } from '../state.ts';
import type { AgentSession, ChatMessage } from '../renderer/types.ts';
import { MAX_TOOL_ACTIVITIES, MAX_TOOL_DETAIL_BYTES, restoreToolHistory } from '../tool-history.ts';

const privateKeys = ['canonicalTranscript', 'transcriptHistory', 'transcriptBinding', 'transcriptIncomplete', 'taskBrief'];
const savedSession = (): SavedSession => ({
  id: '596c9bc7-bacc-44bf-9f43-9eb5108acb5d', title: 'Saved task', updatedAt: '2026-10-17T00:00:00Z',
  mode: 'coding', messages: [], files: [],
});

test('renderer projection preserves all visible tool, outcome, draft and ownership bytes while omitting host state', () => {
  const tools = restoreToolHistory(Array.from({ length: MAX_TOOL_ACTIVITIES }, (_, index) => ({
    id: `read-${index}`, title: `Read file ${index}`, status: 'completed',
    input: { path: `source-${index}.txt`, offset: index, expected_sha256: 'a'.repeat(64) },
    output: { ok: true, text: `source-${index}\r\n${'سلام 🌍\n'.repeat(900)}`, sha256: 'b'.repeat(64), next_offset: null },
  }))).tools;
  assert.equal(tools.length, 256);
  for (const tool of tools) for (const value of [tool.input, tool.output]) {
    assert.ok(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) <= MAX_TOOL_DETAIL_BYTES);
  }
  const brief: NonNullable<SavedSession['taskBrief']> = { version: 1, requestHash: 'c'.repeat(64),
    goal: 'Write the exact requested bytes', deliverables: ['answer.txt'],
    criteria: [{ id: 'exact', kind: 'exact_file', description: 'Exact UTF-8 bytes', path: 'answer.txt', content: 'سلام 🌍\n' }] };
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Keep BOM, CRLF, quotes and final LF: \ufeff"سلام"\r\n' },
    { role: 'assistant', content: 'Written and checked.\n', thinking: 'Observed receipts.\n', tools, toolsTruncated: true,
      outcome: { status: 'completed', finishReason: 'end_turn', verification: 'passed', taskBrief: brief,
        checks: [{ id: 'exact', title: 'Exact bytes', status: 'passed', detail: 'Observed exact UTF-8 bytes.\n',
          purpose: 'acceptance', checkIds: ['exact'], evidence: { operation: 'read_file', path: 'answer.txt', sha256: 'd'.repeat(64), complete: true } }],
        model: { id: 'qwen3.5:9b-ud-iq2-m', digest: 'e'.repeat(64), runtime: 'llama.cpp', backend: 'cpu', contextTokens: 4096,
          memoryMode: 'low-memory', profileSignature: 'pinned-profile', portableMemoryPlanDigest: 'f'.repeat(64) } } },
  ];
  const binding: NonNullable<SavedSession['transcriptBinding']> = { modelId: 'qwen3.5:9b-ud-iq2-m',
    digest: 'e'.repeat(64), templateHash: 'a'.repeat(64), profileSignature: 'pinned-profile' };
  const transcript: NonNullable<SavedSession['canonicalTranscript']> = [
    { role: 'user', content: 'Host-only transcript prefix\n'.repeat(8000) },
    { role: 'assistant', content: null, reasoning_content: 'Host-only model reasoning\n'.repeat(8000),
      tool_calls: [{ id: 'native-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"answer.txt"}' } }] },
    { role: 'tool', content: '{"ok":true,"text":"سلام 🌍\\n"}', tool_call_id: 'native-read' },
  ];
  const session: SavedSession = { ...savedSession(), messages, files: [{ name: 'submitted.txt', path: '/workspace/submitted.txt' }],
    projectPath: '/workspace/project', workspaceId: 'workspace-1', preferredModel: binding.modelId, taskEffort: 'careful',
    draft: 'Next task\r\nسلام 🌍', draftFiles: [{ name: 'notes.txt', path: '/workspace/notes.txt' }], draftRevision: 7,
    executionBudgetMs: 300000, validationRecordId: 'validation-1', taskBrief: brief,
    canonicalTranscript: transcript, transcriptBinding: binding, transcriptIncomplete: true,
    transcriptHistory: [{ binding, messages: transcript, throughMessageCount: messages.length }] };
  const before = JSON.stringify(session);
  const projected = sessionForRenderer(session);
  const expected: AgentSession = { id: session.id, mode: session.mode, messages, files: session.files,
    draft: session.draft, draftFiles: session.draftFiles, draftRevision: 7, projectPath: session.projectPath,
    workspaceId: session.workspaceId, preferredModel: binding.modelId, taskEffort: 'careful' };
  assert.deepEqual(projected, expected);
  assert.equal(JSON.stringify(projected), JSON.stringify(expected), 'IPC-visible values retain exact bytes.');
  assert.equal(projected.messages, messages, 'The host should not create an additional message/tool copy before IPC.');
  assert.equal(projected.draftFiles, session.draftFiles);
  assert.equal(projected.files, session.files, 'Submitted attachments remain visible without a host-side copy.');
  assert.equal(projected.messages[1].outcome?.taskBrief, brief, 'The displayed outcome keeps its own acceptance details.');
  for (const key of [...privateKeys, 'title', 'updatedAt', 'executionBudgetMs', 'validationRecordId']) {
    assert.equal(Object.hasOwn(projected, key), false, `${key} is outside AgentSession.`);
  }
  assert.equal(JSON.stringify(session), before, 'Projection cannot mutate durable host state.');
  assert.ok(Buffer.byteLength(before) > Buffer.byteLength(JSON.stringify(projected)) + 500000,
    'Host transcript payloads are excluded from the serialized renderer transfer.');
});

test('active assistant overlay matches loadSession append behavior without changing saved messages', () => {
  const saved: ChatMessage = { role: 'user', content: 'Read this file.\n' };
  const session = { ...savedSession(), messages: [saved] };
  const active: ChatMessage = { role: 'assistant', content: '', thinking: 'Reading…',
    tools: [{ id: 'read', title: 'Read file', status: 'in_progress', input: { path: 'answer.txt' } }] };
  const before = structuredClone(session);
  const projected = sessionForRenderer(session, active);
  assert.deepEqual(projected.messages, [...session.messages, active]);
  assert.notEqual(projected.messages, session.messages);
  assert.equal(projected.messages[0], saved);
  assert.equal(projected.messages[1], active, 'An unfinished tool-only assistant message remains visible.');
  assert.deepEqual(session, before);
  assert.deepEqual(sessionForRenderer(session).messages, [saved], 'An overlay is never persisted by projection.');
});

test('optional renderer fields stay undefined while explicit empty values and model ownership survive', () => {
  const session = savedSession();
  const projected = sessionForRenderer(session);
  assert.deepEqual(projected, { id: session.id, mode: 'coding', messages: [], files: [] });
  for (const key of ['draft', 'draftFiles', 'draftRevision', 'projectPath', 'workspaceId', 'preferredModel', 'taskEffort', 'stage'] as const) {
    assert.equal(projected[key], undefined, `${key} must not acquire a default.`);
  }
  const explicit = sessionForRenderer({ ...session, draft: '', draftFiles: [], draftRevision: 0, preferredModel: null, taskEffort: 'standard' });
  assert.equal(explicit.draft, '');
  assert.deepEqual(explicit.draftFiles, []);
  assert.equal(explicit.draftRevision, 0);
  assert.equal(explicit.preferredModel, null, 'Explicit no-model ownership must not become an inherited model.');
  assert.equal(explicit.taskEffort, 'standard');
  assert.deepEqual(sessionForRenderer({ ...session, draft: undefined, preferredModel: undefined }), projected);
});

test('host-private and unknown session fields are not inspected by the renderer projection', () => {
  const session = savedSession();
  for (const key of [...privateKeys, 'futureHostOnlyState']) Object.defineProperty(session, key, {
    enumerable: true, get: () => { throw new Error(`Renderer projection read ${key}`); },
  });
  assert.deepEqual(sessionForRenderer(session), { id: session.id, mode: 'coding', messages: [], files: [] });
});

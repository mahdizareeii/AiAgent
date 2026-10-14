import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addResearchNote, clearResearchNotebook, deleteResearchNotes, exportResearchNotebook, listResearchNotes, notebookPath } from '../research-notebook.ts';

test('workspace research notebook saves, searches, exports, and deletes cited evidence', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'local-agent-notebook-'));
  const first = await addResearchNote(workspace, { url: 'https://example.test/docs', title: 'Official docs', publisher: 'Example', retrievedAt: '2026-10-13T00:00:00Z', quote: 'A quoted fact.', summary: 'Use the documented API.', fileRefs: ['src/index.ts'] });
  await addResearchNote(workspace, { url: 'https://example.test/release', title: 'Release notes', retrievedAt: '2026-10-13T00:00:01Z', summary: 'A newer release.' });
  assert.equal((await listResearchNotes(workspace, 'quoted')).length, 1);
  assert.match(await exportResearchNotebook(workspace, 'markdown'), /Official docs/);
  assert.match(await exportResearchNotebook(workspace, 'json'), /https:\/\/example\.test\/docs/);
  const stored = JSON.parse(await readFile(notebookPath(workspace), 'utf8'));
  assert.equal(stored.notes.length, 2);
  assert.equal(await deleteResearchNotes(workspace, [first.id]), 1);
  assert.equal(await clearResearchNotebook(workspace), 1);
  assert.equal((await listResearchNotes(workspace)).length, 0);
});

test('invalid research notes are rejected before a notebook is created', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'local-agent-notebook-invalid-'));
  await assert.rejects(addResearchNote(workspace, { url: 'javascript:alert(1)', title: 'bad', retrievedAt: 'now', summary: 'bad' }), /require a source URL/);
});


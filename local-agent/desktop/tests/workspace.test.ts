import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { workspaceNameError } from '../workspace-name.ts';
import { createWorkspaceFolder, persistWorkspaceSelection, selectWorkspaceFolder } from '../workspace.ts';

async function temporary<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'free-local-agent-workspace-'));
  try { return await run(await realpath(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('workspace names reject traversal, control characters, nonportable characters and Windows device names', () => {
  const invalid = ['', ' ', '.', '..', '../outside', 'child/inside', 'child\\inside', '/absolute', 'C:\\project',
    'project.', 'project ', 'project\t', 'project\n', 'project\0', 'project\x7f', 'project\x85',
    'bad<name', 'bad>name', 'bad:name', 'bad"name', 'bad|name', 'bad?name', 'bad*name',
    'CON', 'con.txt', 'PRN', 'aux.md', 'NUL', 'COM1', 'COM9.txt', 'LPT1', 'lpt9.log', 'COM¹', 'LPT².txt', 'CONIN$', 'CONOUT$.txt',
    'a'.repeat(256), 'é'.repeat(128)];
  for (const name of invalid) assert.equal(typeof workspaceNameError(name), 'string', JSON.stringify(name));
  for (const name of ['wordpress', 'My project', '.draft', 'پروژه', 'Agent α', 'a'.repeat(255), 'COM10', 'context', 'file.name']) {
    assert.equal(workspaceNameError(name), undefined, JSON.stringify(name));
  }
});

test('invalid workspace names never open the picker or create a folder', async () => {
  let picked = false, persisted = false;
  await assert.rejects(createWorkspaceFolder('../outside', {
    assertAvailable: () => {}, pickDirectory: async () => { picked = true; return '/unused'; },
    persistSelection: async () => { persisted = true; },
  }), /path separators/);
  assert.equal(picked, false);
  assert.equal(persisted, false);
});

test('creation grants only a new canonical child after successfully saving its selection', async () => temporary(async parent => {
  const state: { projectPath?: string } = { projectPath: '/previous' }, grants = new Set(['/previous']);
  let saves = 0;
  const selected = await createWorkspaceFolder('WordPress project', {
    assertAvailable: () => {}, pickDirectory: async () => parent,
    persistSelection: folder => persistWorkspaceSelection(folder, state, grants, async () => {
      saves++;
      assert.equal(state.projectPath, path.join(parent, 'WordPress project'));
      assert.equal(grants.has(parent), false);
      assert.equal(grants.has(folder), false, 'A pending save must not grant a workspace.');
    }),
  });
  assert.equal(selected, await realpath(path.join(parent, 'WordPress project')));
  assert.equal(state.projectPath, selected);
  assert.deepEqual([...grants], ['/previous', selected]);
  assert.deepEqual(await readdir(selected!), []);
  assert.equal(saves, 1);
  if (process.platform !== 'win32') assert.equal((await stat(selected!)).mode & 0o777, 0o700);
}));

test('canceling the parent picker changes neither files, selection nor grants', async () => temporary(async parent => {
  const state = { projectPath: parent }, grants = new Set([parent]);
  let persisted = false;
  const selected = await createWorkspaceFolder('new-work', {
    assertAvailable: () => {}, pickDirectory: async () => null,
    persistSelection: async () => { persisted = true; },
  });
  assert.equal(selected, null);
  assert.equal(persisted, false);
  assert.deepEqual(await readdir(parent), []);
  assert.equal(state.projectPath, parent);
  assert.deepEqual([...grants], [parent]);
}));

test('existing folders and files are never overwritten or selected through Create folder', async () => temporary(async parent => {
  await mkdir(path.join(parent, 'existing'));
  await writeFile(path.join(parent, 'existing', 'keep.txt'), 'Keep this project');
  await writeFile(path.join(parent, 'existing-file'), 'Keep this file');
  let persisted = false;
  for (const name of ['existing', 'existing-file']) {
    await assert.rejects(createWorkspaceFolder(name, {
      assertAvailable: () => {}, pickDirectory: async () => parent,
      persistSelection: async () => { persisted = true; },
    }), /already exists/);
  }
  assert.equal(persisted, false);
  assert.equal(await readFile(path.join(parent, 'existing', 'keep.txt'), 'utf8'), 'Keep this project');
  assert.equal(await readFile(path.join(parent, 'existing-file'), 'utf8'), 'Keep this file');
}));

test('a preexisting symlink cannot redirect Create folder to an existing project', { skip: process.platform === 'win32' }, async () => temporary(async parent => {
  const actual = path.join(parent, 'actual');
  await mkdir(actual);
  await writeFile(path.join(actual, 'keep.txt'), 'Keep this project');
  await symlink(actual, path.join(parent, 'linked'));
  let persisted = false;
  await assert.rejects(createWorkspaceFolder('linked', {
    assertAvailable: () => {}, pickDirectory: async () => parent,
    persistSelection: async () => { persisted = true; },
  }), /already exists/);
  assert.equal(persisted, false);
  assert.equal(await readFile(path.join(actual, 'keep.txt'), 'utf8'), 'Keep this project');
}));

test('a native picker selecting a symlinked parent creates and grants only its canonical child', { skip: process.platform === 'win32' }, async () => temporary(async root => {
  const parent = path.join(root, 'parent');
  await mkdir(parent);
  await symlink(parent, path.join(root, 'alias'));
  const grants = new Set<string>(), state: { projectPath?: string } = {};
  const selected = await createWorkspaceFolder('new-project', {
    assertAvailable: () => {}, pickDirectory: async () => path.join(root, 'alias'),
    persistSelection: folder => persistWorkspaceSelection(folder, state, grants, async () => {}),
  });
  assert.equal(selected, path.join(parent, 'new-project'));
  assert.deepEqual([...grants], [selected]);
}));

test('save failure restores the previous workspace, grants nothing new, and preserves the created folder and any content', async () => temporary(async parent => {
  const previous = path.join(parent, 'previous');
  const state: { projectPath?: string } = { projectPath: previous }, grants = new Set([previous]);
  const created = path.join(parent, 'new-project');
  await assert.rejects(createWorkspaceFolder('new-project', {
    assertAvailable: () => {}, pickDirectory: async () => parent,
    persistSelection: folder => persistWorkspaceSelection(folder, state, grants, async () => {
      await writeFile(path.join(folder, 'external-content.txt'), 'Do not delete content added during creation.');
      throw new Error('Disk is full.');
    }),
  }), error => error instanceof Error && error.message.includes(JSON.stringify(created))
    && /Disk is full/.test(error.message) && /no access was granted/.test(error.message));
  assert.equal(state.projectPath, previous);
  assert.deepEqual([...grants], [previous]);
  assert.equal(await readFile(path.join(created, 'external-content.txt'), 'utf8'), 'Do not delete content added during creation.');
}));

test('work starting while the parent picker is open prevents folder creation', async () => temporary(async parent => {
  let active = false, persisted = false;
  await assert.rejects(createWorkspaceFolder('new-project', {
    assertAvailable: () => { if (active) throw new Error('A task is now active.'); },
    pickDirectory: async () => { active = true; return parent; },
    persistSelection: async () => { persisted = true; },
  }), /task is now active/);
  assert.equal(persisted, false);
  assert.deepEqual(await readdir(parent), []);
}));

test('a selected file cannot be used as the parent for Create folder', async () => temporary(async parent => {
  const file = path.join(parent, 'notes.txt');
  await writeFile(file, 'Keep this file');
  let persisted = false;
  await assert.rejects(createWorkspaceFolder('new-project', {
    assertAvailable: () => {}, pickDirectory: async () => file,
    persistSelection: async () => { persisted = true; },
  }), /Choose a folder/);
  assert.equal(persisted, false);
  assert.deepEqual(await readdir(parent), ['notes.txt']);
}));

test('Add folder resolves its native selection and rolls back without granting on failed save', async () => temporary(async parent => {
  const previous = '/previous', state: { projectPath?: string } = { projectPath: previous }, grants = new Set([previous]);
  await assert.rejects(selectWorkspaceFolder({
    assertAvailable: () => {}, pickDirectory: async () => parent,
    persistSelection: folder => persistWorkspaceSelection(folder, state, grants, async () => { throw new Error('Cannot save.'); }),
  }), /Cannot save/);
  assert.equal(state.projectPath, previous);
  assert.deepEqual([...grants], [previous]);
}));

test('Add folder cancellation and active-task recheck preserve selection and reject broad root grants', async () => {
  let active = false, persisted = false;
  const base = { assertAvailable: () => { if (active) throw new Error('Task active.'); }, persistSelection: async () => { persisted = true; } };
  assert.equal(await selectWorkspaceFolder({ ...base, pickDirectory: async () => null }), null);
  await assert.rejects(selectWorkspaceFolder({ ...base, pickDirectory: async () => path.parse(process.cwd()).root }), /specific project folder/);
  await assert.rejects(selectWorkspaceFolder({ ...base, pickDirectory: async () => { active = true; return process.cwd(); } }), /Task active/);
  assert.equal(persisted, false);
});

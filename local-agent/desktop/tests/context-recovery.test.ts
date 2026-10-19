import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ContextRecoveryArchive, collectPriorContextRecoveryGrants, initializeContextRecoveryArchive } from '../context-recovery.ts';
import { compactOwnedToolDescriptions } from '../tool-context.ts';

const exchange = (id: string, text = 'Exact source — سلام\r\n') => [{ role: 'assistant', content: null, reasoning_content: 'Exact completed reasoning 🌍', tool_calls: [{ id, type: 'function', function: { name: 'local_files_and_research__read_file', arguments: '{"path":"src/app.ts","cursor":"EXACT_CURSOR"}' } }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true, path: 'src/app.ts', sha256: 'a'.repeat(64), text }) }];

test('recovery retains exact closed reasoning/calls/results in immutable paginatable parts and deduplicates', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'context-parts-')));
  try {
    const initialized = await initializeContextRecoveryArchive(path.join(directory, 'manifest.json'));
    assert.equal(initialized.grantedFiles.length, 40); assert.equal(initialized.grantedFiles.includes(initialized.path), false);
    const archive = new ContextRecoveryArchive(initialized.path), original = exchange('closed-1');
    const first = await archive.append(original, []), bytes = await readFile(first.path, 'utf8');
    assert.deepEqual(JSON.parse(bytes.trimEnd().split('\n')[1]).messages, original);
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    const second = await archive.append([...original, ...exchange('closed-2')], []);
    assert.notEqual(second.path, first.path); assert.equal(await readFile(first.path, 'utf8'), bytes, 'Earlier read cursors remain bound to unchanged bytes.');
    const third = await archive.append(original, []); assert.equal(third.closedExchanges, 2); assert.equal(third.path, second.path);
    assert.equal(JSON.parse(await readFile(initialized.path, 'utf8')).parts.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pending, orphan, duplicate and malformed exchanges never enter recovery', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'context-pending-')));
  try {
    const file = path.join(directory, 'manifest.json'); await initializeContextRecoveryArchive(file); const archive = new ContextRecoveryArchive(file);
    const pair = exchange('pending');
    for (const raw of [[pair[0]], [pair[1]], [pair[0], pair[1], pair[1]], [{ ...pair[0], tool_calls: [{ id: 'bad', function: { name: 'read_file', arguments: '{' } }] }, pair[1]]]) await assert.rejects(archive.append(raw, []), /incomplete|invalid|closed/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).parts.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('archive retention refuses overflow or altered parts without evicting earlier exact data', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'context-bound-')));
  try {
    const file = path.join(directory, 'manifest.json'); await initializeContextRecoveryArchive(file); const archive = new ContextRecoveryArchive(file);
    const first = await archive.append(exchange('one', 'x'.repeat(2 * 1024 ** 2)), []), saved = await readFile(first.path);
    await archive.append(exchange('two', 'y'.repeat(2 * 1024 ** 2)), []); await archive.append(exchange('three', 'z'.repeat(2 * 1024 ** 2)), []);
    await assert.rejects(archive.append(exchange('four', 'q'.repeat(2 * 1024 ** 2)), []), /retention limit/);
    assert.deepEqual(await readFile(first.path), saved); assert.equal(JSON.parse(await readFile(file, 'utf8')).parts.length, 3);
    await writeFile(first.path, 'altered'); await assert.rejects(archive.append(exchange('later'), []), /immutable recovery part changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('prior grants require same-session private UUID trees, complete hashes and remaining exact-file capacity', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'context-grants-')));
  try {
    const past = path.join(directory, randomUUID()), current = path.join(directory, randomUUID()); await mkdir(past, { mode: 0o700 }); await mkdir(current, { mode: 0o700 });
    const old = await initializeContextRecoveryArchive(path.join(past, 'manifest.json')); const pointer = await new ContextRecoveryArchive(old.path).append(exchange('past'), []);
    const now = await initializeContextRecoveryArchive(path.join(current, 'manifest.json'));
    assert.deepEqual(await collectPriorContextRecoveryGrants(directory, now.path, 1), [pointer.path]);
    await assert.rejects(collectPriorContextRecoveryGrants(directory, now.path, 0), /grant limit.*silently dropped/);
    await writeFile(pointer.path, 'fake'); await assert.rejects(collectPriorContextRecoveryGrants(directory, now.path, 1), /changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('archive initialization rejects unsafe symlinks and public host directories', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'context-private-')));
  try {
    const target = path.join(directory, 'target'); await writeFile(target, 'private'); await symlink(target, path.join(directory, 'manifest.json'));
    await assert.rejects(initializeContextRecoveryArchive(path.join(directory, 'manifest.json')), /private owned/);
    if (process.platform !== 'win32') { await chmod(directory, 0o755); await assert.rejects(initializeContextRecoveryArchive(path.join(directory, 'other.json')), /private owned/); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('coding tool compression changes only longer app-owned descriptions, never names, schemas or unknown plugins', () => {
  const schema = { type: 'object', required: ['command'], properties: { command: { type: 'string' }, checkIds: { type: 'array' } }, additionalProperties: false };
  const owned = { type: 'function', function: { name: 'reviewed_actions__run_command', description: 'long '.repeat(200), parameters: schema } };
  const unknown = { type: 'function', function: { name: 'external__run_command', description: 'external '.repeat(200), parameters: schema } };
  const tools = [owned, unknown], before = JSON.stringify(tools), compacted = compactOwnedToolDescriptions(tools)! as typeof tools;
  assert.equal(compacted[0].function.name, owned.function.name); assert.equal(compacted[0].function.parameters, schema); assert.equal(compacted[1], unknown);
  assert.match(compacted[0].function.description, /verification\/checkIds.*no approval/); assert.equal(JSON.stringify(tools), before);
});

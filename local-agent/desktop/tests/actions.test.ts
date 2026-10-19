import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ACTION_TOOL_SCHEMAS, LocalActions, repeatedCommandReadFailureText, type ActionPermission, type LocalActionsOptions } from '../actions.ts';
import { commandTimeoutLimits, commandTimeoutText } from '../action-protocol.ts';
import { grantApprovalPolicy, hasApprovalPolicy } from '../approval-policies.ts';
import { TaskVerificationLedger, type TaskBrief } from '../task-verification.ts';
import { createActionHost } from '../action-host.ts';

async function setup(onPermission: (permission: ActionPermission) => Promise<boolean> = async () => true,
  options: Partial<Pick<LocalActionsOptions, 'resultChars' | 'utilities' | 'onTool'>> = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-action-test-')));
  const projectPath = path.join(directory, 'project');
  const historyDirectory = path.join(directory, 'history');
  await mkdir(projectPath);
  const actions = new LocalActions({ projectPath, historyDirectory, onPermission, ...options });
  return { actions, directory, projectPath, historyDirectory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function nodeCommand(script: string): string {
  return `"${process.execPath.replace(/"/g, '\\"')}" -e "${script.replace(/"/g, '\\"')}"`;
}

function commandLogId(text: string): string {
  const id = /Saved command log: ([a-f0-9-]{36})/.exec(text)?.[1];
  assert.ok(id, 'Every executed command must return its durable log identity.');
  return id;
}

function commandLogMetadata(text: string): { log_id: string; durable_id: string; output_complete: boolean; next_offset: number | null } {
  return JSON.parse(text.split('\n')[0]);
}

function frozenCommandOptions(run:{projectPath:string},controller:AbortController,command:string,cwd='.'){
  return {verificationCheckIds:['required-check'],frozenVerification:{turnId:'current-turn',requestHash:'a'.repeat(64),workspacePath:run.projectPath,signal:controller.signal,
    commands:[{id:'required-check',kind:'command' as const,command,cwd}]}};
}

test('run_verification uses exact frozen command/cwd through normal approval and real ledger receipts',async()=>{
  const run=await setup(),controller=new AbortController(),permissions:ActionPermission[]=[],events:any[]=[];
  try{
    await mkdir(path.join(run.projectPath,'nested'));await writeFile(path.join(run.projectPath,'source.txt'),'exact');
    await writeFile(path.join(run.projectPath,'nested','check.js'),"const fs=require('fs');if(fs.readFileSync('../source.txt','utf8')!=='exact')process.exit(7);process.stdout.write('verified');");
    const request='Verify the exact source.',command=`"${process.execPath}" "check.js"`,brief:TaskBrief={version:1,requestHash:createHash('sha256').update(request).digest('hex'),goal:request,deliverables:['source.txt'],criteria:[
      {id:'required-check',description:'actual script validates the source',kind:'command',command,cwd:'nested',paths:['source.txt','nested/check.js']},
      {id:'protected-script',description:'preserve the verifier',kind:'preserve_file',path:'nested/check.js'}]};
    const ledger=new TaskVerificationLedger(brief,run.projectPath);await ledger.captureProtectedInputs(request);
    const options=frozenCommandOptions(run,controller,command,'nested');options.frozenVerification.requestHash=brief.requestHash;
    const actions=new LocalActions({projectPath:run.projectPath,historyDirectory:run.historyDirectory,...options,
      onPermission:async permission=>{permissions.push(permission);return true;},onBeforeVerificationCommand:(id,args,signal)=>ledger.beforeVerificationCommand(id,args,signal),
      onTool:event=>{events.push(event);ledger.recordHostAction(event);}});
    const result=await actions.execute('run_verification',{check_id:'required-check'});
    assert.equal(result.isError,undefined);assert.equal(permissions.length,1);assert.equal(permissions[0].command,command);assert.equal(permissions[0].cwd,path.join(run.projectPath,'nested'));
    assert.equal(result.structuredContent?.operation,'run_command');assert.equal(result.structuredContent?.purpose,'verification');assert.deepEqual(result.structuredContent?.check_ids,['required-check']);
    const completed=events.find(event=>event.status==='completed');assert.equal(completed.input.command,command);assert.equal(completed.input.cwd,'nested');
    assert.deepEqual(completed.input.verification_intent.arguments,{check_id:'required-check'});assert.equal(completed.input.verification_intent.turnId,'current-turn');
    assert((await ledger.evaluate()).every(check=>check.status==='passed'));
    assert.equal(await readFile(path.join(run.projectPath,'source.txt'),'utf8'),'exact');
  }finally{controller.abort();await run.cleanup();}
});

test('frozen ID execution rejects overrides, unknown/file/manual IDs and spoofed host intent before approval',async()=>{
  const run=await setup(),controller=new AbortController();let approvals=0;
  try{
    const actions=new LocalActions({projectPath:run.projectPath,historyDirectory:run.historyDirectory,...frozenCommandOptions(run,controller,'exit 0'),onPermission:async()=>{approvals++;return true;}});
    for(const args of [{check_id:'unknown'},{check_id:'protected-script'},{check_id:'manual-review'},{check_id:['required-check']},
      {check_id:'required-check',command:'exit 0'},{check_id:'required-check',cwd:'.'},{check_id:'required-check',checkIds:['required-check']},
      {check_id:'required-check',purpose:'verification'},{check_id:'required-check',verification_intent:{}}]){
      const result=await actions.execute('run_verification',args);assert.equal(result.errorCode,'INVALID_ARGUMENT');assert.match(result.content[0].text,/required-check/);
    }
    const spoof=await actions.execute('run_command',{command:'exit 0',verification_intent:{tool:'run_verification'}});assert.equal(spoof.errorCode,'INVALID_ARGUMENT');assert.equal(approvals,0);
    const schema=ACTION_TOOL_SCHEMAS.find(tool=>tool.name==='run_verification')!;assert.deepEqual(schema.inputSchema.required,['check_id']);assert.equal(schema.inputSchema.additionalProperties,false);
  }finally{controller.abort();await run.cleanup();}
});

test('frozen command map is copied and stale task signals defeat fresh action signals and late approval',async()=>{
  const run=await setup(),controller=new AbortController();let approve:((value:boolean)=>void)|undefined;let requested=0;
  try{
    const options=frozenCommandOptions(run,controller,'echo exact > marker.txt');
    const actions=new LocalActions({projectPath:run.projectPath,historyDirectory:run.historyDirectory,...options,onPermission:async permission=>{assert.equal(permission.command,'echo exact > marker.txt');requested++;return new Promise(resolve=>{approve=resolve;});}});
    options.frozenVerification.commands[0].command='echo forged > marker.txt';options.verificationCheckIds[0]='other';
    const pending=actions.execute('run_verification',{check_id:'required-check'},{signal:new AbortController().signal});
    while(!approve)await new Promise(resolve=>setTimeout(resolve,1));controller.abort();approve(true);
    assert.equal((await pending).errorCode,'CANCELLED');assert.equal(requested,1);
    assert.equal((await actions.execute('run_verification',{check_id:'required-check'},{signal:new AbortController().signal})).errorCode,'CANCELLED');
    assert.equal(requested,1);assert.deepEqual(await readdir(run.projectPath),[]);
  }finally{controller.abort();await run.cleanup();}
});

test('frozen scope cannot bind another workspace or non-command criteria',async()=>{
  const run=await setup(),controller=new AbortController();
  try{
    const options=frozenCommandOptions(run,controller,'exit 0');
    for(const change of [{workspacePath:path.join(run.projectPath,'other')},{requestHash:'bad'},{commands:[{id:'required-check',kind:'manual',command:'exit 0',cwd:'.'}]},
      {commands:[...options.frozenVerification.commands,...options.frozenVerification.commands]}])
      assert.throws(()=>new LocalActions({projectPath:run.projectPath,historyDirectory:run.historyDirectory,...options,frozenVerification:{...options.frozenVerification,...change} as any,onPermission:async()=>true}));
  }finally{controller.abort();await run.cleanup();}
});

test('frozen ID commands retain terminal-disable and approved timeout bounds',async()=>{
  const run=await setup(),controller=new AbortController();let approvals=0;
  try{
    const options={projectPath:run.projectPath,historyDirectory:run.historyDirectory,...frozenCommandOptions(run,controller,'exit 0'),onPermission:async()=>{approvals++;return true;}};
    const disabled=new LocalActions({...options,utilities:{fileEditing:true,terminal:false}});
    assert.equal((await disabled.execute('run_verification',{check_id:'required-check'})).errorCode,'DISABLED_TOOL');
    const actions=new LocalActions(options);
    for(const timeout_ms of [0,99,600001,NaN,'100'])assert.equal((await actions.execute('run_verification',{check_id:'required-check',timeout_ms})).errorCode,'INVALID_TIMEOUT');
    assert.equal(approvals,0);
  }finally{controller.abort();await run.cleanup();}
});

test('denying a frozen ID command stops the current action host without replay or new approval',async()=>{
  const run=await setup(),controller=new AbortController();let approvals=0;let host:Awaited<ReturnType<typeof createActionHost>>|undefined;
  try{
    const actions=new LocalActions({projectPath:run.projectPath,historyDirectory:run.historyDirectory,...frozenCommandOptions(run,controller,'echo forbidden > marker.txt'),onPermission:async()=>{approvals++;return false;}});
    host=await createActionHost(actions,controller.signal);
    const call=async()=>await(await fetch(host!.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'run_verification',args:{check_id:'required-check'}})})).json();
    assert.equal((await call()).errorCode,'PERMISSION_DENIED');assert.equal((await call()).errorCode,'TURN_DENIED');assert.equal(approvals,1);assert.deepEqual(await readdir(run.projectPath),[]);
  }finally{controller.abort();if(host){await host.drain();host.server.closeAllConnections();await new Promise<void>(resolve=>host!.server.close(()=>resolve()));}await run.cleanup();}
});

test('a denied write or command performs no mutation', async () => {
  const run = await setup(async () => false);
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    assert.equal((await run.actions.execute('write_file', { path: 'app.txt', content: 'after' })).isError, true);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
    assert.equal((await run.actions.execute('run_command', { command: 'echo created > denied.txt' })).isError, true);
    assert.deepEqual(await readdir(run.projectPath), ['app.txt']);
    await assert.rejects(lstat(run.historyDirectory), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally { await run.cleanup(); }
});

test('the permission preview identifies the exact replacement', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async (permission) => { permissions.push(permission); return true; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'first\nbefore\nlast\n');
    const action = await run.actions.execute('edit_file', { path: 'app.txt', old_text: 'before', new_text: 'after' });
    assert.equal(action.isError, undefined);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'first\nafter\nlast\n');
    assert.match(permissions[0].preview!, /@@ -2,1 \+2,1 @@\n-before\n\+after$/);
    assert.equal(await run.actions.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'first\nbefore\nlast\n');
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('absolute and relative file proposals have the same checked approval target and preview', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return false; });
  try {
    const absolute = path.join(run.projectPath, 'stats.mjs');
    await writeFile(absolute, 'before\n');
    for (const tool of ['write_file', 'edit_file']) {
      const content = tool === 'write_file' ? { content: 'after\n' } : { old_text: 'before', new_text: 'after' };
      const relativeArgs = { path: 'stats.mjs', ...content };
      const absoluteArgs = { path: absolute, ...content };
      assert.equal((await run.actions.execute(tool, relativeArgs)).errorCode, 'PERMISSION_DENIED');
      assert.equal((await run.actions.execute(tool, absoluteArgs)).errorCode, 'PERMISSION_DENIED');
      const [relativePermission, absolutePermission] = permissions.slice(-2);
      assert.deepEqual(absolutePermission.arguments, relativePermission.arguments);
      assert.deepEqual(absolutePermission.arguments, relativeArgs);
      assert.equal(absolutePermission.preview, relativePermission.preview);
      assert.equal(absolutePermission.title, relativePermission.title);
      assert.equal(absolutePermission.workspacePath, run.projectPath);
      assert.equal(absoluteArgs.path, absolute, 'Canonical approval must not rewrite the raw tool intent.');
    }
    assert.equal(await readFile(absolute, 'utf8'), 'before\n');
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('a canonical relative allowlist approves an absolute target with verified evidence, no repeat mutation and undo', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => {
    permissions.push(permission);
    return permission.arguments.path === 'stats.mjs';
  });
  try {
    const absolute = path.join(run.projectPath, 'stats.mjs');
    await writeFile(absolute, 'before\n');
    const expectedHash = createHash('sha256').update('after\n').digest('hex');
    const written = await run.actions.execute('write_file', { path: absolute, content: 'after\n' });
    assert.equal(written.isError, undefined);
    assert.equal(written.structuredContent?.path, 'stats.mjs');
    assert.equal(written.structuredContent?.sha256, expectedHash);
    assert.equal(await readFile(absolute, 'utf8'), 'after\n');
    const repeated = await run.actions.execute('write_file', { path: 'stats.mjs', content: 'after\n' });
    assert.equal(repeated.structuredContent?.changed, false);
    assert.equal(repeated.structuredContent?.sha256, expectedHash);
    assert.equal(permissions.length, 1, 'An already completed mutation is not repeated or approved again.');
    const snapshots = await readdir(run.historyDirectory);
    assert.equal(snapshots.length, 1);
    const snapshot = JSON.parse(await readFile(path.join(run.historyDirectory, snapshots[0]), 'utf8'));
    assert.equal(snapshot.projectPath, run.projectPath);
    assert.equal(snapshot.relativePath, 'stats.mjs');
    assert.equal(snapshot.afterHash, expectedHash);
    assert.equal(await run.actions.undo(), 1);
    assert.equal(await readFile(absolute, 'utf8'), 'before\n');
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('batch approvals canonicalize every validated absolute or relative path and retain grouped undo', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => {
    permissions.push(permission);
    return JSON.stringify(permission.arguments.files) === JSON.stringify([
      { path: 'src/first.mjs', content: 'first\n' }, { path: 'src/second.mjs', content: 'second\n' },
    ]);
  });
  try {
    const rawFiles = [{ path: path.join(run.projectPath, 'src/first.mjs'), content: 'first\n' }, { path: './src/second.mjs', content: 'second\n' }];
    const created = await run.actions.execute('create_files', { files: rawFiles });
    assert.equal(created.isError, undefined);
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].workspacePath, run.projectPath);
    assert.deepEqual(created.structuredContent?.files, [
      { path: 'src/first.mjs', changed: true, sha256: createHash('sha256').update('first\n').digest('hex'), bytes: 6 },
      { path: 'src/second.mjs', changed: true, sha256: createHash('sha256').update('second\n').digest('hex'), bytes: 7 },
    ]);
    assert.equal(rawFiles[0].path, path.join(run.projectPath, 'src/first.mjs'));
    assert.equal(rawFiles[1].path, './src/second.mjs');
    assert.equal(await run.actions.undo(), 2);
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('canonicalization does not admit outside prefix lookalikes, escapes, symlinks, or credential paths', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const outside = path.join(run.directory, 'project-other');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.mjs'), 'keep\n');
    await mkdir(path.join(run.projectPath, 'actual'));
    await symlink(outside, path.join(run.projectPath, 'outward'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(run.projectPath, 'actual'), path.join(run.projectPath, 'inward'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(outside, 'keep.mjs'), path.join(run.projectPath, 'linked.mjs'));
    const forbidden = [
      [path.join(outside, 'keep.mjs'), 'OUTSIDE_PROJECT'],
      ['../project-other/keep.mjs', 'OUTSIDE_PROJECT'],
      [run.projectPath, 'OUTSIDE_PROJECT'],
      [path.join(run.projectPath, 'outward/keep.mjs'), 'SYMLINK_PATH'],
      [path.join(run.projectPath, 'inward/new.mjs'), 'SYMLINK_PATH'],
      [path.join(run.projectPath, 'linked.mjs'), 'SYMLINK_PATH'],
      [path.join(run.projectPath, '.env'), 'PROTECTED_PATH'],
      [path.join(run.projectPath, '.git/config'), 'PROTECTED_PATH'],
    ];
    for (const [file, code] of forbidden) {
      assert.equal((await run.actions.execute('write_file', { path: file, content: 'changed\n' })).errorCode, code, file);
      assert.equal((await run.actions.execute('create_files', { files: [{ path: 'safe.mjs', content: 'safe\n' }, { path: file, content: 'changed\n' }] })).errorCode, code, file);
    }
    assert.equal(approvals, 0);
    assert.equal(await readFile(path.join(outside, 'keep.mjs'), 'utf8'), 'keep\n');
    await assert.rejects(lstat(path.join(run.projectPath, 'safe.mjs')), { code: 'ENOENT' });
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('absolute target approval still rejects a changed input hash and a swapped parent', async () => {
  for (const change of ['content', 'parent']) {
    let run: Awaited<ReturnType<typeof setup>>;
    run = await setup(async permission => {
      assert.equal(permission.arguments.path, 'src/stats.mjs');
      if (change === 'content') await writeFile(path.join(run.projectPath, 'src/stats.mjs'), 'user version\n');
      else {
        await rm(path.join(run.projectPath, 'src'), { recursive: true });
        await symlink(path.join(run.directory, 'outside'), path.join(run.projectPath, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      return true;
    });
    try {
      await mkdir(path.join(run.projectPath, 'src'));
      await mkdir(path.join(run.directory, 'outside'));
      await writeFile(path.join(run.directory, 'outside/stats.mjs'), 'outside version\n');
      await writeFile(path.join(run.projectPath, 'src/stats.mjs'), 'before\n');
      const written = await run.actions.execute('write_file', { path: path.join(run.projectPath, 'src/stats.mjs'), content: 'agent version\n' });
      assert.equal(written.errorCode, change === 'content' ? 'STALE_PREVIEW' : 'SYMLINK_PATH');
      assert.equal(await readFile(path.join(run.projectPath, 'src/stats.mjs'), 'utf8'), change === 'content' ? 'user version\n' : 'outside version\n');
      assert.equal(await readFile(path.join(run.directory, 'outside/stats.mjs'), 'utf8'), 'outside version\n');
      assert.equal(await run.actions.undo(), 0);
      await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
    } finally { await run.cleanup(); }
  }
});

test('canonical file names retain exact deny policies and workspace-scoped approval grants', async () => {
  const deniedPermissions: ActionPermission[] = [];
  const run = await setup(async permission => { deniedPermissions.push(permission); return permission.arguments.path === 'stats.mjs'; });
  try {
    await writeFile(path.join(run.projectPath, 'check.mjs'), 'immutable checks\n');
    assert.equal((await run.actions.execute('write_file', { path: path.join(run.projectPath, 'check.mjs'), content: 'weakened checks\n' })).errorCode, 'PERMISSION_DENIED');
    assert.equal(deniedPermissions[0].arguments.path, 'check.mjs');
    assert.equal(await readFile(path.join(run.projectPath, 'check.mjs'), 'utf8'), 'immutable checks\n');
    const policies = grantApprovalPolicy([], run.projectPath, 'fileEditing');
    const approve = async (permission: ActionPermission) => Boolean(permission.workspacePath && permission.utility && hasApprovalPolicy(policies, permission.workspacePath, permission.utility));
    const granted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: approve });
    assert.equal((await granted.execute('write_file', { path: path.join(run.projectPath, 'stats.mjs'), content: 'granted\n' })).isError, undefined);
    const otherProject = path.join(run.directory, 'project-other');
    await mkdir(otherProject);
    const other = new LocalActions({ projectPath: otherProject, historyDirectory: path.join(run.directory, 'other-history'), onPermission: approve });
    assert.equal((await other.execute('write_file', { path: path.join(otherProject, 'stats.mjs'), content: 'denied\n' })).errorCode, 'PERMISSION_DENIED');
    assert.deepEqual(await readdir(otherProject), []);
    assert.equal(await granted.undo(), 1);
  } finally { await run.cleanup(); }
});

test('external changes while approval is pending make the proposed edit stale', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => { await writeFile(path.join(run.projectPath, 'app.txt'), 'user changed it'); return true; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const action = await run.actions.execute('write_file', { path: 'app.txt', content: 'agent version' });
    assert.equal(action.isError, true);
    assert.match(action.content[0].text, /changed while approval/);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'user changed it');
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('path traversal, Git internals, keys, and environment files are blocked before approval', async () => {
  let requests = 0;
  const run = await setup(async () => { requests++; return true; });
  try {
    for (const file of ['../outside.txt', '.git/config', '.env', '.env.production', 'auth/token.json', 'id_ed25519', 'certificate.pem']) {
      assert.equal((await run.actions.execute('write_file', { path: file, content: 'blocked' })).isError, true, file);
    }
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await run.cleanup(); }
});

test('symlink files and parent directories cannot escape the project', async () => {
  const run = await setup();
  try {
    const outside = path.join(run.directory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await symlink(outside, path.join(run.projectPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(outside, 'keep.txt'), path.join(run.projectPath, 'keep.txt'));
    assert.equal((await run.actions.execute('write_file', { path: 'linked/keep.txt', content: 'changed' })).isError, true);
    assert.equal((await run.actions.execute('write_file', { path: 'keep.txt', content: 'changed' })).isError, true);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { await run.cleanup(); }
});

test('a swapped parent symlink is caught after approval', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => {
    await rm(path.join(run.projectPath, 'src'), { recursive: true });
    await symlink(path.join(run.directory, 'outside'), path.join(run.projectPath, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  });
  try {
    await mkdir(path.join(run.projectPath, 'src'));
    await mkdir(path.join(run.directory, 'outside'));
    const action = await run.actions.execute('write_file', { path: 'src/new.txt', content: 'changed' });
    assert.equal(action.isError, true);
    assert.deepEqual(await readdir(path.join(run.directory, 'outside')), []);
  } finally { await run.cleanup(); }
});

test('undo removes created files and preserves later external modifications', async () => {
  const run = await setup();
  try {
    assert.equal((await run.actions.execute('write_file', { path: 'nested/new.txt', content: 'created' })).isError, undefined);
    assert.equal(await run.actions.undo(), 1);
    await assert.rejects(lstat(path.join(run.projectPath, 'nested/new.txt')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    await writeFile(path.join(run.projectPath, 'app.txt'), 'initial');
    await run.actions.execute('write_file', { path: 'app.txt', content: 'agent version' });
    await writeFile(path.join(run.projectPath, 'app.txt'), 'user version');
    assert.equal(await run.actions.undo(), 0);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'user version');
  } finally { await run.cleanup(); }
});

test('undo can restore snapshots in a new service instance', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    await run.actions.execute('write_file', { path: 'app.txt', content: 'after' });
    const restarted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: async () => false });
    assert.equal(await restarted.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
  } finally { await run.cleanup(); }
});

test('UTF-8 byte order marks survive exact replacements and undo', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'bom.txt'), '\ufeffbefore\n');
    assert.equal((await run.actions.execute('edit_file', { path: 'bom.txt', old_text: 'before', new_text: 'after' })).isError, undefined);
    assert.equal(await readFile(path.join(run.projectPath, 'bom.txt'), 'utf8'), '\ufeffafter\n');
    assert.equal(await run.actions.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'bom.txt'), 'utf8'), '\ufeffbefore\n');
  } finally { await run.cleanup(); }
});

test('exact edits preserve literal prefixes, CRLF, Unicode and trailing newlines with verified evidence', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const initial = '\ufeff1: literal prefix\r\nسلام 🌍 projects.\r\n\r\n';
    const final = '\ufeff1: literal prefix\r\nسلام 🌍 tools.\r\n\r\n';
    const created = await run.actions.execute('write_file', { path: 'exact.txt', content: initial });
    assert.equal(created.structuredContent?.changed, true);
    const edited = await run.actions.execute('edit_file', { path: 'exact.txt', old_text: 'projects.', new_text: 'tools.' });
    assert.equal(edited.isError, undefined);
    assert.deepEqual(await readFile(path.join(run.projectPath, 'exact.txt')), Buffer.from(final));
    const digest = createHash('sha256').update(Buffer.from(final)).digest('hex');
    assert.equal(edited.structuredContent?.sha256, digest);
    assert.equal(edited.structuredContent?.status, 'changed');
    assert.equal(edited.structuredContent?.bytes, Buffer.byteLength(final));
    assert.deepEqual(JSON.parse(edited.content[0].text.split('\n')[0]), edited.structuredContent);
    const unchanged = await run.actions.execute('write_file', { path: 'exact.txt', content: final });
    assert.equal(unchanged.structuredContent?.changed, false);
    assert.equal(unchanged.structuredContent?.status, 'unchanged');
    assert.equal(unchanged.structuredContent?.sha256, digest);
    assert.equal(approvals, 2, 'An already-correct file requires no mutation or approval.');
    assert.equal((await readdir(run.historyDirectory)).filter(name => name.endsWith('.json')).length, 2);
  } finally { await run.cleanup(); }
});

test('two identical failed edits stop further mutations without stripping prefixes or bypassing approval', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'exact.txt'), 'already correct\n');
    const args = { path: 'exact.txt', old_text: '1: already correct', new_text: 'changed' };
    const first = await run.actions.execute('edit_file', args);
    assert.equal(first.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(first.structuredContent?.attempts, 1);
    const second = await run.actions.execute('edit_file', args);
    assert.equal(second.errorCode, 'REPEATED_EDIT_FAILED');
    assert.equal(second.structuredContent?.attempts, 2);
    assert.equal(second.structuredContent?.changed, false);
    for (const [tool, input] of [
      ['edit_file', { path: 'exact.txt', old_text: 'already correct', new_text: 'changed' }],
      ['write_file', { path: 'exact.txt', content: 'changed' }],
      ['create_files', { files: [{ path: 'bypass.txt', content: 'changed' }] }],
      ['run_command', { command: 'echo changed > bypass.txt' }],
    ] as const) assert.equal((await run.actions.execute(tool, input)).errorCode, 'EDIT_LOOP_STOPPED');
    assert.equal(await readFile(path.join(run.projectPath, 'exact.txt'), 'utf8'), 'already correct\n');
    assert.deepEqual(await readdir(run.projectPath), ['exact.txt']);
    assert.equal(approvals, 0);
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
    assert.equal(await run.actions.undo(), 0, 'The user-owned undo path remains available after an edit-loop stop.');
  } finally { await run.cleanup(); }
});

test('failed edit tracking keys the actual file digest and permits a corrected action before two identical failures', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'exact.txt'), 'original\n');
    const args = { path: 'exact.txt', old_text: 'missing', new_text: 'changed' };
    assert.equal((await run.actions.execute('edit_file', args)).errorCode, 'TEXT_NOT_FOUND');
    await writeFile(path.join(run.projectPath, 'exact.txt'), 'externally changed\n');
    assert.equal((await run.actions.execute('edit_file', args)).errorCode, 'TEXT_NOT_FOUND', 'Changed input is a new attempt, not a repeated failure.');
    const corrected = await run.actions.execute('edit_file', { path: 'exact.txt', old_text: 'externally changed', new_text: 'verified' });
    assert.equal(corrected.isError, undefined);
    assert.equal(await readFile(path.join(run.projectPath, 'exact.txt'), 'utf8'), 'verified\n');
    assert.equal(approvals, 1);
  } finally { await run.cleanup(); }
});

test('manual undo can restore completed changes after a later edit-loop stop', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'exact.txt'), 'before');
    await run.actions.execute('write_file', { path: 'exact.txt', content: 'completed' });
    const args = { path: 'exact.txt', old_text: 'missing', new_text: 'no' };
    await run.actions.execute('edit_file', args);
    assert.equal((await run.actions.execute('edit_file', args)).errorCode, 'REPEATED_EDIT_FAILED');
    assert.equal(await run.actions.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'exact.txt'), 'utf8'), 'before');
  } finally { await run.cleanup(); }
});

test('exact replacements allow newline-only matches and reject empty matches or lossy Unicode', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'exact.txt'), 'text\n');
    const edited = await run.actions.execute('edit_file', { path: 'exact.txt', old_text: '\n', new_text: '\r\n' });
    assert.equal(edited.isError, undefined);
    assert.equal(await readFile(path.join(run.projectPath, 'exact.txt'), 'utf8'), 'text\r\n');
    assert.equal((await run.actions.execute('edit_file', { path: 'exact.txt', old_text: '', new_text: 'insert' })).errorCode, 'INVALID_ARGUMENT');
    assert.equal((await run.actions.execute('write_file', { path: 'lossy.txt', content: '\ud800' })).errorCode, 'INVALID_ARGUMENT');
    assert.equal(approvals, 1);
    assert.deepEqual(await readdir(run.projectPath), ['exact.txt']);
  } finally { await run.cleanup(); }
});

test('literal newline spellings give a diagnostic after an exact mismatch without decoding or mutating', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const actual = 'first\nsecond\n';
    const args = { path: 'exact.txt', old_text: 'first\\nsecond\\n', new_text: 'changed' };
    await writeFile(path.join(run.projectPath, 'exact.txt'), actual);
    const unchangedDigest = createHash('sha256').update(actual, 'utf8').digest('hex');
    const first = await run.actions.execute('edit_file', args);
    assert.equal(first.errorCode, 'TEXT_NOT_FOUND');
    assert.match(first.content[0].text, /literal backslash escape spellings/);
    assert.match(first.content[0].text, /Copy the actual read_file.text string value/);
    assert.match(first.content[0].text, /unique exact short substring/);
    assert.match(first.content[0].text, /never decodes.*no change was made/);
    assert.equal(first.structuredContent?.input_sha256, unchangedDigest);
    assert.equal(first.structuredContent?.changed, false);
    assert.equal(first.structuredContent?.attempts, 1);
    assert.equal(args.old_text, 'first\\nsecond\\n', 'Diagnostic generation must preserve every argument verbatim.');
    const second = await run.actions.execute('edit_file', args);
    assert.equal(second.errorCode, 'REPEATED_EDIT_FAILED');
    assert.equal(second.structuredContent?.attempts, 2);
    assert.equal(second.structuredContent?.input_sha256, unchangedDigest);
    assert.equal(await readFile(path.join(run.projectPath, 'exact.txt'), 'utf8'), actual);
    assert.equal(approvals, 0);
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('matching literal JavaScript escape text is replaced exactly and never interpreted as a newline', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return true; });
  try {
    const initial = "process.stdout.write('before\\n');\n";
    const final = "process.stdout.write('after\\n');\n";
    const args = { path: 'literal.mjs', old_text: 'before\\n', new_text: 'after\\n' };
    await writeFile(path.join(run.projectPath, 'literal.mjs'), initial);
    const edited = await run.actions.execute('edit_file', args);
    assert.equal(edited.isError, undefined);
    assert.equal(edited.structuredContent?.changed, true);
    assert.equal(await readFile(path.join(run.projectPath, 'literal.mjs'), 'utf8'), final);
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].arguments.old_text, 'before\\n');
    assert.equal(permissions[0].arguments.new_text, 'after\\n');
    assert.equal(edited.structuredContent?.sha256, createHash('sha256').update(final, 'utf8').digest('hex'));
  } finally { await run.cleanup(); }
});

test('ambiguous text, binary, invalid UTF-8, large files, and private key content are rejected', async () => {
  const run = await setup();
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'same same');
    assert.equal((await run.actions.execute('edit_file', { path: 'app.txt', old_text: 'same', new_text: 'new' })).isError, true);
    await writeFile(path.join(run.projectPath, 'binary.txt'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(run.projectPath, 'utf8.txt'), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(run.projectPath, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    await writeFile(path.join(run.projectPath, 'private.txt'), '-----BEGIN PRIVATE KEY-----\nsecret');
    for (const file of ['binary.txt', 'utf8.txt', 'large.txt', 'private.txt']) assert.equal((await run.actions.execute('write_file', { path: file, content: 'changed' })).isError, true, file);
  } finally { await run.cleanup(); }
});

test('approved commands run in the exact reviewed directory and capture output', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async (permission) => { permissions.push(permission); return true; });
  try {
    await mkdir(path.join(run.projectPath, 'sub'));
    const command = process.platform === 'win32' ? 'echo approved' : 'printf approved';
    const action = await run.actions.execute('run_command', { command, cwd: 'sub' });
    assert.equal(action.isError, undefined);
    assert.match(action.content[0].text, /approved/);
    assert.equal(permissions[0].command, command);
    assert.equal(permissions[0].cwd, path.join(run.projectPath, 'sub'));
    assert.equal((await run.actions.execute('run_command', { command, cwd: '../' })).isError, true);
  } finally { await run.cleanup(); }
});

test('commands can be cancelled and are stopped at the configured time limit', async () => {
  const run = await setup();
  try {
    const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const controller = new AbortController();
    const started = Date.now();
    const pending = run.actions.execute('run_command', { command }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const cancelled = await pending;
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.content[0].text, /cancelled/);
    assert.ok(Date.now() - started < 5000);
    const timed = await run.actions.execute('run_command', { command, timeout_ms: 100 });
    assert.equal(timed.isError, true);
    assert.match(timed.content[0].text, /time limit/);
    assert.equal(timed.errorCode, 'COMMAND_TIMEOUT');
    assert.equal(timed.content[1].text, commandTimeoutText);
    const timedRecord = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(timed.content[0].text)}.json`), 'utf8'));
    assert.equal(timedRecord.state, 'interrupted'); assert.equal(timedRecord.timeoutMs, 100); assert.equal(timedRecord.errorCode, 'COMMAND_TIMEOUT');
  } finally { await run.cleanup(); }
});

test('commands require valid explicit bounds while omitted timeout retains its reviewed 60 second default', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return true; });
  try {
    for (const timeout_ms of [99, 600001, 1.5, NaN, Infinity, null, '600000']) {
      const rejected = await run.actions.execute('run_command', { command: 'echo forbidden', timeout_ms });
      assert.equal(rejected.errorCode, 'INVALID_TIMEOUT');
    }
    assert.equal(permissions.length, 0);
    const defaultCommand = await run.actions.execute('run_command', { command: 'exit 0' });
    assert.equal(defaultCommand.isError, undefined);
    assert.equal(permissions[0].arguments.timeout_ms, commandTimeoutLimits.default);
    const defaultRecord = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(defaultCommand.content[0].text)}.json`), 'utf8'));
    assert.equal(defaultRecord.timeoutMs, 60000); assert.equal(defaultRecord.state, 'completed');
    const longCommand = await run.actions.execute('run_command', { command: 'exit 0', timeout_ms: 600000 });
    assert.equal(longCommand.isError, undefined); assert.equal(permissions[1].arguments.timeout_ms, 600000);
    const longRecord = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(longCommand.content[0].text)}.json`), 'utf8'));
    assert.equal(longRecord.timeoutMs, 600000); assert.equal(longRecord.state, 'completed');
    const schema = ACTION_TOOL_SCHEMAS.find(item => item.name === 'run_command')!;
    assert.equal(schema.inputSchema.properties.timeout_ms.minimum, 100);
    assert.equal(schema.inputSchema.properties.timeout_ms.maximum, 600000);
    assert.equal(schema.inputSchema.properties.timeout_ms.default, 60000);
  } finally { await run.cleanup(); }
});

test('explicit 10 minute dependency commands still cancel promptly and preserve partial work without replay', async () => {
  const run = await setup(); const controller = new AbortController();
  try {
    const command = process.platform === 'win32' ? 'echo EXECUTED>>count.txt & ping -n 30 127.0.0.1 >nul' : "printf 'EXECUTED\\n' >> count.txt; sleep 30";
    const pending = run.actions.execute('run_command', { command, timeout_ms: 600000 }, { signal: controller.signal });
    for (let index = 0; index < 100; index++) {
      if (await readFile(path.join(run.projectPath, 'count.txt'), 'utf8').catch(() => '')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await readFile(path.join(run.projectPath, 'count.txt'), 'utf8')).trim(), 'EXECUTED');
    const stoppedAt = Date.now(); controller.abort();
    const output = await pending;
    assert.equal(output.isError, true); assert.equal(output.errorCode, 'COMMAND_INTERRUPTED');
    assert.ok(Date.now() - stoppedAt < 5000);
    const record = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${commandLogId(output.content[0].text)}.json`), 'utf8'));
    assert.equal(record.state, 'interrupted'); assert.equal(record.timeoutMs, 600000);
    const reopened = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: async () => { throw new Error('No automatic replay approval expected.'); } });
    assert.equal((await reopened.execute('read_command_output', { id: record.id })).isError, undefined);
    assert.equal((await readFile(path.join(run.projectPath, 'count.txt'), 'utf8')).trim(), 'EXECUTED');
  } finally { controller.abort(); await run.cleanup(); }
});

test('cancellation stops an owned descendant that ignores SIGTERM after its shell closes', { skip: process.platform === 'win32' }, async () => {
  const run = await setup();
  const controller = new AbortController();
  let descendantPid: number | undefined;
  let outputPromise: ReturnType<LocalActions['execute']> | undefined;
  const isRunning = async (pid: number) => {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
    if (process.platform === 'linux') {
      // A killed child adopted by a container's init may briefly be a zombie.
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!status || /^\d+ \(.+\) Z /.test(status)) return false;
    }
    return true;
  };
  try {
    const descendant = "process.on('SIGTERM',()=>{});require('fs').writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)";
    const command = nodeCommand(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setTimeout(()=>{},30000)`);
    outputPromise = run.actions.execute('run_command', { command }, { signal: controller.signal });
    const readyDeadline = Date.now() + 5000;
    while (Date.now() < readyDeadline) {
      const raw = await readFile(path.join(run.projectPath, 'descendant.pid'), 'utf8').catch(() => '');
      if (raw) { descendantPid = Number(raw); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(descendantPid && Number.isSafeInteger(descendantPid));
    assert.equal(await isRunning(descendantPid!), true);
    const stoppedAt = Date.now();
    controller.abort();
    const output = await outputPromise;
    assert.equal(output.isError, true);
    assert.ok(Date.now() - stoppedAt < 5000, 'Cancellation cleanup must remain bounded.');
    const cleanupDeadline = Date.now() + 2000;
    while (await isRunning(descendantPid!) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await isRunning(descendantPid!), false, 'Stop must also terminate the ignored-SIGTERM descendant.');
    const id = commandLogId(output.content[0].text);
    assert.equal(JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${id}.json`), 'utf8')).state, 'interrupted');
  } finally {
    controller.abort();
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
    await outputPromise;
    await run.cleanup();
  }
});

test('cancellation while approval is pending prevents a late approval from executing', async () => {
  let approve!: (value: boolean) => void;
  const waiting = new Promise<boolean>((resolve) => { approve = resolve; });
  const run = await setup(async () => waiting);
  try {
    const controller = new AbortController();
    const pending = run.actions.execute('write_file', { path: 'new.txt', content: 'late' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).isError, true);
    approve(true);
    assert.deepEqual(await readdir(run.projectPath), []);
  } finally { await run.cleanup(); }
});

test('cancellation after edit approval prevents the final project write and leaves no applied undo entry', async () => {
  const controller = new AbortController();
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, {
    onTool: event => { if (event.status === 'running') controller.abort(); },
  });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const output = await run.actions.execute('write_file', { path: 'app.txt', content: 'after' }, { signal: controller.signal });
    assert.equal(approvals, 1);
    assert.equal(output.isError, true);
    assert.match(output.content[0].text, /cancelled/);
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
    assert.deepEqual(await readdir(run.projectPath), ['app.txt']);
    const snapshots = (await readdir(run.historyDirectory)).filter(name => name.endsWith('.json'));
    assert.equal(snapshots.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(run.historyDirectory, snapshots[0]), 'utf8')).applied, false);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('cancellation after command approval records interruption without spawning the command', async () => {
  const controller = new AbortController();
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, {
    onTool: event => { if (event.status === 'running') controller.abort(); },
  });
  try {
    const command = nodeCommand("require('fs').writeFileSync('should-not-exist.txt','ran')");
    const output = await run.actions.execute('run_command', { command }, { signal: controller.signal });
    assert.equal(approvals, 1);
    assert.equal(output.isError, true);
    assert.match(output.content[0].text, /cancelled/);
    assert.deepEqual(await readdir(run.projectPath), []);
    const logDirectory = path.join(run.historyDirectory, 'command-logs');
    const records = (await readdir(logDirectory)).filter(name => name.endsWith('.json'));
    assert.equal(records.length, 1);
    const record = JSON.parse(await readFile(path.join(logDirectory, records[0]), 'utf8'));
    assert.equal(record.state, 'interrupted');
    assert.equal(record.command, command);
    assert.equal((await lstat(path.join(logDirectory, `${record.id}.log`))).size, 0);
  } finally { await run.cleanup(); }
});

test('command output is retained with a bounded preview and unsuccessful exits report an error', async () => {
  const run = await setup();
  try {
    const failed = await run.actions.execute('run_command', { command: 'exit 7' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /code 7/);
    const output = await run.actions.execute('run_command', { command: nodeCommand("process.stdout.write('x'.repeat(200000))") });
    assert.equal(output.isError, undefined);
    assert.match(output.content[0].text, /Excerpt only/);
    assert.ok(Buffer.byteLength(output.content[0].text) < 2500);
    const id = commandLogId(output.content[0].text);
    assert.equal((await lstat(path.join(run.historyDirectory, 'command-logs', `${id}.log`))).size, 200000);
  } finally { await run.cleanup(); }
});

test('the saved command log stops at its 64 MiB resource cap', async () => {
  const run = await setup();
  try {
    const output = await run.actions.execute('run_command', { command: nodeCommand("process.stdout.write('x'.repeat(67*1024*1024))") });
    assert.equal(output.isError, true);
    assert.match(output.content[0].text, /64 MB saved-log limit/);
    const id = commandLogId(output.content[0].text);
    assert.equal((await lstat(path.join(run.historyDirectory, 'command-logs', `${id}.log`))).size, 64 * 1024 * 1024);
    assert.ok(Buffer.byteLength(output.content[0].text) < 2500);
    const record = JSON.parse(await readFile(path.join(run.historyDirectory, 'command-logs', `${id}.json`), 'utf8'));
    assert.equal(record.state, 'interrupted');
    assert.equal(record.errorCode, 'COMMAND_INTERRUPTED');
  } finally { await run.cleanup(); }
});

test('paged UTF-8 command output is complete and reading it never reruns execution', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, { resultChars: 501 });
  try {
    const original = '😀سلامabc'.repeat(1500);
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('execution-count.txt','x');process.stdout.write('😀سلامabc'.repeat(1500))") });
    assert.equal(output.isError, undefined);
    const durableId = commandLogId(output.content[0].text);
    const metadata = commandLogMetadata(output.content[0].text);
    assert.equal(metadata.log_id, `log-${durableId.slice(0, 8)}`);
    assert.equal(metadata.durable_id, durableId);
    assert.equal(metadata.output_complete, false);
    assert.ok(metadata.next_offset! > 0 && metadata.next_offset! <= 501);
    const initial = Buffer.from(original).subarray(0, metadata.next_offset!).toString('utf8');
    assert.ok(output.content[0].text.includes(initial));
    assert.ok(!output.content[0].text.includes('\ufffd'), 'The initial excerpt must end at a complete UTF-8 character.');
    let offset: number | null = metadata.next_offset;
    const excerpts: string[] = [initial];
    while (offset !== null) {
      const response = await run.actions.execute('read_command_output', { id: metadata.log_id, offset });
      assert.equal(response.isError, undefined);
      const excerpt = JSON.parse(response.content[0].text) as { id: string; durable_id: string; offset: number; text: string; next_offset: number | null; size: number };
      assert.equal(excerpt.id, metadata.log_id);
      assert.equal(excerpt.durable_id, durableId);
      assert.equal(excerpt.offset, offset);
      assert.ok(Buffer.byteLength(excerpt.text) <= 501);
      assert.ok(!excerpt.text.includes('\ufffd'), 'UTF-8 characters cannot be lost at pagination boundaries.');
      if (excerpt.next_offset !== null) assert.ok(excerpt.next_offset > offset);
      excerpts.push(excerpt.text);
      offset = excerpt.next_offset;
    }
    assert.equal(excerpts.join(''), original);
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'execution-count.txt'), 'utf8'), 'x');
  } finally { await run.cleanup(); }
});

test('complete command output exposes a short durable log reference without requesting another read', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('count.txt','x');process.stdout.write('complete output')") });
    assert.equal(output.isError, undefined);
    const metadata = commandLogMetadata(output.content[0].text);
    assert.deepEqual(metadata, { ok: true, operation: 'run_command', log_id: `log-${metadata.durable_id.slice(0, 8)}`, durable_id: commandLogId(output.content[0].text), output_complete: true, next_offset: null, exit_code: 0, exit_signal: null });
    assert.match(output.content[0].text, /complete output/);
    assert.match(output.content[0].text, /no log read is needed/);
    assert.doesNotMatch(output.content[0].text, /Read remaining output|Use read_command_output/);
    const reopened = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory,
      onPermission: async () => { approvals++; return false; } });
    for (const id of [metadata.log_id, metadata.durable_id]) {
      const saved = await reopened.execute('read_command_output', { id });
      assert.equal(saved.isError, undefined);
      assert.equal(JSON.parse(saved.content[0].text).text, 'complete output');
    }
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'count.txt'), 'utf8'), 'x');
  } finally { await run.cleanup(); }
});

test('short command-log references reject unknown, foreign-chat, edit, malformed, and traversal identities', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const foreignLogs = path.join(run.directory, 'another-chat', 'command-logs');
    await mkdir(foreignLogs, { recursive: true });
    await writeFile(path.join(foreignLogs, 'a1b2c3d4-0000-4000-8000-000000000000.log'), 'foreign chat output');
    const edited = await run.actions.execute('write_file', { path: 'file.txt', content: 'kept' });
    assert.equal(edited.isError, undefined);
    const editId = (await readdir(run.historyDirectory)).find(name => name.endsWith('.json'))!.slice(0, -5);
    for (const id of ['log-a1b2c3d4', `log-${editId.slice(0, 8)}`]) {
      const missing = await run.actions.execute('read_command_output', { id });
      assert.equal(missing.errorCode, 'COMMAND_LOG_NOT_FOUND');
      assert.ok(!JSON.stringify(missing).includes('foreign chat output'));
    }
    for (const id of ['log-a1b2c3d', 'log-a1b2c3d4extra', '../another-chat/command-logs/a1b2c3d4-0000-4000-8000-000000000000.log', 'log-../../']) {
      assert.equal((await run.actions.execute('read_command_output', { id })).errorCode, 'INVALID_ARGUMENT');
    }
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'file.txt'), 'utf8'), 'kept');
  } finally { await run.cleanup(); }
});

test('colliding short log handles require exact UUIDs and never choose or rerun a command', async () => {
  let approvals = 0;
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => { approvals++; return true; }, { onTool: event => {
    if (event.status !== 'running' || event.title !== 'Run command') return;
    const logs = path.join(run.historyDirectory, 'command-logs');
    mkdirSync(logs, { recursive: true });
    const tail = event.id.slice(8) === '-0000-4000-8000-000000000000' ? '-0000-4000-8000-000000000001' : '-0000-4000-8000-000000000000';
    writeFileSync(path.join(logs, `${event.id.slice(0, 8)}${tail}.log`), 'other saved command');
  } });
  try {
    const output = await run.actions.execute('run_command', { command: nodeCommand("require('fs').appendFileSync('count.txt','x');process.stdout.write('original output')") });
    assert.equal(output.isError, undefined);
    const metadata = commandLogMetadata(output.content[0].text);
    assert.equal(metadata.log_id, metadata.durable_id, 'A collision must return the full durable identity.');
    const ambiguous = await run.actions.execute('read_command_output', { id: `log-${metadata.durable_id.slice(0, 8)}` });
    assert.equal(ambiguous.errorCode, 'COMMAND_LOG_AMBIGUOUS');
    assert.match(ambiguous.content[0].text, /Use the exact durable UUID/);
    const exact = await run.actions.execute('read_command_output', { id: metadata.durable_id });
    assert.equal(exact.isError, undefined);
    assert.equal(JSON.parse(exact.content[0].text).text, 'original output');
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(run.projectPath, 'count.txt'), 'utf8'), 'x');
  } finally { await run.cleanup(); }
});

test('file edit IDs and missing command logs give actionable guidance without exposing internal paths', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'app.txt'), 'before');
    const edited = await run.actions.execute('edit_file', { path: 'app.txt', old_text: 'before', new_text: 'after' });
    assert.equal(edited.isError, undefined);
    const editSnapshot = (await readdir(run.historyDirectory)).find(name => name.endsWith('.json'));
    assert.ok(editSnapshot);
    const editId = editSnapshot.slice(0, -5);
    for (const id of [editId, '00000000-0000-4000-8000-000000000000']) {
      const response = await run.actions.execute('read_command_output', { id });
      assert.equal(response.isError, true);
      assert.equal(response.errorCode, 'COMMAND_LOG_NOT_FOUND');
      assert.match(response.content[0].text, /Do not retry the same id/);
      assert.match(response.content[0].text, /log id returned by run_command/);
      assert.match(response.content[0].text, /use read_file to verify edited files/);
      assert.ok(!response.content[0].text.includes(run.historyDirectory));
      assert.ok(!response.content[0].text.includes('ENOENT'));
    }
    const invalid = await run.actions.execute('read_command_output', { id: 'invented-id' });
    assert.equal(invalid.errorCode, 'INVALID_ARGUMENT');
    assert.match(invalid.content[0].text, /exact saved command log UUID returned by run_command/);
    assert.equal(approvals, 1, 'Reading a nonexistent log never asks for another action approval.');
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'after');
    assert.equal(await run.actions.undo(), 1, 'The successful edit and its undo remain intact.');
    assert.equal(await readFile(path.join(run.projectPath, 'app.txt'), 'utf8'), 'before');
  } finally { await run.cleanup(); }
});

test('two reads of a creation action ID stop the turn without repeating its completed files or requesting a command', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const created = await run.actions.execute('create_files', { files: [{ path: 'verified.txt', content: 'created once\n' }] });
    const id = created.structuredContent?.action_id;
    assert.equal(typeof id, 'string');
    const first = await run.actions.execute('read_command_output', { id });
    assert.equal(first.errorCode, 'COMMAND_LOG_NOT_FOUND');
    assert.equal(first.structuredContent?.attempts, 1);
    const second = await run.actions.execute('read_command_output', { id, offset: 0 });
    assert.equal(second.errorCode, 'REPEATED_LOG_READ_FAILED');
    assert.equal(second.content[0].text, repeatedCommandReadFailureText);
    assert.equal(second.structuredContent?.attempts, 2);
    assert.equal(second.structuredContent?.availability_sha256, first.structuredContent?.availability_sha256);
    for (const [tool, args] of [
      ['read_command_output', { id }], ['run_command', { command: 'echo replay > replay.txt' }],
      ['write_file', { path: 'replay.txt', content: 'no' }],
      ['create_files', { files: [{ path: 'replay.txt', content: 'no' }] }],
    ] as const) assert.equal((await run.actions.execute(tool, args)).errorCode, 'LOG_READ_LOOP_STOPPED');
    assert.equal(approvals, 1);
    assert.deepEqual(await readdir(run.projectPath), ['verified.txt']);
    assert.equal(await readFile(path.join(run.projectPath, 'verified.txt'), 'utf8'), 'created once\n');
    assert.equal(await run.actions.undo(), 1, 'Manual undo stays available after the read-loop stop.');
  } finally { await run.cleanup(); }
});

test('malformed log arguments do not count as missing-log retries and existing logs remain repeatably readable', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    const absent = '00000000-0000-4000-8000-000000000000';
    for (let attempt = 0; attempt < 4; attempt++) {
      assert.equal((await run.actions.execute('read_command_output', { id: 'malformed-id' })).errorCode, 'INVALID_ARGUMENT');
      assert.equal((await run.actions.execute('read_command_output', { id: absent, offset: -1 })).errorCode, 'INVALID_ARGUMENT');
    }
    assert.equal((await run.actions.execute('read_command_output', { id: absent })).errorCode, 'COMMAND_LOG_NOT_FOUND');
    const executed = await run.actions.execute('run_command', { command: nodeCommand("process.stdout.write('valid saved output')") });
    assert.equal(executed.isError, undefined);
    const metadata = commandLogMetadata(executed.content[0].text);
    for (let attempt = 0; attempt < 5; attempt++) {
      const read = await run.actions.execute('read_command_output', { id: metadata.durable_id.toUpperCase() });
      assert.equal(read.isError, undefined);
      assert.equal(JSON.parse(read.content[0].text).text, 'valid saved output');
    }
    assert.equal((await run.actions.execute('run_command', { command: nodeCommand("process.stdout.write('another valid command')") })).isError, undefined);
    assert.equal(approvals, 2, 'Read errors and valid log reads never request action approval.');
  } finally { await run.cleanup(); }
});

test('relevant log availability changes reset failure counting and successful reads clear previous missing references', async () => {
  const run = await setup();
  try {
    const prefix = 'a1b2c3d4';
    const handle = `log-${prefix}`;
    const logDirectory = path.join(run.historyDirectory, 'command-logs');
    const firstId = `${prefix}-0000-4000-8000-000000000001`;
    const secondId = `${prefix}-0000-4000-8000-000000000002`;
    const thirdId = `${prefix}-0000-4000-8000-000000000003`;
    assert.equal((await run.actions.execute('read_command_output', { id: handle })).structuredContent?.attempts, 1);
    await mkdir(logDirectory, { recursive: true });
    await writeFile(path.join(logDirectory, `${firstId}.log`), 'first');
    await writeFile(path.join(logDirectory, `${secondId}.log`), 'second');
    const ambiguous = await run.actions.execute('read_command_output', { id: handle });
    assert.equal(ambiguous.errorCode, 'COMMAND_LOG_AMBIGUOUS');
    assert.equal(ambiguous.structuredContent?.attempts, 1, 'An availability change is a fresh observation.');
    await rm(path.join(logDirectory, `${secondId}.log`));
    await writeFile(path.join(logDirectory, `${thirdId}.log`), 'third');
    assert.equal((await run.actions.execute('read_command_output', { id: handle })).structuredContent?.attempts, 1);
    await rm(path.join(logDirectory, `${thirdId}.log`));
    assert.equal(JSON.parse((await run.actions.execute('read_command_output', { id: handle })).content[0].text).text, 'first');
    await rm(path.join(logDirectory, `${firstId}.log`));
    const missingAgain = await run.actions.execute('read_command_output', { id: handle });
    assert.equal(missingAgain.errorCode, 'COMMAND_LOG_NOT_FOUND');
    assert.equal(missingAgain.structuredContent?.attempts, 1, 'The successful intervening read cleared the earlier failure.');
  } finally { await run.cleanup(); }
});

test('disabled host utilities refuse edits, commands, and logs before approval', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; }, { utilities: { fileEditing: false, terminal: false } });
  try {
    for (const [name, args] of [
      ['write_file', { path: 'new.txt', content: 'disabled' }],
      ['create_files', { files: [{ path: 'new.txt', content: 'disabled' }] }],
      ['edit_file', { path: 'new.txt', old_text: 'old', new_text: 'new' }],
      ['run_command', { command: 'echo disabled' }],
      ['read_command_output', { id: '00000000-0000-0000-0000-000000000000' }],
    ] as const) {
      const response = await run.actions.execute(name, args);
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /disabled/i);
    }
    assert.equal(approvals, 0);
    assert.deepEqual(await readdir(run.projectPath), []);
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('an empty project can create a reviewed WordPress theme and verify it with an approved command', async () => {
  const permissions: ActionPermission[] = [];
  const run = await setup(async permission => { permissions.push(permission); return true; });
  const theme = 'wp-content/themes/local-agent';
  const files = [
    { path: `${theme}/style.css`, content: '/*\nTheme Name: Local Agent\nVersion: 1.0.0\n*/\n' },
    { path: `${theme}/index.php`, content: '<?php get_header(); ?>\n<main><?php if (have_posts()) : while (have_posts()) : the_post(); the_title(); the_content(); endwhile; endif; ?></main>\n<?php get_footer(); ?>\n' },
    { path: `${theme}/functions.php`, content: "<?php\nadd_action('after_setup_theme', function () { add_theme_support('title-tag'); });\n" },
  ];
  try {
    assert.deepEqual(await readdir(run.projectPath), []);
    const created = await run.actions.execute('create_files', { files });
    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent?.changed, true);
    assert.deepEqual(created.structuredContent?.files, files.map(file => ({ path: file.path, changed: true,
      sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'), bytes: Buffer.byteLength(file.content, 'utf8') })));
    assert.deepEqual(JSON.parse(created.content[0].text.split('\n')[0]), created.structuredContent);
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].title, 'Create 3 project files');
    for (const file of files) {
      assert.ok(permissions[0].preview!.includes(`+++ ${file.path}`));
      assert.equal(await readFile(path.join(run.projectPath, file.path), 'utf8'), file.content);
    }
    const command = process.platform === 'win32' ? 'if exist functions.php (echo SCAFFOLD_OK) else (exit /b 1)' : 'test -f functions.php && test -f index.php && test -f style.css && printf SCAFFOLD_OK';
    const verified = await run.actions.execute('run_command', { command, cwd: theme });
    assert.equal(verified.isError, undefined);
    assert.match(verified.content[0].text, /SCAFFOLD_OK/);
    assert.equal(permissions.length, 2);
    assert.equal(permissions[1].cwd, path.join(run.projectPath, theme));
    assert.equal(await run.actions.undo(), 3, 'One undo reverses the complete reviewed creation batch.');
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('a denied creation batch makes no files, parent folders, or undo snapshots', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return false; });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/index.php', content: '<?php echo 1;' }, { path: 'theme/style.css', content: 'body {}' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /denied/);
    assert.equal(approvals, 1);
    assert.deepEqual(await readdir(run.projectPath), []);
    await assert.rejects(lstat(run.historyDirectory), { code: 'ENOENT' });
  } finally { await run.cleanup(); }
});

test('invalid, protected, existing and conflicting batch paths reject before approval', async () => {
  let approvals = 0;
  const run = await setup(async () => { approvals++; return true; });
  try {
    await writeFile(path.join(run.projectPath, 'existing.txt'), 'keep');
    for (const files of [
      [],
      [{ path: '../outside.php', content: 'denied' }],
      [{ path: '.env', content: 'denied' }],
      [{ path: 'existing.txt', content: 'replacement' }],
      [{ path: 'theme', content: 'file' }, { path: 'theme/index.php', content: 'file' }],
      [{ path: 'same.txt', content: 'first' }, { path: './same.txt', content: 'second' }],
      [{ path: 'private.txt', content: '-----BEGIN PRIVATE KEY-----\nsecret' }],
      [{ path: 'large.txt', content: 'x'.repeat(512 * 1024 + 1) }],
      Array.from({ length: 21 }, (_, index) => ({ path: `${index}.txt`, content: 'text' })),
    ]) assert.equal((await run.actions.execute('create_files', { files })).isError, true);
    assert.equal(approvals, 0);
    assert.deepEqual(await readdir(run.projectPath), ['existing.txt']);
    assert.equal(await readFile(path.join(run.projectPath, 'existing.txt'), 'utf8'), 'keep');
  } finally { await run.cleanup(); }
});

test('a stale batch approval preserves an externally created file and writes no other batch files', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => { await writeFile(path.join(run.projectPath, 'second.txt'), 'user version'); return true; });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'nested/first.txt', content: 'agent first' }, { path: 'second.txt', content: 'agent second' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /appeared while approval/);
    assert.deepEqual(await readdir(run.projectPath), ['second.txt']);
    assert.equal(await readFile(path.join(run.projectPath, 'second.txt'), 'utf8'), 'user version');
  } finally { await run.cleanup(); }
});

test('cancelling an approved creation batch rolls back completed files and empty new folders', async () => {
  const controller = new AbortController();
  let creating = 0;
  const run = await setup(async () => true, { onTool: event => {
    if (event.status === 'running' && event.title.startsWith('Create ')) {
      creating++;
      if (creating === 2) controller.abort();
    }
  } });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/first.php', content: '<?php echo 1;' }, { path: 'theme/second.php', content: '<?php echo 2;' }] }, { signal: controller.signal });
    assert.equal(creating, 2);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /cancelled/);
    assert.deepEqual(await readdir(run.projectPath), []);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('batch undo works after service restart and preserves externally edited files', async () => {
  const run = await setup();
  try {
    await run.actions.execute('create_files', { files: [{ path: 'theme/first.php', content: '<?php echo 1;' }, { path: 'theme/second.php', content: '<?php echo 2;' }] });
    await writeFile(path.join(run.projectPath, 'theme/first.php'), 'user edit');
    const restarted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory, onPermission: async () => false });
    assert.equal(await restarted.undo(), 1);
    assert.equal(await readFile(path.join(run.projectPath, 'theme/first.php'), 'utf8'), 'user edit');
    assert.deepEqual(await readdir(path.join(run.projectPath, 'theme')), ['first.php']);
    assert.equal(await restarted.undo(), 0);
  } finally { await run.cleanup(); }
});

test('exclusive batch publication cannot overwrite a file created after its last preflight', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => true, { onTool: event => {
    if (event.status === 'running' && event.title === 'Create theme/index.php') writeFileSync(path.join(run.projectPath, 'theme/index.php'), 'user raced creation');
  } });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/index.php', content: '<?php echo 1;' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /No existing file was overwritten/);
    assert.equal(await readFile(path.join(run.projectPath, 'theme/index.php'), 'utf8'), 'user raced creation');
    assert.deepEqual(await readdir(path.join(run.projectPath, 'theme')), ['index.php']);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('cancelled batch rollback preserves an external edit to an already created file', async () => {
  const controller = new AbortController();
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => true, { onTool: event => {
    if (event.status === 'running' && event.title === 'Create theme/second.php') {
      writeFileSync(path.join(run.projectPath, 'theme/first.php'), 'external edit during creation');
      controller.abort();
    }
  } });
  try {
    const response = await run.actions.execute('create_files', { files: [{ path: 'theme/first.php', content: '<?php echo 1;' }, { path: 'theme/second.php', content: '<?php echo 2;' }] }, { signal: controller.signal });
    assert.equal(response.isError, true);
    assert.equal(await readFile(path.join(run.projectPath, 'theme/first.php'), 'utf8'), 'external edit during creation');
    assert.deepEqual(await readdir(path.join(run.projectPath, 'theme')), ['first.php']);
    assert.equal(await run.actions.undo(), 0);
  } finally { await run.cleanup(); }
});

test('batch creation rejects swapped symlink parents and a replaced project root', async () => {
  let run: Awaited<ReturnType<typeof setup>>;
  run = await setup(async () => {
    await mkdir(path.join(run.directory, 'outside'));
    await symlink(path.join(run.directory, 'outside'), path.join(run.projectPath, 'theme'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  });
  try {
    assert.equal((await run.actions.execute('create_files', { files: [{ path: 'theme/index.php', content: '<?php echo 1;' }] })).isError, true);
    assert.deepEqual(await readdir(path.join(run.directory, 'outside')), []);
    await rm(run.projectPath, { recursive: true });
    await symlink(path.join(run.directory, 'outside'), run.projectPath, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await run.actions.execute('create_files', { files: [{ path: 'new.php', content: '<?php echo 1;' }] });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /selected project folder changed/i);
    assert.deepEqual(await readdir(path.join(run.directory, 'outside')), []);
  } finally { await run.cleanup(); }
});

test('cancelled commands retain interruption records across service restart without replay', async () => {
  const run = await setup(async () => true);
  const controller = new AbortController();
  let outputPromise: ReturnType<LocalActions['execute']> | undefined;
  try {
    const command = nodeCommand("require('fs').appendFileSync('execution-count.txt','x');process.stdout.write('saved before interruption');setTimeout(()=>{},30000)");
    outputPromise = run.actions.execute('run_command', { command }, { signal: controller.signal });
    const logDirectory = path.join(run.historyDirectory, 'command-logs');
    const deadline = Date.now() + 5000;
    let record: { id: string; command: string; state: string } | undefined;
    let logReady = false;
    while (Date.now() < deadline) {
      const records = await readdir(logDirectory).catch(() => []);
      const name = records.find(name => name.endsWith('.json'));
      if (name) {
        record = JSON.parse(await readFile(path.join(logDirectory, name), 'utf8'));
        const text = await readFile(path.join(logDirectory, `${record!.id}.log`), 'utf8').catch(() => '');
        if (text.includes('saved before interruption')) { logReady = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(record, 'The started command must be recorded durably before completion.');
    assert.equal(record!.state, 'started');
    assert.ok(logReady, 'Partial output must be durable while the command is running.');
    controller.abort();
    const output = await outputPromise;
    assert.equal(output.isError, true);
    const id = commandLogId(output.content[0].text);
    assert.equal(JSON.parse(await readFile(path.join(logDirectory, `${id}.json`), 'utf8')).state, 'interrupted');
    let approvals = 0;
    const restarted = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory,
      onPermission: async () => { approvals++; return true; } });
    const saved = await restarted.execute('read_command_output', { id, offset: 0 });
    assert.equal(saved.isError, undefined);
    assert.match(JSON.parse(saved.content[0].text).text, /saved before interruption/);
    assert.equal(approvals, 0);
    assert.equal(await readFile(path.join(run.projectPath, 'execution-count.txt'), 'utf8'), 'x');
  } finally { controller.abort(); await outputPromise; await run.cleanup(); }
});


test('readback effects begin before pending approval and settle after success, denial and cancellation', async () => {
  const run = await setup();
  try {
    for (const decision of ['approved', 'denied', 'cancelled'] as const) {
      const order: string[] = [], effects: { id: string; operation: string; phase: string }[] = [], controller = new AbortController();
      const actions = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory,
        onReadbackEffect: event => { effects.push(event); order.push(event.phase); }, onTool: event => { order.push(event.status); },
        onPermission: async (_permission, signal) => {
          order.push('permission'); assert.equal(effects.length, 1); assert.equal(effects[0].phase, 'begin');
          if (decision === 'cancelled') { controller.abort(new Error('User cancelled')); assert.equal(signal?.aborted, true); }
          return decision === 'approved';
        } });
      const result = await actions.execute('write_file', { path: `${decision}.txt`, content: 'exact\n' }, { signal: controller.signal });
      assert.deepEqual(effects.map(event => event.phase), ['begin', 'settled']);
      assert.equal(effects[0].id, effects[1].id); assert.equal(effects[0].operation, 'write_file');
      assert.equal(order[0], 'begin'); assert.equal(order.at(-1), 'settled'); assert(order.indexOf('begin') < order.indexOf('pending'));
      if (decision === 'approved') assert.equal(result.isError, undefined);
      else { assert.equal(result.isError, true); await assert.rejects(lstat(path.join(run.projectPath, `${decision}.txt`)), { code: 'ENOENT' }); }
    }
  } finally { await run.cleanup(); }
});

test('readback invalidation includes queued edits and undo but excludes retained command-output reads', async () => {
  const run = await setup(), effects: { id: string; operation: string; phase: string }[] = [];
  try {
    let release!: (approved: boolean) => void, permissionStarted!: () => void;
    const awaitingPermission = new Promise<void>(resolve => { permissionStarted = resolve; });
    const actions = new LocalActions({ projectPath: run.projectPath, historyDirectory: run.historyDirectory,
      onReadbackEffect: event => effects.push(event), onPermission: async () => new Promise<boolean>(resolve => { release = resolve; permissionStarted(); }) });
    const pending = actions.execute('write_file', { path: 'queued.txt', content: 'after\n' });
    // The BEFORE-effect callback is synchronous, including while approval has not yet started.
    assert.equal(effects[0].phase, 'begin');
    await awaitingPermission;
    const undo = actions.undo(); assert.deepEqual(effects.slice(0, 2).map(event => [event.operation, event.phase]), [['write_file', 'begin'], ['undo', 'begin']]);
    release(true); await pending; assert.equal(await undo, 1);
    assert.deepEqual(effects.filter(event => event.operation === 'undo').map(event => event.phase), ['begin', 'settled']);
    await assert.rejects(lstat(path.join(run.projectPath, 'queued.txt')), { code: 'ENOENT' });
    const count = effects.length;
    const missing = await actions.execute('read_command_output', { log_id: 'not-a-log' }); assert.equal(missing.isError, true); assert.equal(effects.length, count);
    const cancelled = new AbortController(); cancelled.abort();
    await actions.execute('edit_file', { path: 'none.txt', old_text: 'a', new_text: 'b' }, { signal: cancelled.signal });
    assert.deepEqual(effects.slice(count).map(event => event.phase), ['begin', 'settled']);
  } finally { await run.cleanup(); }
});

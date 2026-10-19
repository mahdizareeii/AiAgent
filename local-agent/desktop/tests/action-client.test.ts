import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { invokeLocalAction } from '../action-client.ts';
import { createActionHost } from '../action-host.ts';
import { LocalActions } from '../actions.ts';
import { cancelledActionResult } from '../backend.ts';
import { actionRequestAbortedText, actionRequestDeadlines, actionRequestTimeoutText, actionResponseInterruptedText } from '../action-protocol.ts';

test('frozen ID requests retain the command deadline through delayed approval while file actions keep their normal deadline', {timeout:5000}, async context=>{
  const nativeSetTimeout=globalThis.setTimeout,scheduled:number[]=[];
  // Compress only the client's long deadlines. Real HTTP, approvals, cancellation
  // and command execution still run; a normal-deadline ID call expires too early.
  context.mock.method(globalThis,'setTimeout',((callback:any,delay:number,...args:any[])=>{
    if(delay===actionRequestDeadlines.normal||delay===actionRequestDeadlines.command){scheduled.push(delay);return nativeSetTimeout(callback,delay===actionRequestDeadlines.command?600:40,...args);}
    return nativeSetTimeout(callback,delay,...args);
  }) as typeof setTimeout);
  for(const tool of ['run_command','run_verification','write_file']){
    const directory=await realpath(await mkdtemp(path.join(tmpdir(),'local-agent-id-client-deadline-'))),projectPath=path.join(directory,'project'),controller=new AbortController();
    await mkdir(projectPath);let approvals=0;
    const actions=new LocalActions({projectPath,historyDirectory:path.join(directory,'history'),verificationCheckIds:['required-check'],
      frozenVerification:{turnId:'deadline-turn',requestHash:'a'.repeat(64),workspacePath:projectPath,signal:controller.signal,commands:[{id:'required-check',kind:'command',command:'exit 0',cwd:'.'}]},
      onBeforeVerificationCommand:async()=>{},onPermission:async()=>{approvals++;await new Promise<void>(resolve=>nativeSetTimeout(resolve,100));return true;}});
    const host=await createActionHost(actions,controller.signal);
    try{
      const args=tool==='run_command'?{command:'exit 0'}:tool==='run_verification'?{check_id:'required-check'}:{path:'forbidden.txt',content:'no'};
      if(tool==='write_file'){await assert.rejects(invokeLocalAction(host.url,tool,args),{message:actionRequestTimeoutText});await host.drain();assert.deepEqual(await readdir(projectPath),[]);}
      else{const result=await invokeLocalAction(host.url,tool,args);assert.equal(result.isError,undefined);assert.equal(result.structuredContent.operation,'run_command');assert.equal(result.structuredContent.exit_code,0);}
      assert.equal(approvals,1);
    }finally{controller.abort();await host.drain();host.server.closeAllConnections();await new Promise<void>(resolve=>host.server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
  }
  assert.deepEqual(scheduled,[actionRequestDeadlines.command,actionRequestDeadlines.command,actionRequestDeadlines.normal]);
});

test('native action client keeps an approval pending until its explicit deadline then cancels it', { timeout: 5000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-client-test-')));
  const projectPath = path.join(directory, 'project'); await mkdir(projectPath);
  const controller = new AbortController();
  let shown!: () => void, aborted!: () => void, approve!: (answer: boolean) => void;
  let approvals = 0;
  const permissionShown = new Promise<void>(resolve => { shown = resolve; });
  const permissionAborted = new Promise<void>(resolve => { aborted = resolve; });
  const actions = new LocalActions({ projectPath, historyDirectory: path.join(directory, 'history'), onPermission: (_permission, signal) => {
    approvals++; assert.ok(signal); signal.addEventListener('abort', aborted, { once: true });
    shown(); return new Promise<boolean>(resolve => { approve = resolve; });
  } });
  const host = await createActionHost(actions, controller.signal);
  try {
    assert.equal(actionRequestDeadlines.normal, 15 * 60_000);
    assert.equal(actionRequestDeadlines.command, 25 * 60_000);
    const pending = invokeLocalAction(host.url, 'run_command', { command: 'echo forbidden > deadline.txt', timeout_ms: 600000 }, undefined, 200);
    const rejection = assert.rejects(pending, { message: actionRequestTimeoutText });
    await permissionShown;
    assert.equal(approvals, 1);
    await rejection; await permissionAborted; await host.drain();
    approve(true); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(await readdir(projectPath), []);
    const repeated = await invokeLocalAction(host.url, 'write_file', { path: 'deadline.txt', content: 'retry' });
    assert.equal(repeated.errorCode, 'TURN_CANCELLED');
    assert.equal(approvals, 1);
  } finally {
    controller.abort(); await host.drain(); host.server.closeAllConnections();
    await new Promise<void>(resolve => host.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('native action client rejects a cancelled caller before opening a connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(invokeLocalAction(`http://127.0.0.1:1/${'a'.repeat(64)}`, 'write_file', {}, controller.signal), { message: actionRequestAbortedText });
  await assert.rejects(invokeLocalAction('https://example.com/actions', 'write_file', {}), /app-owned action endpoint/);
});

test('unconfirmed responses produce an owned interruption error and are never retried', { timeout: 5000 }, async () => {
  for (const mode of ['reset', 'partial', 'invalid', 'invalid-utf8', 'null', 'empty', 'invalid-content', 'oversized', 'unavailable'] as const) {
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the complete proposal */ }
      requests++;
      if (mode === 'reset') { response.destroy(); return; }
      if (mode === 'unavailable') { response.writeHead(503).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode === 'partial') {
        response.write('{"content":[');
        setImmediate(() => response.destroy());
      } else if (mode === 'oversized') response.end('x'.repeat(3 * 1024 * 1024 + 1));
      else if (mode === 'null') response.end('null');
      else if (mode === 'empty') response.end('{}');
      else if (mode === 'invalid-content') response.end('{"content":[{"type":"text","text":42}]}');
      else if (mode === 'invalid-utf8') response.end(Buffer.concat([Buffer.from('{"content":[{"type":"text","text":"'), Buffer.from([0xff]), Buffer.from('"}]}')]));
      else response.end('not-json');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      let captured: Error | undefined;
      await assert.rejects(invokeLocalAction(`http://127.0.0.1:${address.port}/${'a'.repeat(64)}`, 'run_command', { command: 'proposed once' }), (error: Error) => {
        captured = error; return error.message === actionResponseInterruptedText;
      });
      assert.ok(captured?.cause instanceof Error, 'Retain the transport diagnostic separately.');
      assert.equal(cancelledActionResult({ type: 'text', text: captured?.message }), true);
      assert.equal(requests, 1, `${mode} must never cause an automatic retry.`);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

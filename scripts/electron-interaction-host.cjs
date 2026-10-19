// Test-only bootstrap, excluded from packaged files. Runs the real bundled
// host, sandboxed preload and renderer. Native pickers are stubbed; the optional
// owner projection below is explicitly a renderer-routing simulation, not a task.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = process.cwd();
const profile = app.commandLine.getSwitchValue('user-data-dir');
const appPath = app.commandLine.getSwitchValue('interaction-app');
const reportPath = app.commandLine.getSwitchValue('interaction-report');
const phase = app.commandLine.getSwitchValue('interaction-phase');
if (!profile || !profile.includes('agent-electron-interaction-')) throw new Error('An isolated temporary test profile is required.');
app.setAppPath(appPath);
const packaged = appPath.endsWith('.asar');
if (packaged) {
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.dirname(appPath) });
}
const picks = [];
dialog.showOpenDialog = async () => {
  if (!picks.length) throw new Error('Unexpected native picker: test did not provide a result.');
  const files = picks.shift(); return { canceled: files === null, filePaths: files ?? [] };
};
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let owner;
let ownerProjection;
let holdNextDraft = false;
let heldDraft;
let heldCloseRecord;
let quitEvents = 0;
let closeEvents = 0;
let flushAcknowledgements = 0;
const undoCalls = [];
app.on('before-quit', () => { quitEvents++; });
const realHandle = ipcMain.handle.bind(ipcMain);
// Test-only interception at the real main IPC boundary. Every mutation still
// reaches its production handler; no renderer bridge method is replaced.
ipcMain.handle = (channel, listener) => realHandle(channel, async (event, ...args) => {
  if (channel === 'local-agent:undo') undoCalls.push(args[0]);
  if (channel === 'local-agent:saveDraft' && holdNextDraft) {
    holdNextDraft = false;
    return new Promise((resolve, reject) => {
      heldDraft = { value: args[0], release: async () => {
        try {
          const result = await listener(event, ...args);
          assert.equal(result.saved, true);
          const persisted = JSON.parse(await fs.readFile(path.join(profile, 'chats.json'), 'utf8'));
          const session = persisted.sessions.find(row => row.id === args[0].sessionId);
          assert.equal(session?.draft, args[0].draft);
          assert.equal(session?.draftRevision, args[0].revision);
          const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
          report.expectedDraft = args[0].draft;
          report.heldCloseRegression = { ...heldCloseRecord, actualHostDraftPersistedBeforeAcknowledgement: true, persistedRevision: session.draftRevision, status: 'awaiting-real-relaunch' };
          await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
          resolve(result);
        } catch (error) { reject(error); }
      } };
    });
  }
  const result = await listener(event, ...args);
  if (channel === 'local-agent:draftsFlushed') flushAcknowledgements++;
  const projected = ownerProjection;
  if (!projected) return result;
  if (['local-agent:status', 'local-agent:navigate', 'local-agent:back'].includes(channel)) return { ...result, activeSessionId: projected.sessionId, activeTurnId: projected.turnId };
  if (channel === 'local-agent:approvals' && args[0] === projected.sessionId) return { sessionId: projected.sessionId, turnId: projected.turnId, revision: projected.revision, pending: projected.pending ? [projected.request] : [] };
  if (channel === 'local-agent:respondPermission') {
    projected.response = args[0]; projected.actualResponse = result;
    // The real registry must reject this synthetic, never-registered request.
    assert.equal(result.status, 'expired');
    projected.pending = false; projected.revision++;
  }
  if (channel === 'local-agent:cancel') projected.cancelledSessionId = args[0];
  return result;
});
async function js(source) {
  let result;
  try { result = await owner.webContents.executeJavaScript(`(async()=>{try{return await (${source});}catch(error){return {__testError:String(error.stack||error)};}})()`, true); }
  catch (error) { throw new Error(`Renderer script execution failed: ${error.stack || error}\nSource: ${source}`, { cause: error }); }
  if (result?.__testError) throw new Error(`${result.__testError}\nSource: ${source}`);
  return result;
}
async function waitFor(source, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await js(source)) return; await delay(25); }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await js('document.body.innerText.slice(-5000)'))}`);
}
async function click(selector) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Control is covered: '+${JSON.stringify(selector)});return{x,y};})()`);
  owner.focus(); owner.webContents.focus();
  owner.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  owner.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
}
async function text(selector, value) {
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
const status = () => js('window.localAgent.status()');
async function current(id) { await waitFor(`document.querySelector('[data-session-id="${id}"]')?.classList.contains('selected')`, `conversation ${id}`); }
async function closeModels() {
  if (await js(`!!document.querySelector('[aria-label="Close setup"]')`)) await click('[aria-label="Close setup"]');
  await waitFor(`!document.querySelector('[aria-label="Close setup"]')`, 'model dialog closed');
}
async function waitHost(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (predicate()) return; await delay(10); }
  throw new Error(`Timed out waiting for main-process ${label}`);
}

async function backgroundOwnerSimulation(a, b) {
  await click(`[data-session-id="${b}"]`); await current(b);
  const turnId = randomUUID(), requestId = randomUUID();
  const actual = await status(); assert.equal(actual.activeSessionId, undefined, 'This coverage must not accidentally run a real task.');
  ownerProjection = { sessionId: a, turnId, revision: 1, pending: false,
    request: { requestId, turnId, revision: 2, title: 'SIMULATED owner-routing approval', arguments: { path: 'simulation-only.txt' } } };
  owner.webContents.send('local-agent:event', { type: 'status' });
  await waitFor('!!document.querySelector("[data-testid=running-task-open]")', 'simulated background owner banner');
  assert.equal((await status()).navigation.current.sessionId, b, 'A background owner must not navigate the viewed conversation.');
  assert.equal(await js(`document.querySelector('[aria-label="Send message"]').disabled`), true);
  assert.equal(await js('document.querySelector("[data-testid=composer]").disabled'), false, 'Idle conversation drafts remain editable.');
  await text('[data-testid=composer]', 'Draft B while simulated owner A runs');
  await click('[data-testid=running-task-open]'); await current(a);
  assert.equal(await js('document.querySelector("[data-testid=composer]").disabled'), true);
  await click(`[data-session-id="${b}"]`); await current(b);
  ownerProjection.pending = true; ownerProjection.revision = 2;
  owner.webContents.send('local-agent:event', { type: 'permission', sessionId: a, ...ownerProjection.request });
  await waitFor('!document.querySelector(".permission-dialog")', 'background approval leaves viewed chat accessible');
  assert.equal(ownerProjection.response, undefined, 'Browsing never settles an approval.');
  await click('[data-testid=running-task-open]'); await current(a);
  await waitFor('document.querySelector("#permission-title")?.textContent.includes("SIMULATED")', 'simulated owner approval');
  await click('[data-testid=approval-browse]');
  await waitFor('!document.querySelector(".permission-dialog")', 'explicit Browse leaves approval pending');
  assert.equal(ownerProjection.pending, true); assert.equal(ownerProjection.response, undefined);
  await click(`[data-session-id="${b}"]`); await current(b);
  await click('[data-testid=running-task-open]'); await current(a);
  await waitFor('!!document.querySelector(".permission-dialog")', 'return reopens the same pending approval');
  await js('Array.from(document.querySelectorAll(".permission-dialog button")).find(e=>e.textContent==="Deny").setAttribute("data-testid","approval-deny-test")');
  await click('[data-testid=approval-deny-test]');
  await waitHost(() => !!ownerProjection.response, 'owner-bound denial IPC');
  assert.equal(ownerProjection.response.sessionId, a); assert.equal(ownerProjection.response.turnId, turnId);
  assert.equal(ownerProjection.response.requestId, requestId); assert.equal(ownerProjection.response.approved, false);
  await waitFor('!document.querySelector(".permission-dialog")', 'expired synthetic request cleared');
  await click('[data-testid=running-task-stop]'); await waitHost(() => !!ownerProjection.cancelledSessionId, 'owner-bound Stop IPC');
  assert.equal(ownerProjection.cancelledSessionId, a);
  const evidence = { coverage: 'SIMULATION: main IPC status/approval projection and event injection; no live host task, model, effect or real permission request', actualPreloadAndRenderer: true,
    viewedSessionId: b, simulatedOwnerSessionId: a, denialTarget: ownerProjection.response, actualRegistryResponse: ownerProjection.actualResponse,
    stopTarget: ownerProjection.cancelledSessionId, realHostCancellationEffect: 'none; no active host task existed', pointerHitTesting: true, pendingApprovalBrowseAndReturn: true, backgroundApprovalDoesNotCaptureViewedChat: true };
  ownerProjection = undefined; owner.webContents.send('local-agent:event', { type: 'status' });
  await waitFor('!document.querySelector("[data-testid=running-task-stop]")', 'simulation cleared');
  await click(`[data-session-id="${a}"]`); await current(a);
  return evidence;
}

async function heldClose() {
  const saved = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  await current(saved.finalSessionId);
  const before = flushAcknowledgements;
  holdNextDraft = true;
  await text('[data-testid=composer]', 'Held close — newer exact\n');
  app.quit();
  await waitHost(() => !!heldDraft, 'held real draft save');
  assert.equal(heldDraft.value.sessionId, saved.finalSessionId);
  assert.equal(heldDraft.value.draft, 'Held close — newer exact\n');
  app.quit(); owner.close(); app.quit();
  await delay(175);
  assert.equal(owner.isDestroyed(), false, 'Repeated Quit/Close must not destroy a window before persistence acknowledgement.');
  assert.equal(flushAcknowledgements, before, 'Renderer must await the held real save before acknowledging.');
  heldCloseRecord = { coverage: 'Real production quit/close guards and persistence, with only one real saveDraft handler invocation delayed by test bootstrap',
    repeatedQuitAndCloseRequests: true, quitEventsBeforeRelease: quitEvents, closeEventsBeforeRelease: closeEvents,
    windowAliveWhileSaveHeld: true, flushAcknowledgementsWhileSaveHeld: 0, heldSessionId: saved.finalSessionId, expectedDraft: heldDraft.value.draft };
  await heldDraft.release();
}
function gguf(name) {
  const u32 = n => { const b=Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = n => { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = s => Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
  const entry = (k,v) => Buffer.concat([str(k),u32(8),str(v)]);
  const h = Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(3),entry('general.architecture','llama'),entry('general.name',name),entry('tokenizer.chat_template','{{messages|tojson}}'),str('token_embd.weight'),u32(2),u64(8),u64(1),u32(0),u64(0)]);
  return Buffer.concat([h,Buffer.alloc((32-h.length%32)%32),Buffer.alloc(32)]);
}
async function test() {
  await waitFor('!!window.localAgent && !!document.querySelector("[data-testid=composer]")', 'renderer and real preload');
  await closeModels();
  const fixtures = path.join(profile, 'fixtures'), workspace = path.join(fixtures, 'workspace-a');
  await fs.mkdir(workspace, { recursive: true });
  if (phase === 'held-close') { await heldClose(); return; }
  if (phase === 'relaunch' || phase === 'relaunch-held-close') {
    const saved = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    await current(saved.finalSessionId);
    assert.equal(await js('document.querySelector("[data-testid=composer]").value'), saved.expectedDraft ?? 'Draft A — exact\n');
    assert.equal((await status()).navigation.current.sessionId, saved.finalSessionId);
    assert.equal((await status()).workspaces.some(row => row.path === workspace), true);
    checks.push('relaunch restores route, draft, model preference, workspaces and attachments');
    const loaded = await js(`window.localAgent.loadSession(${JSON.stringify(saved.finalSessionId)})`);
    assert.equal(loaded.preferredModel, saved.modelId);
    assert.equal(loaded.draftFiles[0].name, 'attachment.txt');
    if (phase === 'relaunch-held-close') {
      assert.equal(saved.heldCloseRegression?.actualHostDraftPersistedBeforeAcknowledgement, true);
      saved.heldCloseRegression.relaunchVerified = true; saved.heldCloseRegression.status = 'passed';
      checks.push('held save survives repeated Quit/Close and a real relaunch with its exact newest text');
    }
    await fs.writeFile(reportPath, JSON.stringify({ ...saved, relaunchChecks: [...(saved.relaunchChecks ?? []), ...checks], completedAt: new Date().toISOString() }, null, 2));
    return;
  }
  let before = (await status()).navigation.current.sessionId;
  await click('[data-testid=new-chat]');
  await waitFor(`window.localAgent.status().then(s=>s.navigation.current.sessionId!==${JSON.stringify(before)})`, 'new conversation identity');
  let s = await status(); const a = s.navigation.current.sessionId; assert.ok(a); await current(a);
  await text('[data-testid=composer]', 'Draft A — exact\n');
  await click('[data-testid=new-chat]'); await waitFor(`window.localAgent.status().then(s=>s.navigation.current.sessionId!==${JSON.stringify(a)})`, 'second conversation identity'); s = await status(); const b = s.navigation.current.sessionId; assert.notEqual(a, b); await current(b);
  await text('[data-testid=composer]', 'Draft B');
  await click(`[data-session-id="${a}"]`); await current(a);
  assert.equal(await js('document.querySelector("[data-testid=composer]").value'), 'Draft A — exact\n');
  await click(`[data-session-id="${b}"]`); await current(b);
  assert.equal(await js('document.querySelector("[data-testid=composer]").value'), 'Draft B');
  await click('[data-testid=back]'); await current(a);
  checks.push('new conversations have immediate IDs; rapid A→B→A and Back restore exact drafts');
  const attachment = path.join(fixtures, 'attachment.txt'); await fs.writeFile(attachment, 'local fixture\n'); picks.push([attachment]);
  await click('[aria-label="Attach local files"]');
  await waitFor('document.body.innerText.includes("attachment.txt")', 'draft attachment');
  picks.push(null); await click('[data-testid=workspace-add]');
  await js(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.innerText.includes('Choose folder')).click()`);
  await waitFor(`!document.querySelector('[data-testid=workspace-add]').disabled`, 'cancelled picker');
  assert.equal((await status()).navigation.current.sessionId, a);
  picks.push([workspace]); await click('[data-testid=workspace-add]');
  await js(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.innerText.includes('Choose folder')).click()`);
  await waitFor(`document.querySelector('.breadcrumb-project')?.textContent==='workspace-a'`, 'selected workspace');
  s = await status(); const c = s.navigation.current.sessionId; assert.notEqual(c, a);
  assert.equal((await js(`window.localAgent.loadSession(${JSON.stringify(c)})`)).projectPath, workspace);
  const undoCount = undoCalls.length;
  await js('(()=>{const button=document.querySelector(".undo-button");button.click();button.click();})()');
  await waitHost(() => undoCalls.length > undoCount, 'scoped Undo IPC');
  await waitFor('!document.querySelector(".undo-button").disabled', 'Undo complete');
  assert.equal(undoCalls.length, undoCount + 1); assert.equal(undoCalls.at(-1), c);
  checks.push('double-click Undo dispatches once with the viewed coding conversation ID; empty fixture has no changes to restore');
  await click('[data-testid=back]'); await current(a);
  assert.equal(await js('document.querySelector("[data-testid=composer]").value'), 'Draft A — exact\n');
  checks.push('workspace selection opens new draft; cancel and Back preserve original draft and attachment');
  await click('[data-testid=workspace-add]'); await click('[data-testid=workspace-create]');
  await text('[data-testid=workspace-name]', 'created-workspace'); picks.push(null);
  await click('[data-testid=workspace-create-confirm]');
  await waitFor(`!document.querySelector('[data-testid=workspace-create-confirm]').disabled`, 'creation cancel');
  assert.equal((await status()).navigation.current.sessionId, a); picks.push([fixtures]);
  await click('[data-testid=workspace-create-confirm]');
  await waitFor(`document.querySelector('.breadcrumb-project')?.textContent==='created-workspace'`, 'created workspace');
  assert.equal((await fs.stat(path.join(fixtures,'created-workspace'))).isDirectory(), true);
  await click('[data-testid=back]'); await current(a);
  checks.push('workspace creation cancellation is retryable; successful creation opens new draft and Back restores origin');
  const tiny = path.join(fixtures, 'fixture.gguf'); await fs.writeFile(tiny, gguf('Electron fixture model'));
  await click('[data-testid=models-open]'); picks.push([tiny]);
  await waitFor(`Array.from(document.querySelectorAll('button')).some(e=>e.textContent.includes('Import GGUF')&&!e.disabled)`, 'model library ready');
  await js(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('Import GGUF')).click()`);
  await waitFor(`document.body.innerText.includes('Electron fixture model') && !document.body.innerText.includes('Importing…')`, 'local fixture import');
  const imported = (await status()).models.find(row => row.name === 'Electron fixture model'); assert.ok(imported?.installed);
  await js(`Array.from(document.querySelectorAll('.model-card')).find(e=>e.textContent.includes('Electron fixture model')).querySelector('.model-action').click()`);
  await waitFor(`document.querySelector('.model-import-result') || Array.from(document.querySelectorAll('.model-card')).find(e=>e.textContent.includes('Electron fixture model'))?.classList.contains('model-selected')`, 'model preference');
  const deadline = Date.now()+10000;
  while ((await js(`window.localAgent.loadSession(${JSON.stringify(a)})`)).preferredModel !== imported.id && Date.now()<deadline) await delay(50);
  assert.equal((await js(`window.localAgent.loadSession(${JSON.stringify(a)})`)).preferredModel, imported.id);
  assert.equal((await status()).profile, undefined, 'Selecting a preference must not load weights.');
  await closeModels(); await click(`[data-session-id="${b}"]`); await current(b); await click(`[data-session-id="${a}"]`); await current(a);
  assert.equal((await js(`window.localAgent.loadSession(${JSON.stringify(a)})`)).preferredModel, imported.id);
  checks.push('verified local import reports selection; conversation model preference survives browsing without loading weights');
  await click('[data-testid=models-open]');
  await waitFor(`Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='Refresh hardware'&&!e.disabled)`, 'hardware refresh control');
  await js(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Refresh hardware').click()`);
  await closeModels();
  assert.equal((await status()).profile, undefined);
  checks.push('direct hardware refresh leaves inference stopped');
  const backgroundOwner = await backgroundOwnerSimulation(a, b);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ schemaVersion: 2, appPath, packagedAssets: packaged, nativePickers: 'stubbed responses; real validation and filesystem operations', inference: 'none; tiny metadata-only fixture', checks, backgroundOwnerSimulation: backgroundOwner, finalSessionId: a, expectedDraft: 'Draft A — exact\n', modelId: imported.id, completedAt: new Date().toISOString() }, null, 2));
}
app.once('browser-window-created', (_event, win) => {
  owner = win;
  win.on('close', () => { closeEvents++; });
  win.webContents.on('console-message', (_event, details, message) => {
    const text = details && typeof details === 'object' ? details.message : message;
    if (text) console.error(`Isolated renderer console: ${String(text).slice(0, 1500)}`);
  });
  win.webContents.once('did-finish-load', () => { void test().then(() => app.quit()).catch(async error => { console.error(error.stack); app.exit(1); }); });
});
require(path.join(appPath, 'dist/main.cjs'));

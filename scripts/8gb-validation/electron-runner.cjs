// External test driver: loads the real built host, preload and renderer.
// No provider, bridge, runtime status, registry request or outcome is replaced.
const os = require('node:os');
const hostContextLaunch = process.argv.includes('--host-context-diagnostic');
if (hostContextLaunch) { if(os.platform()!=='darwin'||os.arch()!=='arm64'||os.totalmem()!==24*1024**3)throw new Error('Actual host context diagnostic requires darwin/arm64 physical24GiB.'); }
else if (os.totalmem() < 8_000_000_000 || os.totalmem() > 8 * 1024 ** 3) throw new Error('Actual guest OS memory is outside8,000,000,000bytes..8GiB. No app/model load is allowed.');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const cp = require('node:child_process');
const bootstrapStop=require('./driver-bootstrap-stop.cjs').createBootstrapStopLatch();
const { HOST_CONTEXT_DIAGNOSTIC, validateDriverPlan, runDriverSequence, hostContextHardware, validateHostHardwareEvidence }=require('./driver-mode.cjs');
const planArgument = process.argv.find(value => value.startsWith('--eightgb-plan='));
if (!planArgument || !process.send) throw new Error('Use the isolated parent driver with its real IPC channel.');
const planPath = path.resolve(planArgument.slice('--eightgb-plan='.length));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let plan, owner, context = null, picker = null, shuttingDown = false, browsing = false, didLiveBrowse = false, mainImported=false;
const pending = new Map(), children = new Map();
const cancelCalls=[];
let modelStarts = 0, unexpectedModelExit = false;
let observeOwnedChild;
function emit(type, value) { if(process.connected)process.send?.({ type, value, nonce: plan?.nonce }); }
function parent(type, value) {
  const id = randomUUID();
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Parent ${type} did not finish.`)); }, type==='case-end'?45_000:30_000); pending.set(id, { resolve, reject, timer }); process.send({ type, id, value, nonce: plan.nonce }); });
}
process.on('message', message => {
  if(bootstrapStop.receive(message)){void stopAndQuit();return;}
  if (!plan || message?.nonce !== plan.nonce) return;
  if (message.type === 'response') { const request = pending.get(message.id); if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error)) : request.resolve(message.value); } }
  if (message.type === 'stop') { void stopAndQuit(); }
  if (message.type === 'sample-owned') {
    const owned = children.get(message.pid);
    if (!owned || owned.role !== 'model') { emit('sample-response', { id:message.id, error:'The requested model PID is not a current owned child.' }); return; }
    const args=['--pid',String(owned.pid)];
    const sample=cp.execFile(plan.resourceProbe, args, { timeout:1500, maxBuffer:16*1024 }, (error, stdout) => {
      try { if(error)throw error;const value=JSON.parse(stdout);if(value.schemaVersion!==1||value.helperIdentity!=='free-local-agent-resource-v1'||value.pid!==owned.pid||value.parentPid!==process.pid)throw new Error('Native sample ownership mismatch.');emit('sample-response',{id:message.id,value}); }
      catch(reason){emit('sample-response',{id:message.id,error:String(reason)});}
    });
    observeOwnedChild(sample,plan.resourceProbe,args);
  }
});
process.once('disconnect', () => { void stopAndQuit(); });
async function call(method, ...args) {
  if(shuttingDown&&!['status','cancel','loadSession','approvals'].includes(method))throw new Error('Driver Stop prevents further task/model/action calls.');
  if (!owner || owner.isDestroyed()) throw new Error('The real app window is unavailable.');
  const result = await owner.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await window.localAgent[${JSON.stringify(method)}](...${JSON.stringify(args)})};}catch(error){return {ok:false,error:String(error.stack||error)};}})()`, true);
  if (!result.ok) throw new Error(result.error); return result.value;
}
async function waitFor(predicate, label, limit = 15_000) {
  const start = Date.now(); while (Date.now() - start < limit) { if (await predicate()) return; await delay(50); } throw new Error(`Timed out waiting for ${label}.`);
}
function observeChildren() {
  function observe(child, command, args) {
    const argv = Array.isArray(args) ? args : [], name = path.basename(String(command));
    const role = /llama-server(?:\.exe)?$/.test(name) && argv.includes('--model') ? 'model' : /agent-memory-sample/.test(name) ? 'native-memory' : 'owned-child';
    const record = { pid: child.pid, parentPid: process.pid, role, executable: String(command), arguments: argv, startedAt: new Date().toISOString(), model: plan.model.id };
    if (role === 'model' && ++modelStarts !== 1) { child.kill('SIGTERM'); throw new Error('A same-model restart is forbidden in this fresh serial attempt.'); }
    if (child.pid) children.set(child.pid, record);
    emit('child-start', record);
    if (role === 'native-memory') {
      let stdout = ''; child.stdout?.on('data', chunk => { if (Buffer.byteLength(stdout) + chunk.length <= 16 * 1024) stdout += chunk.toString('utf8'); });
      child.once('close', code => { if (code === 0) { try { const value = JSON.parse(stdout); if (value.schemaVersion === 1 && value.helperIdentity === 'free-local-agent-resource-v1') emit('native-memory', value); } catch {} } });
    }
    if (role === 'model') for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => emit('native-output', { pid: child.pid, stream: stream === child.stderr ? 'stderr' : 'stdout', text: chunk.toString('utf8'), observedAt: new Date().toISOString() }));
    child.once('close', (code, signal) => { children.delete(child.pid); if (role === 'model' && !shuttingDown) unexpectedModelExit = true; emit('child-exit', { ...record, completedAt: new Date().toISOString(), code, signal, deliberateFinalStop: shuttingDown }); });
    return child;
  }
  observeOwnedChild=observe;
  const original = cp.spawn;
  cp.spawn = function(command, args, options) { return observe(original.call(cp, command, args, options), command, args); };
  // execFile and its custom promisification stay untouched. Only our explicit
  // native sampling call is separately observed below that API boundary.
}
async function pick(file, operation) {
  if (picker) throw new Error('A driver-owned picker is already pending.');
  picker = file; try { return await operation(); } finally { picker = null; }
}
async function openWorkspace(workspace) { const selected = await pick(workspace, () => call('selectProject')); if (selected !== workspace) throw new Error('The real native workspace result changed.'); return selected; }
async function newSession(mode, workspace) {
  if (workspace) await openWorkspace(workspace);
  const created = await call('createSession', { mode, ...(workspace ? { projectPath: workspace } : {}), taskEffort: 'careful' });
  await call('selectModel', plan.model.id, created.id);
  await call('navigate', { screen: 'conversation', sessionId: created.id }); await clickConversation(created.id); return created.id;
}
async function clickSelector(selector) {
  await waitFor(() => owner.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`,true),'actual enabled pointer-accessible renderer control');
  const point=await owner.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(r.width<=0||r.height<=0||!hit||!e.contains(hit))throw new Error('Actual pointer hit is blocked for '+${JSON.stringify(selector)});return{x:Math.round(x),y:Math.round(y)};})()`,true);
  owner.webContents.sendInputEvent({type:'mouseMove',...point});
  owner.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  owner.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  emit('actual-pointer-click',{selector,point,hitTested:true});
}
async function clickConversation(sessionId) {
  const selector = `[data-session-id="${sessionId}"]`;
  await waitFor(() => owner.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`, true), 'actual conversation navigation button');
  await clickSelector(selector);
  await waitFor(() => owner.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected')`, true), 'actual renderer-selected conversation');
}
async function liveBrowse(request) {
  if (didLiveBrowse || browsing || context?.fixtureId !== 'live-browse-control') return;
  browsing = true;
  try {
    const ownerId = context.sessionId, before = await call('status'), workspace = path.join(plan.runDirectory, 'live-browse-b');
    if (before.activeSessionId !== ownerId) throw new Error('Live browsing probe has no actual owner.');
    await clickSelector('[data-testid=approval-browse]');
    await fs.mkdir(workspace, { mode: 0o700 }); await fs.writeFile(path.join(workspace, 'untouched.txt'), 'Conversation B remains unchanged.\n', { flag: 'wx', mode: 0o600 });
    await openWorkspace(workspace);
    const b = await call('createSession', { mode: 'coding', projectPath: workspace, taskEffort: 'careful' });
    await clickConversation(b.id);
    const after = await call('status');
    if (before.runtime.loadedModel !== plan.model.id || after.activeSessionId !== ownerId || after.runtime.loadedModel !== before.runtime.loadedModel || JSON.stringify(after.profile) !== JSON.stringify(before.profile) || JSON.stringify(after.runtime.portableMemoryPlan) !== JSON.stringify(before.runtime.portableMemoryPlan)) throw new Error('Browsing changed the running model or actual owner.');
    let rejectedSend = false, rejectedUndoA = false, rejectedUndoB = false;
    try { await call('send', { sessionId: b.id, text: 'This request must be rejected while another task runs.' }); } catch (error) { rejectedSend = /already running|already.*preparing/i.test(String(error)); }
    try { await call('undo', b.id); } catch (error) { rejectedUndoB = /running task/i.test(String(error)); }
    try { await call('undo', ownerId); } catch (error) { rejectedUndoA = /running task/i.test(String(error)); }
    const approval = await call('approvals', ownerId), found = approval.pending.find(row => row.requestId === request.requestId);
    if (!rejectedSend || !rejectedUndoA || !rejectedUndoB || !found || approval.sessionId !== ownerId || approval.turnId !== request.turnId) throw new Error('Actual background task guards/approval ownership did not hold.');
    await clickSelector('[data-testid=running-task-open]');
    await waitFor(() => owner.webContents.executeJavaScript(`document.querySelector('[data-session-id="${ownerId}"]')?.classList.contains('selected')`,true),'real Open running task navigation');
    await waitFor(() => owner.webContents.executeJavaScript(`!!document.querySelector('.permission-dialog')`,true),'actual owner approval dialog');
    context.liveBrowse = { actual: true, ownerId, otherSessionId: b.id, otherWorkspace: workspace, rejectedSend, rejectedUndoA, rejectedUndoB, actualApprovalOwner: approval.sessionId, actualApprovalTurn: approval.turnId,
      actualRendererNavigation:true, rendererPermissionVisible: await owner.webContents.executeJavaScript(`!!document.querySelector('.permission-dialog')`, true), runningModelUnchanged: true };
    didLiveBrowse = true;
  } finally { browsing = false; }
}
async function liveStop(request) {
  const ownerId=context.sessionId,workspace=path.join(plan.runDirectory,'fixtures','live-stop-b');
  const before=await call('status');if(before.activeSessionId!==ownerId||before.runtime.loadedModel!==plan.model.id)throw new Error('Actual Stop probe has no live owned model/task.');
  await clickSelector('[data-testid=approval-browse]');
  await fs.mkdir(workspace,{mode:0o700});await fs.writeFile(path.join(workspace,'untouched.txt'),'Stop probe B remains unchanged.\n',{flag:'wx',mode:0o600});
  await openWorkspace(workspace);const b=await call('createSession',{mode:'coding',projectPath:workspace,taskEffort:'careful'});await clickConversation(b.id);
  const count=cancelCalls.length;await clickSelector('[data-testid=running-task-stop]');
  await waitFor(()=>cancelCalls.length>count,'actual owner-bound Stop IPC');
  const stopped=cancelCalls.slice(count);if(stopped.length!==1||stopped[0].sessionId!==ownerId)throw new Error('Renderer Stop targeted another conversation.');
  await waitFor(async()=>!(await call('status')).activeSessionId,'actual cancelled task final drain',20_000);
  const approvals=await call('approvals',ownerId),state=await call('status');
  if(approvals.pending.length||state.runtime.loadedModel!==plan.model.id)throw new Error('Stop left an approval or changed the running model.');
  context.liveStop={actual:true,actualRendererStop:true,ownerId,otherSessionId:b.id,actualCancel:stopped[0],pendingRequestId:request.requestId,approvalsCancelled:true,ownerDrained:true,workspaceBUntouched:await fs.readFile(path.join(workspace,'untouched.txt'),'utf8')==='Stop probe B remains unchanged.\n'};
}
async function permission(event) {
  const current = context;
  if (!current || event.sessionId !== current.sessionId) throw new Error('Unexpected approval outside the one current fixture.');
  if(current.fixtureId==='live-stop-control'){await liveStop(event);return;}
  if (current.fixtureId === 'live-browse-control') await liveBrowse(event);
  const decision = await parent('permission', { key: current.key, request: event });
  const response = await call('respondPermission', { requestId: event.requestId, approved: decision.approved === true, sessionId: event.sessionId, turnId: event.turnId });
  emit('permission-response', { key: current.key, request: event, decision, response });
}
async function sendTimed(sessionId, text, startedAt) {
  const remaining = plan.limitMs - (Date.now() - Date.parse(startedAt));
  if (remaining <= 0) throw new Error('The inclusive five-minute request deadline expired before Send.');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; emit('deadline', { key: context?.key, sessionId }); void call('cancel', sessionId).catch(error => emit('driver-error', String(error))); }, remaining);
  let error, drainTimer;
  const sending = call('send', { sessionId, text }).catch(reason => { error = String(reason); });
  try {
    await Promise.race([sending, new Promise((_, reject) => { drainTimer = setTimeout(() => reject(new Error('Actual Send did not settle after Stop and final-drain allowance.')), remaining + 20_000); })]);
    const state = await call('status'); if (state.activeSessionId) throw new Error('Actual Send returned with a live task/preflight.');
    if (context && state.runtime.loadedModel === plan.model.id && state.runtime.ready && !context.preparedAt) context.preparedAt = new Date().toISOString();
    return { loaded: await call('loadSession', sessionId), completedAt: new Date().toISOString(), timedOut, error: error ?? null, status: state };
  } finally { clearTimeout(timer); clearTimeout(drainTimer); }
}
async function acceptance(phase) {
  const requestedAt = phase === 'cold' ? plan.coldStartedAt : new Date().toISOString(), key = `acceptance-${phase}`;
  context = { key, fixtureId: key, sessionId: null };
  emit('case-begin', { key, kind: 'acceptance', phase, startedAt: requestedAt, request: plan.acceptancePrompt });
  let verifiedAt; const verificationStartedAt=new Date().toISOString();
  if (phase === 'cold') {
    const imported = await pick(plan.model.file, () => call('importModel'));
    if (imported?.modelId !== plan.model.id) throw new Error('The real import did not identify the exact pinned model.');
    verifiedAt = new Date().toISOString();
  } else {
    const status = await call('status'), row = status.models.find(model => model.id === plan.model.id);
    if (row?.digest !== plan.model.sha256 || row.integrity !== 'verified') throw new Error('Warm acceptance lacks the actual verified model binding.');
    verifiedAt = new Date().toISOString();
  }
  if(phase==='cold'&&await owner.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Close setup"]')`,true))await clickSelector('[aria-label="Close setup"]');
  const sessionId = phase === 'warm' ? plan.acceptanceSessionId : await newSession('assistant');
  plan.acceptanceSessionId = sessionId; context.sessionId = sessionId;
  const result = await sendTimed(sessionId, plan.acceptancePrompt, requestedAt);
  const message = [...result.loaded.messages].reverse().find(message => message.role === 'assistant');
  await parent('case-end', { key, kind: 'acceptance', phase, requestedAt, verificationStartedAt, verifiedAt, preparedAt: context.preparedAt ?? null, preparedAtSource:'actual-ready-status-observation',
    completedAt: result.completedAt, answer: message?.content ?? null, result, sessionId });
  context = null;
}
async function fixtureCase(fixture, repeat) {
  if (unexpectedModelExit) throw new Error('The owned model exited; no automatic restart or partial resume is allowed.');
  const key = `${fixture.id}-${repeat}`, workspace = path.join(plan.runDirectory, 'fixtures', key);
  await fs.mkdir(workspace, { mode: 0o700 });
  for (const [relative, content] of Object.entries(fixture.files)) await fs.writeFile(path.join(workspace, relative), content, { flag: 'wx', mode: 0o600 });
  const sessionId = await newSession('coding', workspace), startedAt = new Date().toISOString();
  const commands = fixture.commands.map(command => command.text);
  const text = `${fixture.request}${commands.length ? `\nExact command${commands.length > 1 ? 's' : ''}:\n${commands.join('\n')}` : ''}`;
  context = { key, fixtureId: fixture.id, sessionId };
  emit('case-begin', { key, kind: fixture.id.endsWith('-control') ? 'control' : 'quality', fixtureId: fixture.id, repeat, workspace, sessionId, startedAt, request: text, commands });
  const result = await sendTimed(sessionId, text, startedAt);
  await Promise.all(context.permissionWork??[]);
  const ended = await parent('case-end', { key, kind: fixture.id.endsWith('-control') ? 'control' : 'quality', fixtureId: fixture.id, repeat, workspace, sessionId, startedAt, request: text, result, liveBrowse: context.liveBrowse ?? null, liveStop:context.liveStop??null });
  if(fixture.id==='live-stop-control'){
    const outcome=[...result.loaded.messages].reverse().find(row=>row.role==='assistant'&&row.outcome)?.outcome;
    emit('live-stop-result',{...context.liveStop,actualOraclePassed:ended.oraclePassed,actualCancelledOutcome:outcome?.status==='cancelled',actualOutcome:outcome});
  }
  if (fixture.id === 'live-browse-control' && context.liveBrowse) {
    const b = context.liveBrowse;
    const beforeA = await fs.readFile(path.join(workspace, 'undo-a.txt')).catch(() => null);
    const undoB = await call('undo', b.otherSessionId), afterB = await fs.readFile(path.join(b.otherWorkspace, 'untouched.txt'), 'utf8');
    const beforeOwnUndo = await fs.readFile(path.join(workspace, 'undo-a.txt')).catch(() => null);
    const undoA = await call('undo', sessionId), afterA = await fs.readFile(path.join(workspace, 'undo-a.txt')).catch(() => null);
    emit('live-controls-result', { ...b, actualOraclePassedBeforeUndo: ended.oraclePassed, undoB, undoA, workspaceBUntouched: afterB === 'Conversation B remains unchanged.\n', undoBDidNotTouchA: !!beforeA && !!beforeOwnUndo && beforeA.equals(beforeOwnUndo), undoAChangedOnlyOwnFile: !!beforeA && !afterA && undoA.restored >= 1 });
  }
  context = null;
  const final = await call('status'); if (unexpectedModelExit || final.runtime.state === 'error' || final.runtime.error || final.runtime.errorCode || final.runtime.loadedModel !== plan.model.id) throw new Error('The actual runtime failed or lost its owned model; no automatic same-model restart or partial resume.');
}
async function stopAndQuit() {
  if (shuttingDown) return; shuttingDown = true;
  if(!mainImported){
    emit('bootstrap-stopped',{at:new Date().toISOString(),appMainImported:false});
    if(process.connected)await new Promise(resolve=>{const timer=setTimeout(resolve,1000);process.send({type:'owned-final-drain',nonce:plan?.nonce,value:{at:new Date().toISOString(),remainingChildren:[...children.values()],appMainImported:false}},()=>{clearTimeout(timer);resolve();});});
    app.exit(0);return;
  }
  try { const state = owner && !owner.isDestroyed() ? await call('status') : null; if (state?.activeSessionId) await call('cancel', state.activeSessionId); }
  catch (error) { emit('driver-error', String(error)); }
  app.quit();
}
async function execute() {
  if(shuttingDown)return;
  await waitFor(async () => owner && !owner.isDestroyed() && await owner.webContents.executeJavaScript('!!window.localAgent', true), 'real preload');
  await waitFor(async () => { const status = await call('status'); return status.runtime.ready && status.runtime.state === 'ready' && !status.runtime.error && !!status.runtime.version && status.hardware.totalMemoryBytes === os.totalmem(); }, 'actual initialized engine and whole-OS hardware', Math.max(1, plan.limitMs - (Date.now() - Date.parse(plan.coldStartedAt))));
  await fs.mkdir(path.join(plan.runDirectory, 'fixtures'), { mode: 0o700 });
  await call('setExecutionPreferences', { memoryMode: 'low-memory' }); await call('setSlowMode', true);
  await call('setPlugins', { taskResearch: false });
  await call('setUtilities', { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false });
  let polling = false;
  let previousPlanDigest;
  const poll = setInterval(() => { const current = context; if (current && !polling) { polling = true; void call('status').then(status => {
    const sampledAt = new Date().toISOString(), { portableMemoryPlan, ...runtime } = status.runtime;
    if (context === current && runtime.loadedModel === plan.model.id && runtime.ready && !current.preparedAt) current.preparedAt = sampledAt;
    const planDigest = portableMemoryPlan ? createHash('sha256').update(JSON.stringify(portableMemoryPlan)).digest('hex') : null;
    const row = status.models.find(row => row.id === plan.model.id);
    emit('status-sample', { key: current.key, sampledAt, status: { runtime: { ...runtime, ...(planDigest && planDigest !== previousPlanDigest ? { portableMemoryPlan } : {}), portableMemoryPlanDigest: planDigest }, profile: status.profile, memoryMode: status.memoryMode, activeSessionId: status.activeSessionId, selectedModel: status.selectedModel, model: row ? { id:row.id,digest:row.digest,integrity:row.integrity,templateHash:row.templateHash } : null } });
    previousPlanDigest = planDigest;
  }).catch(error => emit('driver-error', String(error))).finally(() => { polling = false; }); } }, 1000);
  try {
    await runDriverSequence(plan,{acceptance,fixtureCase});
    emit('run-finished', { completedAt: new Date().toISOString(), status: await call('status') });
  } finally { clearInterval(poll); await stopAndQuit(); }
}
(async () => {
  plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  if (plan.schemaVersion !== 1 || !plan.nonce || !plan.profileDirectory.includes('eightgb-real-') || !['physical', 'whole-os-vm'].includes(plan.environment)) throw new Error('A fresh isolated approved whole-OS driver plan is required.');
  validateDriverPlan(plan);
  if((plan.runMode===HOST_CONTEXT_DIAGNOSTIC)!==hostContextLaunch)throw new Error('Host context launch flag and fixed plan mode do not match.');
  if(bootstrapStop.bind(plan.nonce)||shuttingDown){await stopAndQuit();return;}
  if(hostContextLaunch){
    observeChildren();
    const probe=key=>new Promise((resolve,reject)=>{const args=['-n',key],child=cp.execFile('/usr/sbin/sysctl',args,{timeout:3000,maxBuffer:4096},(error,stdout)=>error?reject(error):resolve(stdout));observeOwnedChild(child,'/usr/sbin/sysctl',args);});
    const actual=hostContextHardware({platform:os.platform(),architecture:os.arch(),osRelease:os.release(),totalMemoryBytes:os.totalmem(),sysctlMemory:await probe('hw.memsize'),hypervisor:await probe('kern.hv_vmm_present')});
    validateHostHardwareEvidence({environment:plan.environment,memoryScope:'whole-os',actual:plan.hostContextHardware},actual);
    emit('host-context-hardware',actual);
  }
  const local=plan.workRoot;
  if(!local||local.schemaVersion!==1||local.runDirectory!==plan.runDirectory||local.profileDirectory!==plan.profileDirectory||local.filesystem?.type!=='apfs'||local.filesystem.local!==true||local.filesystem.readOnly!==false||path.dirname(plan.runDirectory)!==local.root||path.dirname(plan.profileDirectory)!==local.root)throw new Error('The actual guest-local APFS work root is required.');
  const rootInfo=await fs.lstat(local.root);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||await fs.realpath(local.root)!==local.root||rootInfo.dev!==local.identity?.device||rootInfo.ino!==local.identity?.inode||rootInfo.uid!==process.getuid()||(rootInfo.mode&0o077)!==0)throw new Error('The owned local root changed before app startup.');
  for(const directory of [plan.runDirectory,plan.profileDirectory]){const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(directory)!==directory||info.dev!==rootInfo.dev)throw new Error('Mutable app/work paths must remain ordinary directories on the owned local volume.');}
  if (os.platform() !== 'darwin' || os.arch() !== 'arm64') throw new Error('The real command/oracle network isolation adapter is unavailable on this guest.');
  const mainFile = path.join(plan.appPath, 'dist', 'main.cjs');
  if (createHash('sha256').update(await fs.readFile(mainFile)).digest('hex') !== plan.mainSha256) throw new Error('Built main changed after driver binding.');
  if(shuttingDown)return;
  app.setPath('userData', plan.profileDirectory); app.setAppPath(plan.appPath);
  if (plan.appPath.endsWith('.asar')) { Object.defineProperty(app, 'isPackaged', { value: true }); Object.defineProperty(process, 'resourcesPath', { value: path.dirname(plan.appPath) }); }
  dialog.showOpenDialog = async () => {
    if (!picker || ![plan.model.file, ...plan.allowedWorkspaces].includes(picker) && !picker.startsWith(path.join(plan.runDirectory, 'fixtures') + path.sep) && picker !== path.join(plan.runDirectory, 'live-browse-b')) throw new Error('Unexpected native picker; no personal path is authorized.');
    emit('owned-picker', { path: picker }); return { canceled: false, filePaths: [picker] };
  };
  if(!hostContextLaunch)observeChildren();
  const realHandle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>realHandle(channel,async(event,...args)=>{
    if(channel==='local-agent:cancel'){const record={sessionId:args[0],observedAt:new Date().toISOString()};if(cancelCalls.length>=64)throw new Error('Actual cancel observation bound exceeded.');cancelCalls.push(record);emit('actual-cancel-ipc',record);}
    return handler(event,...args);
  });
  app.on('browser-window-created', (_event, window) => {
    owner = window; const original = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => {
      if (channel === 'local-agent:event') { emit('host-event', { key: context?.key, observedAt: new Date().toISOString(), event: args[0] }); if (args[0]?.type === 'permission') { const current=context,work=permission(args[0]);if(current)(current.permissionWork??=[]).push(work);void work.catch(error => { emit('driver-error', String(error)); void stopAndQuit(); }); } }
      return original(channel, ...args);
    };
    window.webContents.once('did-finish-load', () => { void execute().catch(error => { emit('run-error', { error: String(error.stack || error), context }); void stopAndQuit(); }); });
  });
  let finalDraining=false;
  app.on('will-quit', event => {
    const report=() => emit('owned-final-drain', { at:new Date().toISOString(), remainingChildren:[...children.values()] });
    if (!children.size || finalDraining) { report(); return; }
    event.preventDefault(); finalDraining=true;
    void waitFor(() => children.size===0,'actual final tracked children close',20_000).then(() => {report();app.exit(0);}, error => {emit('driver-error',String(error));report();app.exit(1);});
  });
  if(shuttingDown)return;
  mainImported=true;require(mainFile);
})().catch(error => { emit('bootstrap-error', String(error.stack || error)); app.exit(1); });

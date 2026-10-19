// External test bootstrap: load the actual package, preload and renderer.
// Only observe loadSession results. Never replace their values or the bridge.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const profile = app.commandLine.getSwitchValue('user-data-dir');
const appPath = app.commandLine.getSwitchValue('memory-app');
const reportPath = app.commandLine.getSwitchValue('memory-report');
const fixturePath = app.commandLine.getSwitchValue('memory-fixture');
const baseline = app.commandLine.hasSwitch('memory-baseline');
if (!profile || !path.basename(profile).startsWith('agent-renderer-memory-') || !path.isAbsolute(profile)
  || path.dirname(reportPath) !== profile || path.dirname(fixturePath) !== profile || path.basename(appPath) !== 'app.asar') {
  throw new Error('An isolated authored renderer-memory profile and actual app.asar are required.');
}
app.setAppPath(appPath);
Object.defineProperty(app, 'isPackaged', { value: true });
Object.defineProperty(process, 'resourcesPath', { value: path.dirname(appPath) });
const digest = value => createHash('sha256').update(value).digest('hex');
const report = { schemaVersion: 1, classification: 'authored-packaged-renderer-memory-observation',
  mode: baseline ? 'baseline-observation' : 'lazy-renderer-and-projection-check', status: 'running',
  startedAt: new Date().toISOString(), appPath, profile, versions: process.versions,
  noInference: true, forcedGC: false, heapExpectation: 'No asserted reduction; these are raw observations, not high-water marks.',
  loadSession: [], stages: [], checks: [], pointerClicks: [], quitEvents: [], rendererConsole: [] };
let owner, fixture, finishing = false;
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => realHandle(channel, async (event, ...args) => {
  const result = await listener(event, ...args);
  if (channel === 'local-agent:loadSession') {
    const serialized = JSON.stringify(result);
    report.loadSession.push({ observedAt: new Date().toISOString(), requestedId: args[0], keys: Object.keys(result).sort(),
      serializedBytes: Buffer.byteLength(serialized), serializedSha256: digest(serialized),
      visibleMessagesSha256: digest(JSON.stringify(result.messages)), toolCount: result.messages?.[1]?.tools?.length,
      privateKeys: ['canonicalTranscript', 'transcriptHistory', 'transcriptBinding', 'transcriptIncomplete', 'taskBrief'].filter(key => Object.hasOwn(result, key)),
      stageUndefined: result.stage === undefined, returnedUnchanged: true });
  }
  return result;
});
app.on('before-quit', () => { report.quitEvents.push({ type: 'before-quit', observedAt: new Date().toISOString() }); });
app.on('will-quit', () => {
  report.quitEvents.push({ type: 'will-quit', observedAt: new Date().toISOString() });
  report.normalQuitObserved = true;
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function js(source) {
  let result;
  try {
    result = await owner.webContents.executeJavaScript(`(async()=>{try{return await (${source});}catch(error){return {__memoryTestError:String(error.stack||error)};}})()`, true);
  } catch (error) {
    throw new Error(`Renderer script execution failed: ${error.stack || error}\nSource: ${source}`, { cause: error });
  }
  if (result?.__memoryTestError) throw new Error(`${result.__memoryTestError}\nSource: ${source}`);
  return result;
}
async function waitFor(source, label, limit = 15000) {
  const start = Date.now();
  while (Date.now() - start < limit) { if (await js(source)) return; await delay(30); }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function settled() { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function click(selector) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
  const point = await js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center',inline:'nearest'});const rect=element.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);if(rect.width<=0||rect.height<=0||!element.contains(document.elementFromPoint(x,y)))throw Error('Actual pointer control is covered: '+${JSON.stringify(selector)});return{x,y};})()`);
  owner.focus(); owner.webContents.focus();
  owner.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  owner.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  owner.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  report.pointerClicks.push({ selector, point, observedAt: new Date().toISOString(), actualInputEvent: true });
}
const working = '.working-details';
const firstTool = baseline ? '.working-tool-activity>details:first-child' : 'details[data-tool-id="memory-0"]';
async function domSnapshot() {
  return js(`(()=>{const working=document.querySelector('.working-details');return{elements:document.querySelectorAll('*').length,
    workingCount:document.querySelectorAll('.working-details').length,workingOpen:working?.open??null,
    workingContentCount:working?.querySelectorAll('.working-content').length??0,
    toolSummaries:working?.querySelectorAll('.working-tool-activity>details>summary').length??0,
    nestedOpen:working?.querySelectorAll('.working-tool-activity>details[open]').length??0,
    syntaxBlocks:working?.querySelectorAll('pre.syntax-block').length??0,
    syntaxTokens:working?.querySelectorAll('[class^="syntax-"]').length??0,
    payloadHeadings:[...(working?.querySelectorAll('h3')??[])].map(e=>e.textContent).filter(text=>['Input','Result','Command output'].includes(text)),
    thinking:working?.querySelector('.thinking-text')?.textContent??null,
    payloadSentinelPresent:working?.textContent.includes('AUTHORED_RENDERER_MEMORY_STDOUT_')??false,
    authoredAnswerPresent:document.body.textContent.includes('AUTHORED_RENDERER_MEMORY_ANSWER'),
    hostTranscriptSentinelPresent:document.body.textContent.includes('HOST_ONLY_RENDERER_MEMORY_TRANSCRIPT')};})()`);
}
async function capture(stage) {
  await settled();
  const observedAt = new Date().toISOString(), rendererPid = owner.webContents.getOSProcessId();
  const heap = await owner.webContents.debugger.sendCommand('Runtime.getHeapUsage');
  const domCounters = await owner.webContents.debugger.sendCommand('Memory.getDOMCounters');
  const metrics = app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, creationTime: metric.creationTime,
    memory: metric.memory, cpu: metric.cpu, ...(metric.serviceName ? { serviceName: metric.serviceName } : {}) }));
  const status = await js('window.localAgent.status()');
  assert.equal(status.selectedModel, null, 'Authored UI testing cannot select a model.');
  assert.equal(status.runtime.loadedModel ?? null, null, 'Authored UI testing cannot load a model.');
  assert.equal(status.activeSessionId, undefined, 'No inference task may be active.');
  const observation = { stage, observedAt, rendererPid, heap: { source: 'CDP Runtime.getHeapUsage', units: 'bytes', raw: heap },
    domCounters: { source: 'CDP Memory.getDOMCounters', units: 'counts', raw: domCounters },
    appMetrics: { source: 'Electron app.getAppMetrics', memoryUnits: 'KiB as returned by Electron ProcessMemoryInfo',
      scope: 'Separate app-owned PIDs; shared pages may overlap, so these are not summed.', raw: metrics },
    dom: await domSnapshot(), inferenceState: { selectedModel: status.selectedModel, loadedModel: status.runtime.loadedModel ?? null, activeSessionId: status.activeSessionId ?? null } };
  assert.ok(metrics.some(metric => metric.pid === rendererPid), 'The measured renderer must belong to this Electron app.');
  report.stages.push(observation);
  return observation.dom;
}
function assertNoPayload(dom) {
  assert.equal(dom.syntaxBlocks, 0); assert.equal(dom.syntaxTokens, 0);
  assert.deepEqual(dom.payloadHeadings, []); assert.equal(dom.payloadSentinelPresent, false);
}
async function verifyFirstTool() {
  const result = await js(`(()=>{const tool=document.querySelector(${JSON.stringify(firstTool)});return{open:tool?.open,
    summary:tool?.querySelector('summary')?.textContent,blocks:[...(tool?.querySelectorAll('pre.syntax-block code')??[])].map(e=>e.textContent)};})()`);
  const { output_text, ...receipt } = fixture.firstTool.output;
  assert.equal(result.open, true);
  assert.ok(result.summary.includes(fixture.firstTool.title) && result.summary.includes(fixture.firstTool.status));
  assert.deepEqual(result.blocks, [JSON.stringify(fixture.firstTool.input, null, 2), JSON.stringify(receipt, null, 2), output_text],
    'Opening a real tool must render every exact retained input, receipt and command-output byte.');
  const renderedInput = JSON.parse(result.blocks[0]), renderedReceipt = JSON.parse(result.blocks[1]);
  assert.deepEqual(renderedInput, fixture.firstTool.input); assert.deepEqual(renderedReceipt, receipt);
  assert.equal(renderedReceipt.log_id, fixture.firstTool.output.log_id);
  assert.equal(renderedReceipt.output_complete, true);
  report.checks.push({ name: 'first-tool-exact-visible-input-receipt-and-output', passed: true,
    inputSha256: digest(result.blocks[0]), receiptSha256: digest(result.blocks[1]), stdoutSha256: digest(result.blocks[2]),
    status: fixture.firstTool.status, logId: renderedReceipt.log_id, authoredExecutionEvidence: false });
}
async function run() {
  fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  assert.equal(fixture.classification, 'authored-renderer-memory-fixture-v1');
  await waitFor('!!window.localAgent && !!document.querySelector("[data-testid=composer]")', 'real preload and renderer');
  await waitFor(`!!document.querySelector('[data-session-id="${fixture.sessionId}"]')`, 'authored session navigation');
  const setupCloseSelector = '[aria-label="Close setup"]';
  if (await js(`!!document.querySelector(${JSON.stringify(setupCloseSelector)})`)) await click(setupCloseSelector);
  await waitFor(`!document.querySelector(${JSON.stringify(setupCloseSelector)})`, 'model setup closed');
  const priorLoads = report.loadSession.length;
  await click(`[data-session-id="${fixture.sessionId}"]`);
  await waitFor(`document.querySelector('[data-session-id="${fixture.sessionId}"]')?.classList.contains('selected') && document.body.textContent.includes('AUTHORED_RENDERER_MEMORY_ANSWER')`, 'actual selected conversation');
  const loadStart = Date.now();
  while (report.loadSession.length <= priorLoads && Date.now() - loadStart < 15000) await delay(30);
  assert.ok(report.loadSession.length > priorLoads, 'Actual navigation must call the actual loadSession handler.');
  const loaded = report.loadSession.at(-1);
  assert.equal(loaded.requestedId, fixture.sessionId); assert.equal(loaded.visibleMessagesSha256, fixture.visibleMessagesSha256);
  assert.equal(loaded.toolCount, 256); assert.equal(loaded.stageUndefined, true);
  if (!baseline) {
    assert.deepEqual(loaded.privateKeys, []);
    assert.deepEqual(loaded.keys.filter(key => key !== 'stage'), fixture.expectedRendererKeys);
    assert.equal(loaded.serializedBytes, fixture.expectedRendererBytesWithoutStage);
    report.checks.push({ name: 'real-loadSession-explicit-renderer-projection', passed: true });
  } else report.checks.push({ name: 'renderer-projection', status: 'baseline-observation-only', privateKeys: loaded.privateKeys });
  owner.webContents.debugger.attach('1.3');
  const collapsed = await capture('outer-collapsed');
  assert.equal(collapsed.workingCount, 1); assert.equal(collapsed.workingOpen, false);
  assert.equal(collapsed.authoredAnswerPresent, true); assert.equal(collapsed.hostTranscriptSentinelPresent, false);
  if (!baseline) { assert.equal(collapsed.workingContentCount, 0); assertNoPayload(collapsed); }
  await click(`${working}>summary`);
  await waitFor('document.querySelector(".working-details")?.open && document.querySelectorAll(".working-tool-activity>details>summary").length===256', 'Working summaries committed');
  const expanded = await capture('outer-open-tools-collapsed');
  assert.equal(expanded.thinking, fixture.thinking); assert.equal(expanded.nestedOpen, 0);
  if (!baseline) assertNoPayload(expanded);
  await click(`${firstTool}>summary`);
  await waitFor(`document.querySelector(${JSON.stringify(firstTool)})?.open && document.querySelectorAll(${JSON.stringify(`${firstTool} pre.syntax-block`)}).length===3`, 'first real tool body committed');
  await verifyFirstTool(); await capture('one-tool-open');
  await click(`${firstTool}>summary`);
  await waitFor(`document.querySelector(${JSON.stringify(firstTool)})?.open===false${baseline ? '' : ` && document.querySelectorAll(${JSON.stringify(`${firstTool} pre.syntax-block`)}).length===0`}`, 'first tool closed');
  const closedTool = await capture('tool-closed');
  if (!baseline) assertNoPayload(closedTool);
  await click(`${firstTool}>summary`);
  await waitFor(`document.querySelector(${JSON.stringify(firstTool)})?.open && document.querySelectorAll(${JSON.stringify(`${firstTool} pre.syntax-block`)}).length===3`, 'first tool reopened');
  await verifyFirstTool(); await capture('one-tool-reopened');
  await click(`${working}>summary`);
  await waitFor(`document.querySelector('.working-details')?.open===false${baseline ? '' : " && !document.querySelector('.working-content')"}`, 'Working closed');
  const closedWorking = await capture('outer-closed-after-open');
  if (!baseline) { assert.equal(closedWorking.workingContentCount, 0); assertNoPayload(closedWorking); }
  report.checks.push({ name: baseline ? 'eager-DOM-baseline-recorded' : 'lazy-outer-and-nested-bodies-unmount-and-reopen-exactly', passed: true,
    lazyAssertionsApplied: !baseline, projectionAssertionsApplied: !baseline });
  report.status = 'passed'; report.completedAt = new Date().toISOString();
}
async function finish(error) {
  if (finishing) return; finishing = true;
  if (error) { report.status = 'failed'; report.error = String(error.stack || error); report.completedAt = new Date().toISOString(); }
  try { if (owner?.webContents.debugger.isAttached()) owner.webContents.debugger.detach(); } catch {}
  report.quitRequestedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (error) process.exitCode = 1;
  app.quit();
}
const deadline = setTimeout(() => { void finish(new Error('Renderer-memory bootstrap exceeded its 110 second deadline.')); }, 110000);
app.once('browser-window-created', (_event, win) => {
  if (owner) return;
  owner = win;
  win.webContents.on('console-message', (_event, detailsOrLevel, message, line, sourceId) => {
    const details = typeof detailsOrLevel === 'object' ? detailsOrLevel : { level: detailsOrLevel, message, lineNumber: line, sourceId };
    report.rendererConsole.push({ observedAt: new Date().toISOString(), level: details.level,
      message: String(details.message ?? '').slice(0, 2000), lineNumber: details.lineNumber,
      sourceId: String(details.sourceId ?? '').slice(0, 500) });
    if (report.rendererConsole.length > 20) report.rendererConsole.shift();
  });
  win.webContents.once('did-finish-load', () => { void run().then(() => finish()).catch(finish).finally(() => clearTimeout(deadline)); });
});
process.once('uncaughtException', error => { void finish(error); });
process.once('unhandledRejection', error => { void finish(error instanceof Error ? error : new Error(String(error))); });
require(path.join(appPath, 'dist/main.cjs'));

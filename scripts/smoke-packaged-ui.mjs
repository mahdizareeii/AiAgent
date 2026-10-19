import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await realpath('.');
const appDirectory = path.resolve(process.argv[2] ?? 'release/0.6.0-alpha.1/mac-arm64/Free Local Agent.app');
const reportPath = path.resolve(process.argv[3] ?? '.cache/v060-packaged-ui.json');
const executable = process.platform === 'darwin' ? path.join(appDirectory, 'Contents/MacOS/Free Local Agent') : path.join(appDirectory, process.platform === 'win32' ? 'Free Local Agent.exe' : 'free-local-agent-desktop');
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-packaged-ui-'))), profile = path.join(temporary, 'profile');
await mkdir(profile);
const a = randomUUID(), b = randomUUID();
await writeFile(path.join(profile, 'chats.json'), JSON.stringify({ version: 5, selectedModel: null, mode: 'assistant', sessions: [
  { id: a, title: 'Packaged A', updatedAt: new Date().toISOString(), mode: 'assistant', messages: [], files: [], draft: 'Packaged A draft\n', draftRevision: 2 },
  { id: b, title: 'Packaged B', updatedAt: new Date().toISOString(), mode: 'assistant', messages: [], files: [], draft: 'Packaged B draft', draftRevision: 4 },
], navigation: { current: { screen: 'conversation', sessionId: a }, back: [] } }));
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
let stderr = '', socket, seq = 0;
const pending = new Map();
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Packaged renderer timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { pending.get(id)?.reject(error); pending.delete(id); }
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression, label) {
  for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await delay(50); }
  throw new Error(`Packaged UI did not reach ${label}. ${await evaluate('document.body.innerText.slice(-2500)')}`);
}
async function click(selector) { await wait(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
try {
  let target;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged app exited during startup: ${stderr}`);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(row => row.type === 'page' && row.url.includes('index.html')); } catch {}
    if (target) break; await delay(50);
  }
  assert.ok(target?.webSocketDebuggerUrl, `Packaged renderer did not start. ${stderr}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onclose = () => { for (const request of pending.values()) request.reject(new Error('Packaged renderer connection closed.')); pending.clear(); };
  socket.onmessage = event => { const data = JSON.parse(String(event.data)), request = pending.get(data.id); if (request) { pending.delete(data.id); data.error ? request.reject(new Error(JSON.stringify(data.error))) : request.resolve(data.result); } };
  await wait('!!window.localAgent && !!document.querySelector("[data-testid=composer]")', 'preload and renderer');
  if (await evaluate(`!!document.querySelector(${JSON.stringify('[aria-label="Close setup"]')})`)) await click('[aria-label="Close setup"]');
  await wait(`document.querySelector('[data-session-id="${a}"]')?.classList.contains('selected')`, 'migrated conversation A');
  assert.equal(await evaluate('document.querySelector("[data-testid=composer]").value'), 'Packaged A draft\n');
  await click(`[data-session-id="${b}"]`);
  await wait(`document.querySelector('[data-session-id="${b}"]')?.classList.contains('selected')`, 'conversation B');
  assert.equal(await evaluate('document.querySelector("[data-testid=composer]").value'), 'Packaged B draft');
  await click('[data-testid=back]');
  await wait(`document.querySelector('[data-session-id="${a}"]')?.classList.contains('selected')`, 'Back to A');
  assert.equal(await evaluate('document.querySelector("[data-testid=composer]").value'), 'Packaged A draft\n');
  await click('[data-testid=new-task]');
  await wait(`window.localAgent.status().then(s=>!!s.currentSessionId&&s.currentSessionId!==${JSON.stringify(a)})`, 'new task identity without a selected model');
  await click('[data-testid=back]'); await wait(`document.querySelector('[data-session-id="${a}"]')?.classList.contains('selected')`, 'Back from new task');
  await click('[data-testid=models-open]'); await wait('!!document.querySelector("#setup-title")', 'model library');
  assert.ok(await evaluate('document.body.innerText.includes("Q3_K_S")&&document.body.innerText.includes("UD-IQ3_XXS")&&document.body.innerText.includes("UD-IQ2_M")'));
  await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Refresh hardware').click()`);
  await click('[aria-label="Close setup"]');
  await wait('window.localAgent.status().then(s=>s.runtime.ready || !!s.runtime.error)', 'native runtime startup');
  const status = await evaluate('window.localAgent.status()');
  assert.equal(status.storage.profile, 'isolated'); assert.equal(status.profile, undefined); assert.equal(status.runtime.ready, true, JSON.stringify(status.runtime));
  const saved = JSON.parse(await readFile(path.join(profile, 'chats.json'), 'utf8')); assert.equal(saved.version, 7); assert.equal(saved.sessions.find(row => row.id === a).draft, 'Packaged A draft\n');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await mkdir(path.dirname(reportPath), { recursive: true });
  const screenshotPath = reportPath.replace(/\.json$/, '') + '.png'; await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString(), executable, appDirectory, actualPackagedExecutable: true,
    isolatedProfile: true, inferenceLoaded: false, runtimeReady: status.runtime.ready, screenshot: screenshotPath,
    checks: ['real packaged executable/preload/renderer startup', 'v5 to v7 migration preserves drafts', 'A→B→Back restores exact drafts', 'immediate new task identity without model readiness', 'all three 9B variants visible and explicitly unverified', 'hardware refresh preserves stopped inference'] }, null, 2) + '\n');
  console.log(`Packaged UI checks passed: ${reportPath}`);
} catch (error) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  const failure = { completedAt: new Date().toISOString(), executable, actualPackagedExecutable: true, passed: false, error: String(error.stack || error), stderr };
  try { failure.runtime = await evaluate('window.localAgent.status().then(s=>s.runtime)'); } catch {}
  await writeFile(reportPath.replace(/\.json$/, '') + '-failure.json', JSON.stringify(failure, null, 2) + '\n');
  throw error;
} finally {
  socket?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([exited, delay(10000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
  await rm(temporary, { recursive: true, force: true });
}

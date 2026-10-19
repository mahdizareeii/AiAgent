import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { parseQualificationOptions, qualificationReadiness, runCodingQualification } from '../../../scripts/run-local-coding-qualification.ts';

const models = [{ id: 'qwen3.8:27b', filename: 'qwen.gguf', estimatedDownloadBytes: 4 },
  { id: 'muse-glimmer:30b', filename: 'muse.gguf', estimatedDownloadBytes: 4 }];
const terminalBaseline = { modelId: 'qwen3.5:4b', fullRequested: true, expectedCases: 36, cases: Array.from({ length: 36 }, () => ({})),
  completedAt: '2026-10-14T00:00:00.000Z', ownedProcessesStopped: true };
async function publish(file: string, contents: string) {
  const temporary = file + '.fixture-publish';
  await writeFile(temporary, contents); await rename(temporary, file);
}
async function fixture(t: TestContext, mode: 'normal' | 'cleanup-failure' | 'cancel' = 'normal') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'qualification-coordinator-'))), cache = path.join(root, '.cache/coding-reliability');
  await mkdir(path.join(cache, 'models'), { recursive: true });
  const baselineReport = path.join(cache, 'baseline-revalidated.json'), harnessPath = path.join(root, 'offline-harness.cjs');
  // The fake child never loads a model. It verifies argv and process ordering,
  // then emits the production harness's completion protocol and local report.
  await writeFile(harnessPath, `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);if(args.length!==6||args[0]!=='--baseline-report'||args[2]!=='--model'||args[4]!=='--source-dir')throw Error('Unexpected argv');
const model=args[3],cache=path.join(process.cwd(),'.cache/coding-reliability'),active=path.join(cache,'active-child');
if(fs.existsSync(active))throw Error('Concurrent native model attempt');
fs.writeFileSync(active,model);fs.appendFileSync(path.join(cache,'started-models'),model+'\\n');
const report=path.join(cache,'runs',model.replace(/[^a-z0-9]/gi,'-'),'report.json');fs.mkdirSync(path.dirname(report),{recursive:true});
function finish(cancelled=false){fs.rmSync(active,{force:true});const qualified=!cancelled&&model.startsWith('muse');
const value={modelId:model,completedAt:new Date().toISOString(),ownedProcessesStopped:${mode !== 'cleanup-failure'},qualified,passed:qualified};
fs.writeFileSync(report,JSON.stringify(value));
const text=JSON.stringify({event:'ACCEPTANCE_COMPLETE',report,qualified,passed:qualified})+'\\n';
process.stdout.write(text.slice(0,11));setTimeout(()=>{process.stdout.write(text.slice(11));process.exit(qualified?0:1)},10);}
${mode === 'cancel' ? "process.once('SIGTERM',()=>setTimeout(()=>finish(true),20));fs.writeFileSync(path.join(cache,'ready-to-cancel'),model);setInterval(()=>{},1000);" : 'setTimeout(()=>finish(),30);'}
`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cache, baselineReport, sourceDirectory: path.join(cache, 'models'), harnessPath,
    // Match the real harness/download writers: a final filename is visible only
    // after its complete content has been written to a temporary file.
    ready: async () => { await publish(baselineReport, JSON.stringify(terminalBaseline)); for (const model of models) await publish(path.join(cache, 'models', model.filename), 'tiny'); },
    settings: { rootDirectory: root, catalog: models, harnessPath, waitTimeoutMs: 2000, pollIntervalMs: 5, onOutput: () => {} } };
}

test('coordinator waits for terminal baseline and both complete files, then runs each model once serially preserving failure', async t => {
  const run = await fixture(t);
  await writeFile(run.baselineReport, JSON.stringify({ ...terminalBaseline, completedAt: undefined, ownedProcessesStopped: false, cases: [] }));
  const pending = runCodingQualification({ baselineReport: run.baselineReport }, run.settings);
  await delay(30); await assert.rejects(lstat(path.join(run.cache, 'started-models')), { code: 'ENOENT' });
  await run.ready(); const result = await pending;
  assert.equal(result.status, 'completed', result.error?.slice(0, 2000) ?? 'Coordinator failed without an error message.'); assert.equal(result.nativeUIVerified, false);
  assert.deepEqual(result.attempts.map(item => [item.model, item.status, item.exitCode]), [
    ['qwen3.8:27b', 'failed', 1], ['muse-glimmer:30b', 'qualified', 0],
  ]);
  assert.equal((await readFile(path.join(run.cache, 'started-models'), 'utf8')).trim(), 'qwen3.8:27b\nmuse-glimmer:30b');
  assert.ok(result.attempts.every(item => item.reportPath && item.ownedProcessesStopped));
  assert.ok(Date.parse(result.attempts[1].startedAt!) >= Date.parse(result.attempts[0].completedAt!));
  assert.equal((await lstat(result.reportPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, 'utf8')), result);
  assert.equal((await readdir(run.cache)).some(name => name.endsWith('.tmp')), false);
});

test('a partial or unstopped terminal baseline cannot start any model and a missing baseline times out without acquisition', async t => {
  for (const bad of [{ ...terminalBaseline, cases: [] }, { ...terminalBaseline, ownedProcessesStopped: false }]) {
    const run = await fixture(t); await run.ready(); await writeFile(run.baselineReport, JSON.stringify(bad));
    const result = await runCodingQualification({ baselineReport: run.baselineReport }, run.settings);
    assert.equal(result.status, 'failed'); assert.deepEqual(result.attempts, []);
    await assert.rejects(lstat(path.join(run.cache, 'started-models')), { code: 'ENOENT' });
  }
  const run = await fixture(t);
  const result = await runCodingQualification({ baselineReport: run.baselineReport }, { ...run.settings, waitTimeoutMs: 15 });
  assert.equal(result.status, 'timed-out'); assert.deepEqual(result.attempts, []);
  assert.equal(result.modelAcquisition, false); assert.equal(result.publicNetwork, false);
});

test('readiness uses final regular pinned-size files, accepts finishedAt, and rejects symlinks or wrong sizes', async t => {
  const run = await fixture(t); await run.ready();
  await writeFile(run.baselineReport, JSON.stringify({ ...terminalBaseline, completedAt: undefined, finishedAt: terminalBaseline.completedAt }));
  assert.equal((await qualificationReadiness(run.baselineReport, run.sourceDirectory, models)).ready, true);
  await rm(path.join(run.sourceDirectory, models[0].filename));
  await writeFile(path.join(run.sourceDirectory, models[0].filename + '.part'), 'tiny');
  assert.equal((await qualificationReadiness(run.baselineReport, run.sourceDirectory, models)).ready, false);
  await symlink(path.join(run.sourceDirectory, models[0].filename + '.part'), path.join(run.sourceDirectory, models[0].filename));
  await assert.rejects(qualificationReadiness(run.baselineReport, run.sourceDirectory, models), /regular local file/);
  await rm(path.join(run.sourceDirectory, models[0].filename)); await writeFile(path.join(run.sourceDirectory, models[0].filename), 'bad');
  await assert.rejects(qualificationReadiness(run.baselineReport, run.sourceDirectory, models), /pinned size/);
});

test('coordinator does not load another model when the first attempt lacks confirmed cleanup', async t => {
  const run = await fixture(t, 'cleanup-failure'); await run.ready();
  const result = await runCodingQualification({ baselineReport: run.baselineReport }, run.settings);
  assert.equal(result.status, 'failed'); assert.equal(result.attempts.length, 1);
  assert.match(result.error!, /did not confirm owned-process cleanup/);
  assert.equal((await readFile(path.join(run.cache, 'started-models'), 'utf8')).trim(), 'qwen3.8:27b');
});

test('cancellation signals the owned child group and waits for its terminal cleanup without starting Muse', { timeout: 5000 }, async t => {
  const run = await fixture(t, 'cancel'); await run.ready(); const controller = new AbortController();
  const pending = runCodingQualification({ baselineReport: run.baselineReport }, { ...run.settings, signal: controller.signal, stopGraceMs: 1000 });
  try {
    const deadline = Date.now() + 3000;
    while (!(await lstat(path.join(run.cache, 'ready-to-cancel')).catch(() => undefined))) {
      assert.ok(Date.now() < deadline, 'The fixture did not install its cancellation handler before the readiness deadline.');
      await delay(5);
    }
    controller.abort(new Error('Fixture explicit cancellation'));
    const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.match(result.error!, /Fixture explicit cancellation/);
    assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].status, 'cancelled');
    assert.equal(result.attempts[0].ownedProcessesStopped, true, result.attempts[0].error?.slice(0, 2000) ?? 'The child must confirm cleanup.');
    assert.equal(result.attempts[0].forcedTermination, undefined);
    assert.ok(result.attempts[0].terminationRequestedAt);
    await assert.rejects(lstat(path.join(run.cache, 'active-child')), { code: 'ENOENT' });
  } finally {
    if (!controller.signal.aborted) controller.abort(new Error('Cancellation fixture cleanup'));
    await pending;
  }
});

test('cancelled waits and malformed CLI options perform no model actions', async t => {
  const run = await fixture(t), controller = new AbortController();
  const pending = runCodingQualification({ baselineReport: run.baselineReport }, { ...run.settings, signal: controller.signal });
  await delay(10); controller.abort(new Error('Cancel pending wait'));
  const result = await pending; assert.equal(result.status, 'cancelled'); assert.deepEqual(result.attempts, []);
  assert.equal(parseQualificationOptions(['--baseline-report', 'relative.json']).baselineReport, path.resolve('relative.json'));
  for (const args of [[], ['--model', 'qwen3.8:27b'], ['--baseline-report', '--bad'], ['--baseline-report', 'a', '--baseline-report', 'b']]) {
    assert.throws(() => parseQualificationOptions(args), /baseline-report/);
  }
  await assert.rejects(runCodingQualification({ baselineReport: path.join(run.root, 'outside.json') }, run.settings), /inside .cache/);
  await assert.rejects(runCodingQualification({ baselineReport: run.baselineReport }, { ...run.settings, pollIntervalMs: 60_001 }), /Poll interval/);
});

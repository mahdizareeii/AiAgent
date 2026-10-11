import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { MODEL_CATALOG, RuntimeError, classifyModel } from '../../runtime/index.ts';
import type { HardwareInfo, RuntimeStatus, VerifiedModel } from '../../runtime/index.ts';
import { assertInferenceReady, desktopRuntimeStatus, discoverDesktopModels, resolveStorage, selectionAfterDownload } from '../desktop-status.ts';

const gib = 1024 ** 3;
const hardware: HardwareInfo = { platform: 'darwin', architecture: 'arm64', cpuModel: 'Test CPU', cpuCores: 10,
  totalMemoryBytes: 24 * gib, availableMemoryBytes: 20 * gib, freeDiskBytes: 100 * gib,
  gpus: [{ name: 'Test Metal', backend: 'metal', totalMemoryBytes: 24 * gib, freeMemoryBytes: 20 * gib, unifiedMemory: true }] };
const current = (state: RuntimeStatus['state'] = 'ready', error: RuntimeStatus['error'] = null): RuntimeStatus => ({
  state, error, baseUrl: null, version: '0.6.0', executablePath: null, modelCacheDirectory: '/isolated/gguf-runtime/models',
  recommendation: { supported: true, totalMemoryGB: 24, suggestedModel: 'qwen3.5:4b', contextTokens: 8192, reason: null },
  downloadingModel: null, hardware, profile: null, loadedModel: null, slowMode: false,
});
const verified = (model: string): VerifiedModel => ({ model, digest: 'a'.repeat(64), sizeBytes: 100,
  capabilities: ['completion'], verifiedAt: '2026-10-10T00:00:00Z', toolCapable: false });

test('renamed app retains its regular storage and explicit profiles remain isolated', () => {
  const appData = path.resolve('/retained/Application Support');
  const regular = resolveStorage(appData);
  assert.deepEqual(regular, { profile: 'regular', path: path.join(appData, 'Local Agent'),
    modelCachePath: path.join(appData, 'Local Agent', 'gguf-runtime', 'models') });
  const isolated = resolveStorage(appData, './.cache/acceptance-profile');
  assert.equal(isolated.profile, 'isolated');
  assert.equal(isolated.path, path.resolve('./.cache/acceptance-profile'));
  assert.equal(isolated.modelCachePath, path.join(isolated.path, 'gguf-runtime', 'models'));
  assert.notEqual(isolated.path, regular.path);
  assert.deepEqual(resolveStorage(appData, ''), regular);
});

test('an empty model library is normal onboarding with a ready engine', async () => {
  const engine = desktopRuntimeStatus(current());
  const catalog = await discoverDesktopModels({ listModels: async () => MODEL_CATALOG.map(spec => ({
    ...spec, ...classifyModel(spec, hardware), installed: false, sizeBytes: 0, digest: null, blockedReason: null,
  })) }, hardware);
  assert.equal(engine.state, 'ready');
  assert.equal(engine.ready, true);
  assert.equal(engine.error, undefined);
  assert.equal(catalog.modelsError, undefined);
  assert.equal(catalog.models.length, MODEL_CATALOG.length);
  assert.ok(catalog.models.every(model => !model.installed));
});

test('engine initialization stays distinguishable from real failures and missing selected weights', () => {
  const starting = desktopRuntimeStatus(current('starting'));
  assert.equal(starting.ready, false);
  assert.equal(starting.state, 'starting');
  assert.equal(starting.error, undefined);
  const failed = desktopRuntimeStatus(current('error', { code: 'ENGINE_DIGEST_MISMATCH', message: 'Reinstall the damaged engine.' }));
  assert.equal(failed.ready, false);
  assert.equal(failed.state, 'error');
  assert.equal(failed.errorCode, 'ENGINE_DIGEST_MISMATCH');
  assert.equal(failed.error, 'Reinstall the damaged engine.');
  const absent = desktopRuntimeStatus(current('ready', { code: 'MODEL_NOT_FOUND', message: 'Download this model first.' }));
  assert.equal(absent.ready, true);
  assert.equal(absent.error, undefined);
  assert.equal(absent.errorCode, undefined);
  const componentFailure = desktopRuntimeStatus(current(), 'Bundled file tools are missing. Rebuild the desktop package.');
  assert.equal(componentFailure.state, 'error');
  assert.equal(componentFailure.ready, false);
  assert.equal(componentFailure.errorCode, 'AGENT_COMPONENTS_MISSING');
});

test('catalog discovery errors expose an actionable failure and never claim cached models installed', async () => {
  const catalog = await discoverDesktopModels({ listModels: async () => { throw new Error('Permission denied.'); } }, hardware);
  assert.match(catalog.modelsError!, /Check access to the model cache and retry.*Permission denied/);
  assert.equal(catalog.models.length, MODEL_CATALOG.length);
  assert.ok(catalog.models.every(model => !model.installed && model.blockedReason?.includes('Retry')));
  const recovered = await discoverDesktopModels({ listModels: async () => [] }, hardware);
  assert.equal(recovered.modelsError, undefined);
});

test('known model integrity failures remain scoped to their catalog row rather than an engine failure', async () => {
  const failure = 'The model does not match its pinned SHA-256. Download or import the approved file again.';
  const catalog = await discoverDesktopModels({ listModels: async () => [{ ...MODEL_CATALOG[0],
    ...classifyModel(MODEL_CATALOG[0], hardware), installed: true, sizeBytes: MODEL_CATALOG[0].estimatedDownloadBytes,
    digest: null, blockedReason: failure, verificationError: failure }] }, hardware);
  assert.equal(catalog.models[0].verificationError, failure);
  assert.equal(catalog.models[0].blockedReason, failure);
  assert.equal(catalog.modelsError, undefined);
  assert.equal(desktopRuntimeStatus(current()).error, undefined);
});

test('missing selections fail before inspecting a model or starting task work', async () => {
  let reads = 0, inspections = 0;
  await assert.rejects(assertInferenceReady({
    getStatus: () => { reads++; return current(); },
    inspectModel: async model => { inspections++; return verified(model); },
  }, null), { code: 'MODEL_NOT_FOUND' });
  assert.equal(reads, 0);
  assert.equal(inspections, 0);
});

test('preparing engines and actual engine failures reject before model inspection', async () => {
  let inspections = 0;
  const inspectModel = async (model: string) => { inspections++; return verified(model); };
  await assert.rejects(assertInferenceReady({ getStatus: () => current('starting'), inspectModel }, 'qwen3.5:4b'), { code: 'ENGINE_PREPARING' });
  await assert.rejects(assertInferenceReady({ getStatus: () => current('error', { code: 'ENGINE_DIGEST_MISMATCH', message: 'Engine is damaged.' }), inspectModel }, 'qwen3.5:4b'), { code: 'ENGINE_DIGEST_MISMATCH', message: 'Engine is damaged.' });
  assert.equal(inspections, 0);
});

test('stale or corrupt selected models fail verification before executing a task', async () => {
  for (const code of ['MODEL_NOT_FOUND', 'MODEL_DIGEST_MISMATCH']) {
    const engine = current();
    await assert.rejects(assertInferenceReady({ getStatus: () => engine,
      inspectModel: async () => { throw new RuntimeError(code, 'Choose a valid local model.'); } }, 'qwen3.5:4b'), { code });
    assert.equal(engine.state, 'ready');
    assert.equal(engine.error, null);
  }
  const inspected: string[] = [];
  await assertInferenceReady({ getStatus: () => current(), inspectModel: async model => { inspected.push(model); return verified(model); } }, 'qwen3.5:4b');
  assert.deepEqual(inspected, ['qwen3.5:4b']);
});

test('Stop cancels model verification before any task continuation', async () => {
  const controller = new AbortController();
  let inspected!: () => void;
  const started = new Promise<void>(resolve => { inspected = resolve; });
  let continuations = 0;
  const preparing = assertInferenceReady({ getStatus: () => current(), inspectModel: async (model, options) => {
    assert.equal(options?.signal, controller.signal);
    inspected();
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    return verified(model);
  } }, 'qwen3.5:4b', controller.signal).then(() => { continuations++; });
  await started;
  controller.abort(new Error('Stopped before loading or staging'));
  await assert.rejects(preparing, /Stopped before loading or staging/);
  assert.equal(continuations, 0);
});

test('a model reader that resolves after Stop cannot start a session or turn', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const preparing = assertInferenceReady({ getStatus: () => current(), inspectModel: async model => { await held; return verified(model); } }, 'qwen3.5:4b', controller.signal);
  controller.abort(new Error('Task preparation stopped'));
  finish();
  await assert.rejects(preparing, /Task preparation stopped/);
  let inspections = 0;
  await assert.rejects(assertInferenceReady({ getStatus: () => current(), inspectModel: async model => { inspections++; return verified(model); } }, 'qwen3.5:4b', controller.signal), /Task preparation stopped/);
  assert.equal(inspections, 0);
});

test('completed downloads select a first model, replace missing selections, and retain valid existing selections', async () => {
  const inspections: string[] = [];
  const inspector = { inspectModel: async (model: string) => {
    inspections.push(model);
    if (model === 'missing') throw new RuntimeError('MODEL_NOT_FOUND', 'No local weights.');
    return verified(model);
  } };
  assert.equal(await selectionAfterDownload(inspector, null, 'new'), 'new');
  assert.equal(await selectionAfterDownload(inspector, 'new', 'new'), 'new');
  assert.equal(await selectionAfterDownload(inspector, 'missing', 'new'), 'new');
  assert.equal(await selectionAfterDownload(inspector, 'existing', 'new'), 'existing');
  assert.deepEqual(inspections, ['missing', 'existing']);
});

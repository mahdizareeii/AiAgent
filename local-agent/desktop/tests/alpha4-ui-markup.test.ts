import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import type { AgentStatus, TaskOutcome } from '../renderer/types.ts';

// Render the real components without launching Electron or a browser. The
// fixture lives only in the test's temporary compiled module.
const temporary = await mkdtemp(path.join(tmpdir(), 'local-agent-ui-markup-'));
const renderer = fileURLToPath(new URL('../renderer/', import.meta.url));
const compiled = await build({ stdin: { contents: `
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelSetup, { activeModelDownload, ModelDownloadStatus } from './ModelSetup.tsx';
import TaskOutcomeDetails from './TaskOutcomeDetails.tsx';
import PreferenceChoice from './PreferenceChoice.tsx';
import App, { modelReadyForConversation, nextDisplayError, bindDisplayErrorToTrial, newFailedTrialId } from './App.tsx';
import WorkingDetails from './WorkingDetails.tsx';
import TrialHistory from './TrialHistory.tsx';
export const setup = props => renderToStaticMarkup(createElement(ModelSetup, props));
export const outcome = value => renderToStaticMarkup(createElement(TaskOutcomeDetails, {outcome: value}));
export const choice = props => renderToStaticMarkup(createElement(PreferenceChoice, props));
export const app = () => { globalThis.window = {}; return renderToStaticMarkup(createElement(App)); };
export const working = props => renderToStaticMarkup(createElement(WorkingDetails, props));
export const download = props => renderToStaticMarkup(createElement(ModelDownloadStatus, props));
export const history = props => renderToStaticMarkup(createElement(TrialHistory, props));
export const trialControl = props => {
  const find = (element, predicate) => {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    for (const child of [element.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found; }
  };
  const trial = find(ModelSetup(props), element => typeof element.type === 'function' && element.type.name === 'Trial');
  if (!trial) return undefined;
  const button = find(trial.type(trial.props), element => element.type === 'button' && element.props.children === 'Cancel trial');
  return button && { disabled: button.props.disabled, click: button.props.onClick };
};
export { activeModelDownload, modelReadyForConversation, nextDisplayError, bindDisplayErrorToTrial, newFailedTrialId };
`, resolveDir: renderer, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const fixturePath = path.join(temporary, 'fixture.cjs');
await writeFile(fixturePath, compiled.outputFiles[0].contents);
interface ErrorFixtureState { message: string | null; revision: number; trialId?: string; }
const fixture = createRequire(import.meta.url)(fixturePath) as {
  nextDisplayError: (current: ErrorFixtureState, update: string | null | ((current: string | null) => string | null), revision: number) => ErrorFixtureState;
  bindDisplayErrorToTrial: (current: ErrorFixtureState, revision: number, trialId: string) => ErrorFixtureState;
  newFailedTrialId: (status: AgentStatus | undefined, modelId: string, previousTrialId: string | undefined) => string | undefined;
  setup: (props: object) => string; outcome: (outcome: TaskOutcome) => string; choice: (props: object) => string; app: () => string; working: (props: object) => string; download: (props: object) => string; history: (props: object) => string; trialControl: (props: object) => { disabled: boolean; click: () => void } | undefined; activeModelDownload: (local: object | null, status: object | null) => object | null; modelReadyForConversation: (status: AgentStatus | null, download: object | null) => boolean };
after(async () => { await rm(temporary, { recursive: true, force: true }); });

const status: AgentStatus = {
  runtime: { ready: true, state: 'ready' },
  hardware: { platform: 'darwin', architecture: 'arm64', cpuModel: 'Test CPU', cpuCores: 8, totalMemoryBytes: 24 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3, gpus: [] },
  models: [{ id: 'test', name: 'Test model', installed: true, description: 'Local model', fit: 'recommended', fitReason: 'Estimated fit', license: 'Apache-2.0', quantization: 'Q4_K_M', downloadGB: 2, workingMemoryGB: 5, toolCapable: true }],
  mode: 'coding', utilities: { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false }, plugins: { taskResearch: false }, slowMode: false, selectedModel: 'test', recommendation: null, sessions: [],
};
const noop = async () => {};
const props = { status, mode: 'coding', ready: true, busy: false, setupBusy: false, calibrating: null, trialModel: null, validating: null, importing: false, download: null, stage: null, error: null, hasBridge: true, dialogRef: { current: null }, onKeyDown: () => {}, onClose: () => {}, onSetup: noop, onImport: noop, onCalibrate: noop, onSelect: noop, onDownload: noop, onCancelDownload: noop, onSlowMode: noop, onMemoryMode: noop, onTryModel: noop, onCancelTrial: noop, onValidate: noop };

function buttonWithText(html: string, text: string) {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return buttons.find(button => button.includes(text)) ?? assert.fail(`Missing ${text} button`);
}

test('memory and model checks stay in Advanced after the model cards', () => {
  const html = fixture.setup(props);
  assert.match(html, /role="option"[^>]*>[\s\S]*?Automatic/);
  assert.match(html, /role="option"[^>]*>[\s\S]*?Low memory/);
  assert.doesNotMatch(html, /Experimental disk/);
  assert.doesNotMatch(html, /<select\b/);
  assert.doesNotMatch(buttonWithText(html, 'Validate model for tasks'), /disabled=""/);
  assert.doesNotMatch(html, /Agent tools calibrated/);
  assert.ok(html.indexOf('class="model-cards"') < html.indexOf('class="model-advanced"'));
  assert.ok(html.indexOf('class="model-advanced"') < html.indexOf('aria-label="Detected hardware"'));
  assert.ok(html.indexOf('class="model-advanced"') < html.indexOf('Validate model for tasks'));
});

test('failed oversized experimental trials remain retryable without relabeling memory fit', () => {
  const html = fixture.setup({ ...props, ready: false, status: { ...status, memoryMode: 'automatic', runtime: { ready: false, state: 'error', error: 'Trial resident limit reached' }, models: [{ ...status.models[0], fit: 'insufficient', ssdEligibility: { supported: true, reason: 'Supported routed experts', minimumSlotsPerLayer: 24, engineReady: true } }], experimentalTrial: { modelId: 'test', mode: 'ssd-experts', state: 'failed', reason: 'Resident limit reached', rssBytes: 2 * 1024 ** 3, pressure: 'warning' } } });
  assert.doesNotMatch(buttonWithText(html, 'Try from SSD'), /disabled=""/);
  assert.match(buttonWithText(html, 'Validate model for tasks'), /disabled=""/);
  assert.match(html, /Insufficient memory/);
  assert.match(html, /Memory pressure<\/dt><dd>warning/);
  assert.match(html, /Expert cache<\/dt><dd>Unknown/);
  assert.match(html, /Last RSS sample<\/dt><dd>2\.00 GiB/);
  assert.match(html, /Last available sample<\/dt><dd>Unknown/);
  assert.doesNotMatch(html, /Resident now<\/dt>|Available now<\/dt>/);
});

test('an active model trial can be cancelled while other settings are locked', () => {
  const html = fixture.setup({ ...props, busy: true, trialModel: 'test', status: { ...status, memoryMode: 'experimental-disk', experimentalTrial: { id: 'trial-active', modelId: 'test', state: 'loading' } } });
  assert.doesNotMatch(buttonWithText(html, 'Cancel trial'), /disabled=""/);
  assert.match(buttonWithText(html, 'Previous mapped-weight mode'), /disabled=""/);
  assert.match(html, /Loading trial model/);
});

test('a restored trial locks model actions and cancellation requires its displayed identity', () => {
  const trial = { modelId: 'test', mode: 'ssd-experts', state: 'loading' };
  const unidentified = fixture.setup({ ...props, status: { ...status, experimentalTrial: trial } });
  assert.match(buttonWithText(unidentified, 'Cancel trial'), /disabled/);
  assert.match(buttonWithText(unidentified, 'Import GGUF'), /disabled/);
  assert.match(buttonWithText(unidentified, 'Automatic'), /disabled/);
  const identified = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, id: 'restored-trial' } } });
  assert.doesNotMatch(buttonWithText(identified, 'Cancel trial'), /disabled/);
  assert.match(buttonWithText(identified, 'Back to task'), /disabled/);
});

test('a late trial cancellation carries its captured identity rather than the newer displayed trial', () => {
  const cancelled: string[] = [];
  const onCancelTrial = async (id: string) => { cancelled.push(id); };
  const trial = { id: 'old-trial', modelId: 'test', mode: 'ssd-experts', state: 'loading' };
  const old = fixture.trialControl({ ...props, onCancelTrial, status: { ...status, experimentalTrial: trial } });
  const newer = fixture.trialControl({ ...props, onCancelTrial, status: { ...status, experimentalTrial: { ...trial, id: 'new-trial' } } });
  assert.ok(old && newer);
  old.click();
  assert.deepEqual(cancelled, ['old-trial']);
  newer.click();
  assert.deepEqual(cancelled, ['old-trial', 'new-trial']);
  const unidentified = fixture.trialControl({ ...props, onCancelTrial, status: { ...status, experimentalTrial: { ...trial, id: undefined } } });
  assert.ok(unidentified?.disabled);
  unidentified.click();
  assert.equal(cancelled.length, 2, 'Missing identity must not issue an unscoped cancellation even through the callback.');
});

test('a Chat-only SSD trial never claims tools or a full task passed', () => {
  const trial = { id: 'trial-chat-only', modelId: 'test', mode: 'ssd-experts', state: 'passed', probePassed: true, toolProbePassed: false, finishedAt: '2026-10-13T12:00:00Z' };
  const html = fixture.setup({ ...props, status: { ...status, experimentalTrial: trial } });
  assert.match(html, /Load and Chat probe passed/);
  assert.match(html, /Chat only\. Task tool format did not pass\./);
  assert.match(html, /Trial ID: <code>trial-chat-only<\/code>/);
  assert.match(html, /Finished:/);
  assert.doesNotMatch(html, /Load and probes passed|Tool format passed\. Task quality|Task validation passed/);
  const passedTools = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, toolProbePassed: true } } });
  assert.match(passedTools, /Tool format passed\. Task quality needs separate checks\./);
  const noProbeEvidence = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, probePassed: undefined, toolProbePassed: undefined } } });
  assert.match(noProbeEvidence, /Trial result unverified/);
  assert.match(noProbeEvidence, /Task tool format is unverified/);
  assert.doesNotMatch(noProbeEvidence, /Load and Chat probe passed/);
});

test('trial diagnostics preserve the owned trial identity and actionable error separately from task evidence', () => {
  const html = fixture.setup({ ...props, status: { ...status, experimentalTrial: { id: 'trial-stopped', modelId: 'test', state: 'stopped', error: { code: 'SSD_MEMORY_LIMIT', message: 'Resident limit reached.' }, finishedAt: '2026-10-13T12:00:00Z' } } });
  assert.match(html, /Trial ID: <code>trial-stopped<\/code>/);
  assert.match(html, /Error code: <code>SSD_MEMORY_LIMIT<\/code>/);
  assert.match(html, /role="alert">Resident limit reached\./);
  assert.doesNotMatch(html, /Load and Chat probe passed/);
  const mapped = fixture.setup({ ...props, status: { ...status, experimentalTrial: { id: 'trial-mapped', modelId: 'test', state: 'failed', reason: 'Monitoring stopped.', errorCode: 'SSD_MONITORING_LOST' } } });
  assert.match(mapped, /Error code: <code>SSD_MONITORING_LOST<\/code>/);
  assert.match(mapped, /role="alert">Monitoring stopped\./);
});

test('a settled failed trial presents its exact duplicate error once while unrelated or new errors remain visible', () => {
  const reason = 'The exact Chat probe failed with finish=length.';
  const failedStatus = { ...status, experimentalTrial: { id: 'failed-visible-trial', modelId: 'test', state: 'failed', reason } };
  const duplicate = fixture.setup({ ...props, status: failedStatus, error: `RuntimeError: ${reason}`, errorTrialId: 'failed-visible-trial' });
  assert.equal((duplicate.match(/The exact Chat probe failed with finish=length\./g) ?? []).length, 1);
  assert.doesNotMatch(duplicate, /RuntimeError:/);
  for (const patch of [{ error: 'Import failed: model checksum mismatch.' }, { error: `RuntimeError: ${reason}`, importing: true }, { error: `RuntimeError: ${reason}`, calibrating: 'other-model' }, { error: `RuntimeError: ${reason}`, download: { modelId: 'other-model', progress: { status: 'Downloading' } } }, { error: `RuntimeError: ${reason}`, trialModel: 'new-trial-model' }]) {
    const unrelated = fixture.setup({ ...props, status: failedStatus, errorTrialId: 'failed-visible-trial', ...patch });
    assert.ok(unrelated.includes(patch.error), 'A separate or active operation error must remain visible.');
  }
  const different = fixture.setup({ ...props, status: failedStatus, error: `${reason} Extra diagnostic detail.` });
  assert.match(different, /Extra diagnostic detail/);
  for (const errorTrialId of [undefined, 'older-trial', 'newer-trial']) {
    const unowned = fixture.setup({ ...props, status: failedStatus, error: `RuntimeError: ${reason}`, errorTrialId });
    assert.equal((unowned.match(/The exact Chat probe failed with finish=length\./g) ?? []).length, 2, 'Identical text from an unrelated or stale origin remains visible.');
  }
});

test('error provenance is atomic, cleared by every message update, and never restored by stale confirmation', () => {
  const first = fixture.nextDisplayError({ message: null, revision: 0 }, 'RuntimeError: Probe failed.', 1);
  const owned = fixture.bindDisplayErrorToTrial(first, 1, 'new-failed-trial');
  assert.equal(owned.trialId, 'new-failed-trial');
  const sameTextUnrelated = fixture.nextDisplayError(owned, owned.message, 2);
  assert.equal(sameTextUnrelated.message, owned.message);
  assert.equal(sameTextUnrelated.trialId, undefined);
  assert.equal(fixture.bindDisplayErrorToTrial(sameTextUnrelated, 1, 'new-failed-trial'), sameTextUnrelated);
  const rebound = fixture.bindDisplayErrorToTrial(sameTextUnrelated, 2, 'another-failed-trial');
  const functional = fixture.nextDisplayError(rebound, current => current ?? 'Other error.', 3);
  assert.equal(functional.message, rebound.message);
  assert.equal(functional.trialId, undefined, 'Functional updates clear provenance even when they retain the same text.');
  const cleared = fixture.nextDisplayError(owned, null, 4);
  assert.equal(cleared.message, null);
  assert.equal(cleared.trialId, undefined);
});

test('fresh trial-error attribution requires a new failed identity for the requested model', () => {
  const fresh = { ...status, experimentalTrial: { id: 'new-failed-trial', modelId: 'test', state: 'failed', reason: 'Probe failed.' } };
  assert.equal(fixture.newFailedTrialId(fresh, 'test', 'prior-trial'), 'new-failed-trial');
  assert.equal(fixture.newFailedTrialId(fresh, 'test', 'new-failed-trial'), undefined);
  assert.equal(fixture.newFailedTrialId(fresh, 'other-model', 'prior-trial'), undefined);
  for (const state of ['loading', 'calibrating', 'passed', 'cancelled', 'stopped']) assert.equal(fixture.newFailedTrialId({ ...fresh, experimentalTrial: { ...fresh.experimentalTrial, state } }, 'test', 'prior-trial'), undefined);
  assert.equal(fixture.newFailedTrialId({ ...fresh, experimentalTrial: { ...fresh.experimentalTrial, id: undefined } }, 'test', 'prior-trial'), undefined);
  assert.equal(fixture.newFailedTrialId(undefined, 'test', 'prior-trial'), undefined);
});

test('SSD resource counters preserve measured zero while missing counters remain Unknown', () => {
  const trial = { id: 'trial-zero', modelId: 'test', mode: 'ssd-experts', state: 'failed', streaming: { cacheBytes: 0, bytesRead: 0, cacheHits: 0, cacheMisses: 1035, expertGroups: 30, expectedExpertGroups: 30 } };
  const measured = fixture.setup({ ...props, status: { ...status, experimentalTrial: trial } });
  assert.match(measured, /Cache hits \/ misses<\/dt><dd>0 \/ 1035<\/dd>/);
  assert.match(measured, /Expert cache<\/dt><dd>0\.00 GiB<\/dd>/);
  assert.match(measured, /Read from SSD<\/dt><dd>0\.00 GiB<\/dd>/);
  const absent = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, streaming: { ...trial.streaming, cacheHits: undefined } } } });
  assert.match(absent, /Cache hits \/ misses<\/dt><dd>Unknown \/ 1035<\/dd>/);
  const fallbackZero = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, cacheHits: 0, streaming: { ...trial.streaming, cacheHits: undefined } } } });
  assert.match(fallbackZero, /Cache hits \/ misses<\/dt><dd>0 \/ 1035<\/dd>/);
});

test('actual compute kernel and parity diagnostics are closed in Advanced and preserve zero and false', () => {
  const reportDigest = 'b'.repeat(64);
  const trial = { id: 'trial-compute', modelId: 'test', mode: 'ssd-experts', state: 'failed', backendValidation: 'validated', parityReportDigest: reportDigest,
    streaming: { cpuKernel: 'standard', useExtraBufts: false, cpuRepackTensorCount: 0, decodeThreads: 4, batchThreads: 4 } };
  const html = fixture.setup({ ...props, status: { ...status, experimentalTrial: trial } });
  assert.ok(html.indexOf('class="model-advanced"') < html.indexOf('aria-label="Compute kernel diagnostics"'));
  assert.match(html, /<details class="model-validation review-block" aria-label="Compute kernel diagnostics">/);
  assert.doesNotMatch(html, /aria-label="Compute kernel diagnostics"[^>]*open=/);
  assert.match(html, /CPU kernel<\/dt><dd>standard/);
  assert.match(html, /Extra CPU buffer types<\/dt><dd>Disabled/);
  assert.match(html, /Repacked tensors<\/dt><dd>0/);
  assert.match(html, /Decode threads<\/dt><dd>4/);
  assert.match(html, /Batch threads<\/dt><dd>4/);
  assert.match(html, /Backend validation<\/dt><dd>validated/);
  assert.match(html, new RegExp(`Parity report digest: <code>${reportDigest}<\\/code>`));
  assert.match(html, /Task quality requires its own checks/);
  const qa = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, backendValidation: 'qa-unvalidated', streaming: { ...trial.streaming, cpuKernel: 'default', useExtraBufts: true, cpuRepackTensorCount: 12 } } } });
  assert.match(qa, /CPU kernel<\/dt><dd>default/);
  assert.match(qa, /Extra CPU buffer types<\/dt><dd>Enabled/);
  assert.match(qa, /Repacked tensors<\/dt><dd>12/);
  assert.match(qa, /Backend validation<\/dt><dd>qa-unvalidated/);
});

test('unobserved kernel fields stay Unreported and never substitute expected thread or repack values', () => {
  const trial = { modelId: 'test', mode: 'ssd-experts', state: 'loading', streaming: { cpuKernel: 'unknown', useExtraBufts: null, cpuRepackTensorCount: null, decodeThreads: null, batchThreads: null } };
  const html = fixture.setup({ ...props, status: { ...status, experimentalTrial: trial } });
  for (const label of ['CPU kernel', 'Extra CPU buffer types', 'Repacked tensors', 'Decode threads', 'Batch threads', 'Backend validation']) assert.match(html, new RegExp(`${label}<\\/dt><dd>Unreported`));
  assert.match(html, /Parity report digest: <code>Unreported<\/code>/);
  assert.doesNotMatch(html, /Decode threads<\/dt><dd>4|Repacked tensors<\/dt><dd>0/);
});

test('fixed probe diagnostics stay in Advanced and show actual bounded failures, counts, and identity', () => {
  const binding = { model: 'test', digest: 'model-digest', templateHash: 'template-digest', runtime: 'engine-digest', profileSignature: 'cpu-ssd-profile', trialId: 'trial-probe' };
  const chat = { kind: 'chat', passed: false, requestedOutputTokens: 16, thinkingDisabled: true, finishReason: 'length', content: '', reasoning: '<script>probe reasoning</script>', outputTokens: 16, reasoningTokens: 16, toolCalls: [], toolCallCount: 0, truncated: false, binding };
  const tools = { ...chat, kind: 'tools', passed: true, requestedOutputTokens: 96, finishReason: 'tool_calls', content: null, reasoning: null, outputTokens: 20, reasoningTokens: 0, toolCalls: [{ name: 'local_probe', arguments: '{"word":"OK"}' }], toolCallCount: 1 };
  const html = fixture.setup({ ...props, status: { ...status, experimentalTrial: { id: binding.trialId, modelId: 'test', state: 'failed', probes: { chat, tools } } } });
  assert.ok(html.indexOf('class="model-advanced"') < html.indexOf('aria-label="Fixed local probe diagnostics"'));
  assert.match(html, /Chat probe · Failed/);
  assert.match(html, /Tool-format probe · Passed \(recorded\)/);
  assert.match(html, /Finish reason<\/dt><dd>length/);
  assert.match(html, /Output tokens<\/dt><dd>16 \/ 16 allowed/);
  assert.match(html, /Reasoning tokens<\/dt><dd>0/);
  assert.match(html, /Tool calls<\/dt><dd>0/);
  assert.match(html, /\(empty string\)/);
  assert.match(html, /&lt;script&gt;probe reasoning&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /local_probe/);
  assert.match(html, /word.*OK/);
  for (const value of Object.values(binding)) assert.ok(html.includes(value));
  assert.match(html, /They do not establish task quality/);
});

test('missing fixed probes remain unverified and oversized diagnostic excerpts cannot flood the view', () => {
  const missing = fixture.setup({ ...props, status: { ...status, experimentalTrial: { modelId: 'test', state: 'loading' } } });
  assert.match(missing, /Chat probe · Unverified/);
  assert.match(missing, /Tool-format probe · Unverified/);
  const chat = { kind: 'chat', passed: false, requestedOutputTokens: 16, thinkingDisabled: true, finishReason: null, content: 'x'.repeat(5000), reasoning: null, outputTokens: null, reasoningTokens: null,
    toolCalls: Array.from({ length: 8 }, () => ({ name: 'n'.repeat(500), arguments: 'a'.repeat(5000) })), toolCallCount: 8, truncated: true, binding: { model: 'test' } };
  const html = fixture.setup({ ...props, status: { ...status, experimentalTrial: { modelId: 'test', state: 'failed', probes: { chat } } } });
  assert.match(html, /Bounded excerpts are shown/);
  assert.match(html, /Tool calls<\/dt><dd>8/);
  assert.doesNotMatch(html, /Tool call 3:|x{513}|a{513}|n{129}/);
  assert.match(html, /Finish reason<\/dt><dd>Unreported/);
  assert.match(html, /Output tokens<\/dt><dd>Unreported \/ 16 allowed/);
  assert.match(html, /Template digest<\/dt><dd><code>Unreported/);
});

test('SSD attempt history is closed inside Advanced and never establishes current readiness', () => {
  const entry = { id: 'past-trial', model: 'test', mode: 'ssd-experts', state: 'passed', startedAt: '2026-10-13T08:00:00Z', finishedAt: '2026-10-13T08:10:00Z', profileSignature: 'past-profile', artifactSetDigest: 'past-model-digest', templateDigest: 'past-template', engineDigest: 'past-engine', patchDigest: 'past-patch', checks: { chat: 'passed', tools: 'unverified' }, error: null };
  const oldStatus = { ...status, memoryMode: 'ssd-experts', experimentalTrial: undefined, trialHistory: [entry] };
  const html = fixture.setup({ ...props, ready: false, status: oldStatus });
  assert.ok(html.indexOf('class="model-advanced"') < html.indexOf('aria-label="Historical SSD attempts"'));
  assert.match(html, /<details class="model-validation review-block" aria-label="Historical SSD attempts">/);
  assert.doesNotMatch(html, /aria-label="Historical SSD attempts"[^>]*open=/);
  assert.match(html, /They do not activate models or establish current readiness/);
  assert.match(html, /Recorded Chat check<\/dt><dd>Passed \(recorded\)/);
  assert.match(html, /Recorded tool-format check<\/dt><dd>Unverified/);
  assert.match(html, /Tool-format probe · Unverified/);
  assert.match(html, /title="2026-10-13T08:00:00Z"/);
  for (const value of ['past-trial', 'past-profile', 'past-model-digest', 'past-template', 'past-engine', 'past-patch']) assert.ok(html.includes(value));
  assert.equal(fixture.modelReadyForConversation(oldStatus as AgentStatus, null), false);
  assert.doesNotMatch(html, />Use historical|>Resume attempt|Load and Chat probe passed/);
});

test('historical failed and incomplete checks preserve recorded probes and honest resource samples', () => {
  const entry = { id: 'failed-history', model: 'test', mode: 'ssd-experts', state: 'failed', startedAt: '2026-10-13T08:00:00Z', profileSignature: 'failed-profile', checks: { chat: 'failed', tools: 'unverified' }, error: { code: 'CHAT_PROBE_FAILED', message: '<script>probe failed</script>' },
    probes: { chat: { kind: 'chat', passed: false, requestedOutputTokens: 16, thinkingDisabled: true, finishReason: 'length', content: '', reasoning: 'Actual fixed-probe response', outputTokens: 16, reasoningTokens: null, toolCalls: [], toolCallCount: 0, truncated: false, binding: { model: 'test', trialId: 'failed-history', profileSignature: 'failed-profile' } } },
    resources: { residentBudgetBytes: 6 * 1024 ** 3, measurements: { sampledAt: '2026-10-13T08:01:00Z', residentBytes: 4 * 1024 ** 3, rssBytes: 3 * 1024 ** 3, physicalFootprintBytes: 4 * 1024 ** 3, availableMemoryBytes: 2 * 1024 ** 3, pressure: 'normal' }, streaming: { expectedGroups: 30, streamedGroups: 30, cacheSlotsPerLayer: 24, expertCacheBytes: 0, bytesRead: 0, cacheMisses: 0, waves: 0 } } };
  const html = fixture.history({ entries: [entry, { ...entry, id: 'interrupted-history', state: 'incomplete', probes: undefined, checks: { chat: 'unverified', tools: 'unverified' }, error: { code: 'SSD_TRIAL_INTERRUPTED', message: 'Closed before probes completed.' } }], models: status.models });
  assert.match(html, /Recorded Chat check<\/dt><dd>Failed/);
  assert.match(html, /Chat probe · Failed/);
  assert.match(html, /Actual fixed-probe response/);
  assert.match(html, /&lt;script&gt;probe failed&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Resident budget<\/dt><dd>6\.00 GiB/);
  assert.match(html, /Physical footprint sample<\/dt><dd>4\.00 GiB/);
  assert.match(html, /RSS sample<\/dt><dd>3\.00 GiB/);
  assert.match(html, /Expert cache<\/dt><dd>0\.00 GiB/);
  assert.match(html, /Cache misses<\/dt><dd>0/);
  assert.match(html, /SSD_TRIAL_INTERRUPTED/);
  assert.match(html, /Chat probe · Unverified/);
  assert.doesNotMatch(html, /current model ready|activat.*button/i);
});

test('historical attempts retain the observed CPU kernel, threads and certificate without restoring readiness', () => {
  const digest = 'd'.repeat(64);
  const entry = { id: 'history-kernel', model: 'test', mode: 'ssd-experts', state: 'stopped', startedAt: '2026-10-13T08:00:00Z', profileSignature: 'old-profile', checks: { chat: 'unverified', tools: 'unverified' }, error: null,
    backendValidation: 'validated', parityReportDigest: digest, resources: { residentBudgetBytes: null, streaming: { expectedGroups: 30, streamedGroups: 30, cacheSlotsPerLayer: 24, expertCacheBytes: 0, cpuKernel: 'standard', useExtraBufts: false, cpuRepackTensorCount: 0, decodeThreads: 4, batchThreads: 4 } } };
  const html = fixture.history({ entries: [entry], models: status.models });
  assert.match(html, /CPU kernel<\/dt><dd>standard/);
  assert.match(html, /Extra CPU buffer types<\/dt><dd>Disabled/);
  assert.match(html, /Repacked tensors<\/dt><dd>0/);
  assert.match(html, /Decode threads<\/dt><dd>4/);
  assert.match(html, /Batch threads<\/dt><dd>4/);
  assert.match(html, /Backend validation<\/dt><dd>validated/);
  assert.match(html, new RegExp(`Parity report digest: <code>${digest}<\\/code>`));
  assert.match(html, /<details class="model-validation review-block" aria-label="Compute kernel diagnostics">/);
  assert.match(html, /They do not activate models or establish current readiness/);
  const legacy = fixture.history({ entries: [{ ...entry, backendValidation: undefined, parityReportDigest: undefined, resources: { residentBudgetBytes: null } }], models: status.models });
  assert.match(legacy, /CPU kernel<\/dt><dd>Unreported/);
  assert.match(legacy, /Decode threads<\/dt><dd>Unreported/);
  assert.match(legacy, /Parity report digest: <code>Unreported<\/code>/);
});

test('history errors stay diagnostic, and the historical view is bounded to one hundred attempts', () => {
  const entry = { model: 'test', mode: 'ssd-experts', state: 'stopped', startedAt: '2026-10-13T08:00:00Z', profileSignature: '', checks: { chat: 'unverified', tools: 'unverified' }, error: null };
  const entries = Array.from({ length: 105 }, (_, index) => ({ ...entry, id: `attempt-${index}` }));
  const html = fixture.history({ entries, error: { code: 'SSD_HISTORY_UNAVAILABLE', message: 'History could not be saved.' }, models: [] });
  assert.match(html, /Historical SSD attempts · 100/);
  assert.equal((html.match(/aria-label="Historical SSD attempt:/g) ?? []).length, 100);
  assert.doesNotMatch(html, /attempt-100/);
  assert.ok(html.indexOf('attempt-0') < html.indexOf('attempt-1'));
  assert.match(html, /role="alert"><strong>SSD_HISTORY_UNAVAILABLE/);
  assert.match(html, /Inference does not use this history/);
});

test('trial preparation shows real integrity bytes and actual stages without invented loading percentages', () => {
  const trial = { id: 'trial-integrity', modelId: 'test', state: 'loading', progress: { stage: 'verifying', message: 'Checking pinned checksums', completedBytes: 7 * 1024 ** 3, totalBytes: 14 * 1024 ** 3 } };
  const html = fixture.setup({ ...props, trialModel: 'test', status: { ...status, experimentalTrial: trial } });
  assert.match(html, /Verifying model files…/);
  assert.match(html, /Checking pinned checksums · 7\.0 GiB \/ 14\.0 GiB/);
  assert.match(html, /role="progressbar" aria-label="Model file verification"/);
  assert.match(html, /style="width:50%"/);
  assert.doesNotMatch(buttonWithText(html, 'Cancel trial'), /disabled/);
  for (const [stage, message] of [['planning', 'Checking the memory budget…'], ['loading', 'Loading trial model…'], ['probing', 'Checking Chat and tool format…']]) {
    const prepared = fixture.setup({ ...props, trialModel: 'test', status: { ...status, experimentalTrial: { ...trial, progress: { stage } } } });
    assert.ok(prepared.includes(message));
    assert.doesNotMatch(prepared, /role="progressbar"|style="width:[0-9]+%"/);
  }
  const unknown = fixture.setup({ ...props, trialModel: 'test', status: { ...status, experimentalTrial: { ...trial, progress: { stage: 'verifying', message: 'Checking model files' } } } });
  assert.match(unknown, /Checking model files/);
  assert.doesNotMatch(unknown, /role="progressbar"/);
  const stopped = fixture.setup({ ...props, status: { ...status, experimentalTrial: { ...trial, state: 'stopped', reason: 'Cancelled during verification' } } });
  assert.match(stopped, /Trial stopped/);
  assert.match(stopped, /Recorded stage: verifying/);
  assert.doesNotMatch(stopped, /aria-label="Model trial progress"/);
});

test('the task interface has one workspace choice and one model button without redundant agent selectors', () => {
  const html = fixture.app();
  assert.match(html, />New task<\/button>/);
  assert.match(html, />New chat<\/button>/);
  assert.equal((html.match(/aria-label="Workspace folder:/g) ?? []).length, 1);
  assert.equal((html.match(/class="composer-chip model-library-button"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Task mode:|Agent approach|Careful Agent|Standard Agent|strategy-note|model-settings/);
});

test('Working retains actual thinking, tool inputs, results, and execution status when expanded', () => {
  const html = fixture.working({ active: true, expanded: true, thinking: 'Inspect existing files first.', tools: [{ id: 'read', title: 'read_file', status: 'completed', input: { path: 'notes.txt' }, output: 'Verified exact content' }] });
  assert.match(html, /<details class="working-details is-active" open=""/);
  assert.match(html, /<summary class="working-status" aria-label="Working"/);
  assert.match(html, /Inspect existing files first\./);
  assert.match(html, /read_file/);
  assert.match(html, /notes\.txt/);
  assert.match(html, /Verified exact content/);
  assert.match(html, />completed<\/span>/);
  const noThinking = fixture.working({ active: false, expanded: true, tools: [] });
  assert.match(noThinking, /This model did not provide thinking text/);
});

test('an oversized model can be downloaded before runtime preparation but disk blockers remain explicit', () => {
  const oversized = { ...status.models[0], installed: false, fit: 'insufficient', blockedReason: 'Not enough RAM', integrity: 'unverified' };
  const html = fixture.setup({ ...props, ready: false, status: { ...status, runtime: { ready: false, state: 'stopped' }, models: [oversized] } });
  assert.doesNotMatch(buttonWithText(html, 'Download'), /disabled=""/);
  const noDisk = fixture.setup({ ...props, status: { ...status, models: [{ ...oversized, acquisitionBlocker: { code: 'DISK_SPACE', message: 'Need 46 GiB of free storage.' } }] } });
  assert.match(buttonWithText(noDisk, 'Download'), /disabled=""/);
  assert.match(noDisk, /Need 46 GiB of free storage/);
});

test('a background acquisition keeps the model library closable while model mutations stay locked', () => {
  const downloading = { ...status.models[0], id: 'large-moe', name: 'Large MoE', installed: false, fit: 'insufficient' };
  const download = { modelId: downloading.id, progress: { status: 'Downloading GGUF parts', completed: 5 * 1024 ** 3, total: 45 * 1024 ** 3 } };
  const html = fixture.setup({ ...props, status: { ...status, models: [...status.models, downloading] }, download });
  const close = (html.match(/<button\b[^>]*aria-label="Close setup"[^>]*>/g) ?? [])[0];
  assert.ok(close);
  assert.doesNotMatch(close, /disabled/);
  assert.doesNotMatch(buttonWithText(html, 'Back to task'), /disabled/);
  assert.doesNotMatch(buttonWithText(html, 'Cancel download'), /disabled/);
  for (const text of ['Import GGUF', 'Automatic', 'Measure speed &amp; tool format', 'Validate model for tasks']) assert.match(buttonWithText(html, text), /disabled/);
  assert.equal((html.match(/aria-label="Model download"/g) ?? []).length, 1);
  assert.equal((html.match(/>Cancel download<\/button>/g) ?? []).length, 1);
  assert.match(html, /5\.0 GiB \/ 45\.0 GiB · 11%/);
  assert.doesNotMatch(html, />Use model<\/button>[^]*?Large MoE/);
});

test('tasks and Chat can use another verified local model while downloading, but never the downloading model', () => {
  const download = { modelId: 'large-moe', progress: { status: 'Downloading' } };
  assert.equal(fixture.modelReadyForConversation(status, download), true);
  assert.equal(fixture.modelReadyForConversation(status, { ...download, modelId: status.selectedModel }), false);
  assert.equal(fixture.modelReadyForConversation({ ...status, runtime: { ready: false } }, download), false);
  assert.equal(fixture.modelReadyForConversation({ ...status, models: [{ ...status.models[0], integrity: 'failed' }] }, download), false);
  assert.equal(fixture.modelReadyForConversation(null, download), false);
});

test('renderer recovery restores only actual aggregate acquisition evidence and keeps Cancel available', () => {
  const downloading = { ...status, downloadingModel: 'large-moe' };
  assert.deepEqual(fixture.activeModelDownload(null, downloading), { modelId: 'large-moe', progress: { status: 'Downloading in the background' } });
  const progress = { modelId: 'large-moe', progress: { status: 'Verifying all four parts', completed: 45 * 1024 ** 3, total: 45 * 1024 ** 3 } };
  assert.equal(fixture.activeModelDownload(null, { ...downloading, downloadProgress: progress }), progress);
  assert.deepEqual(fixture.activeModelDownload(null, { ...downloading, downloadProgress: { ...progress, modelId: 'old' } }), { modelId: 'large-moe', progress: { status: 'Downloading in the background' } });
  assert.equal(fixture.activeModelDownload(null, { ...status, downloadingModel: null }), null);
  const html = fixture.download({ download: progress, models: [], onCancel: noop });
  assert.match(html, /Verifying all four parts/);
  assert.match(html, /45\.0 GiB \/ 45\.0 GiB · 100%/);
  assert.doesNotMatch(html, /ready|complete/i, 'Acquisition progress must not establish model readiness.');
  assert.doesNotMatch(buttonWithText(html, 'Cancel download'), /disabled/);
  const unknown = fixture.download({ download: { modelId: 'large-moe', progress: { status: 'Starting download' } }, models: [], onCancel: noop });
  assert.match(unknown, /<progress aria-label="large-moe download progress"><\/progress>/);
  assert.doesNotMatch(unknown, /GiB|%/);
});

test('corrupt models offer repair and cannot bypass integrity through an SSD trial', () => {
  const model = { ...status.models[0], fit: 'insufficient', integrity: 'failed', verificationError: 'Checksum mismatch', sourceUrl: 'https://example.test/model', ssdEligibility: { supported: true, reason: 'Routed experts', minimumSlotsPerLayer: 24, engineReady: true } };
  const html = fixture.setup({ ...props, status: { ...status, models: [model] } });
  assert.doesNotMatch(buttonWithText(html, 'Download again'), /disabled=""/);
  assert.doesNotMatch(html, />Try from SSD<\/button>/);
  assert.match(html, /Model files<\/span><strong>Failed/);
});

test('SSD failures remain visible and cache-budget blockers prevent a new trial', () => {
  const model = { ...status.models[0], fit: 'insufficient', ssdEligibility: { supported: true, reason: 'Routed experts', minimumSlotsPerLayer: 30, engineReady: true }, trialBlocker: { code: 'SSD_BUDGET', message: 'The minimum 30 slots per layer do not fit.' } };
  const html = fixture.setup({ ...props, status: { ...status, models: [model] } });
  assert.match(buttonWithText(html, 'Try from SSD'), /disabled=""/);
  assert.match(html, /minimum 30 slots per layer do not fit/);
});

test('unverified equivalent computation blocks SSD use while oversized downloads stay available', () => {
  const blocker = { code: 'SSD_PARITY_UNVERIFIED', message: 'Equivalent computation has not been verified for these weights and this engine profile.' };
  const model = { ...status.models[0], fit: 'insufficient', ssdEligibility: { supported: true, reason: blocker.message, minimumSlotsPerLayer: 24, engineReady: true }, trialBlocker: blocker, useBlocker: blocker };
  const installed = fixture.setup({ ...props, ready: false, status: { ...status, models: [model] } });
  assert.match(buttonWithText(installed, 'Try from SSD'), /disabled/);
  assert.match(installed, /Equivalent computation has not been verified/);
  const notDownloaded = fixture.setup({ ...props, ready: false, status: { ...status, models: [{ ...model, installed: false }] } });
  assert.doesNotMatch(buttonWithText(notDownloaded, 'Download'), /disabled/);
  const historical = { ...status, memoryMode: 'ssd-experts', models: [{ ...model, integrity: 'verified', digest: 'verified-weights', historicalBindingVerified: true, needsPreparation: true }] };
  assert.equal(fixture.modelReadyForConversation(historical as AgentStatus, null), false, 'A retained trial cannot bypass a typed production-use blocker.');
});

test('task ability icons have text labels and software examples are separated from prerequisites', () => {
  const html = fixture.setup(props);
  for (const label of ['Coding', 'Websites', 'Automation', 'Documents', 'Research']) assert.match(html, new RegExp(`aria-hidden="true"[^>]*>[\\s\\S]*?${label}`));
  for (const example of ['Python', 'JavaScript', 'React', 'WordPress', 'Node.js CLI']) assert.ok(html.includes(example));
  assert.match(html, /Installed software and enabled tools determine what the app can execute/);
  assert.match(html, /Research requires the optional plugin; web access starts off/);
});

test('rendered outcomes expose real failed/unverified evidence and escape untrusted details', () => {
  const html = fixture.outcome({ status: 'completed', finishReason: 'Model claimed success', checks: [{ id: 'file', title: 'Final file content', status: 'failed', detail: '<script>not exact</script>', toolId: 'read-123' }, { id: 'run', title: 'Server startup', status: 'unverified', detail: 'No command succeeded' }] });
  assert.match(html, /Checks need attention/);
  assert.doesNotMatch(html, /Task verified/);
  assert.match(html, /0 passed · 1 failed · 1 unverified/);
  assert.match(html, /Tool record: read-123/);
  assert.match(html, /&lt;script&gt;not exact&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('passed operation receipts never render a whole-task verification claim', () => {
  const html = fixture.outcome({ status: 'completed', finishReason: 'end_turn', checks: [
    { id: 'write', title: 'File mutation', status: 'passed', detail: 'wrong-file.txt was created successfully' },
  ] });
  assert.match(html, /Recorded checks passed/);
  assert.match(html, /Review whether the result fulfills your request/);
  assert.doesNotMatch(html, /Task verified/);
});

test('choice controls keep accessible options inside the document and preserve selected/disabled identities', () => {
  const html = fixture.choice({ label: 'Task mode', value: 'coding', options: [{ value: 'coding', label: 'Agent' }, { value: 'assistant', label: 'Chat' }, { value: 'research', label: 'Read-only research', disabled: true, description: 'Enable Research first' }], onChange: () => {} });
  assert.doesNotMatch(html, /<select\b|<option\b/);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Task mode: Agent"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"/);
  const controls = html.match(/aria-controls="([^"]+)"/)![1];
  assert.ok(html.includes(`id="${controls}" role="listbox" aria-label="Task mode" hidden=""`));
  assert.match(html, /role="option" aria-selected="true"[^>]*>[\s\S]*?Agent/);
  assert.match(html, /role="option" aria-selected="false" aria-disabled="true"[^>]*>[\s\S]*?Enable Research first/);
  const disabled = fixture.choice({ label: 'Text size', value: '100', options: [{ value: '100', label: '100%' }], disabled: true, onChange: () => {} });
  assert.match(buttonWithText(disabled, '100%'), /disabled=""/);
});

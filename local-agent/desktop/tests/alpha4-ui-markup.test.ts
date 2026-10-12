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
import ModelSetup from './ModelSetup.tsx';
import TaskOutcomeDetails from './TaskOutcomeDetails.tsx';
import PreferenceChoice from './PreferenceChoice.tsx';
export const setup = props => renderToStaticMarkup(createElement(ModelSetup, props));
export const outcome = value => renderToStaticMarkup(createElement(TaskOutcomeDetails, {outcome: value}));
export const choice = props => renderToStaticMarkup(createElement(PreferenceChoice, props));
`, resolveDir: renderer, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const fixturePath = path.join(temporary, 'fixture.cjs');
await writeFile(fixturePath, compiled.outputFiles[0].contents);
const fixture = createRequire(import.meta.url)(fixturePath) as { setup: (props: object) => string; outcome: (outcome: TaskOutcome) => string; choice: (props: object) => string };
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

test('memory choices and task validation render as explicit separate controls', () => {
  const html = fixture.setup(props);
  assert.match(html, /role="option"[^>]*>[\s\S]*?Automatic/);
  assert.match(html, /role="option"[^>]*>[\s\S]*?Low memory/);
  assert.match(html, /role="option"[^>]*>[\s\S]*?Experimental disk/);
  assert.doesNotMatch(html, /<select\b/);
  assert.doesNotMatch(buttonWithText(html, 'Validate model for tasks'), /disabled=""/);
  assert.doesNotMatch(html, /Agent tools calibrated/);
});

test('failed oversized experimental trials remain retryable without relabeling memory fit', () => {
  const html = fixture.setup({ ...props, ready: false, status: { ...status, memoryMode: 'experimental-disk', runtime: { ready: false, state: 'error', error: 'Trial resident limit reached' }, models: [{ ...status.models[0], fit: 'insufficient' }], experimentalTrial: { modelId: 'test', state: 'failed', reason: 'Resident limit reached', rssBytes: 2 * 1024 ** 3, pressure: 'warning' } } });
  assert.doesNotMatch(buttonWithText(html, 'Try Experimental disk mode'), /disabled=""/);
  assert.match(buttonWithText(html, 'Validate model for tasks'), /disabled=""/);
  assert.match(html, /Insufficient memory/);
  assert.match(html, /Memory pressure<\/dt><dd>warning/);
  assert.match(html, /Mapped weights<\/dt><dd>Unknown/);
  assert.match(html, /Last resident sample<\/dt><dd>2\.00 GB/);
  assert.match(html, /Last available sample<\/dt><dd>Unknown/);
  assert.doesNotMatch(html, /Resident now<\/dt>|Available now<\/dt>/);
});

test('an active model trial can be cancelled while other settings are locked', () => {
  const html = fixture.setup({ ...props, busy: true, trialModel: 'test', status: { ...status, memoryMode: 'experimental-disk', experimentalTrial: { modelId: 'test', state: 'loading' } } });
  assert.doesNotMatch(buttonWithText(html, 'Cancel trial'), /disabled=""/);
  assert.match(buttonWithText(html, 'Experimental disk'), /disabled=""/);
  assert.match(html, /Loading trial model/);
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

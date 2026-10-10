import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentPrompt, backendEnvironment, deniedActionResult, GooseBackend, type BackendOptions } from '../backend.ts';
import { loadTaskResearchSkill } from '../skills/task-research.ts';
import { fileURLToPath } from 'node:url';

const options: BackendOptions = {
  executable: '/app/goose', researchExecutable: '/app/research', bridgeExecutable: '/app/bridge.cjs', nodeExecutable: '/app/node',
  dataDirectory: '/app/turn', cwd: '/project', mode: 'coding', model: 'owned-model', baseUrl: 'http://127.0.0.1:1234', apiKey: 'private',
  contextTokens: 8192, outputTokens: 1024, utilities: { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false },
  grantedRoots: ['/project'], grantedFiles: [], actionUrl: `http://127.0.0.1:2345/${'a'.repeat(64)}`, onEvent: () => {},
};

test('coding prompts explain real enabled capabilities while preserving the complete task', () => {
  const task = 'Create a WordPress project.\nKeep these exact requirements: سلام 🌍';
  const prompt = agentPrompt(options, task);
  assert.ok(prompt.endsWith(task));
  assert.match(prompt, /write_file/); assert.match(prompt, /run_command/); assert.match(prompt, /needs approval/);
  assert.match(prompt, /Respect a denial/);
  const noTerminal = agentPrompt({ ...options, utilities: { ...options.utilities, terminal: false } }, task);
  assert.doesNotMatch(noTerminal, /Use run_command/);
  const chat = { ...options, mode: 'assistant' as const };
  assert.match(agentPrompt(chat, task), /no file-writing or command tools/);
  assert.equal(backendEnvironment(chat).LOCAL_AGENT_ACTION_URL, '');
});

test('Agent and Research carry the shipped skill with actual access/date without changing the user task', async () => {
  const skill = await loadTaskResearchSkill(fileURLToPath(new URL('../skills/', import.meta.url)));
  const task = 'Use the current release compatible with this project.\nKeep سلام 🌍 unchanged.';
  for (const mode of ['coding', 'research'] as const) {
    const prompt = agentPrompt({ ...options, mode, currentDate: '2026-10-10' }, task, skill);
    assert.ok(prompt.endsWith(`USER TASK AND LOCAL CONTEXT:\n${task}`));
    assert.equal(prompt.split(skill.instructions).length, 2, 'Load the entire bundled instruction body exactly once.');
    assert.match(prompt, /Web research is OFF/);
    assert.match(prompt, /Current UTC date.*2026-10-10/);
    const online = agentPrompt({ ...options, mode, utilities: { ...options.utilities, webResearch: true } }, task, skill);
    assert.match(online, /Web research is enabled/);
  }
  assert.ok(!agentPrompt({ ...options, mode: 'assistant' }, task, skill).includes(skill.instructions));
});

test('missing packaged skill prevents backend startup before launching an executable', async () => {
  const backend = new GooseBackend({ ...options, executable: '/missing-executable-must-not-start',
    skillsDirectory: fileURLToPath(new URL('./nonexistent-skills/', import.meta.url)) });
  await assert.rejects(backend.start(), /bundled Task research skill could not be loaded/);
  await backend.stop();
});

test('enabled project actions require an owned loopback approval endpoint', () => {
  for (const actionUrl of [undefined, 'https://example.org/actions', `http://localhost:2345/${'a'.repeat(64)}`, 'http://127.0.0.1:2345/guessable']) {
    assert.throws(() => backendEnvironment({ ...options, actionUrl }), /app-owned approval host/);
  }
  assert.equal(backendEnvironment(options).LOCAL_AGENT_ACTION_URL, options.actionUrl);
  assert.doesNotThrow(() => backendEnvironment({ ...options, actionUrl: undefined, utilities: { ...options.utilities, fileEditing: false, terminal: false } }));
});

test('denial detection accepts exact owned results without matching quoted prose or command logs', () => {
  const text = 'The user denied this action. No action was taken.';
  assert.equal(deniedActionResult([{ type: 'content', content: { type: 'text', text } }]), true);
  assert.equal(deniedActionResult({ isError: true, errorCode: 'PERMISSION_DENIED' }), true);
  assert.equal(deniedActionResult({ type: 'text', text: `Command output: ${text}` }), false);
  assert.equal(deniedActionResult({ type: 'text', text: JSON.stringify({ text }) }), false);
  assert.equal(deniedActionResult({ isError: false, errorCode: 'PERMISSION_DENIED' }), false);
  assert.equal(deniedActionResult({ type: 'text', text: 'The command failed.' }), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentPrompt, backendEnvironment, backendExtensions, cancelledActionResult, deniedActionResult, GooseBackend, type BackendOptions } from '../backend.ts';
import { actionRequestDeadlines, actionRequestTimeoutText, actionResponseInterruptedText, cancelledActionText, commandTimeoutLimits, commandTimeoutText, interruptedTurnText } from '../action-protocol.ts';
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
    const prompt = agentPrompt({ ...options, mode, plugins: { taskResearch: true }, currentDate: '2026-10-10' }, task, skill);
    assert.ok(prompt.endsWith(`USER TASK AND LOCAL CONTEXT:\n${task}`));
    assert.equal(prompt.split(skill.instructions).length, 2, 'Load the entire bundled instruction body exactly once.');
    assert.match(prompt, /Web research is OFF/);
    assert.match(prompt, /Current UTC date.*2026-10-10/);
    const online = agentPrompt({ ...options, mode, plugins: { taskResearch: true }, utilities: { ...options.utilities, webResearch: true } }, task, skill);
    assert.match(online, /Web research is enabled/);
  }
  assert.ok(!agentPrompt({ ...options, mode: 'assistant', plugins: { taskResearch: true } }, task, skill).includes(skill.instructions));
  for (const mode of ['coding', 'research'] as const) {
    const disabled = agentPrompt({ ...options, mode, utilities: { ...options.utilities, webResearch: true } }, task, skill);
    assert.ok(!disabled.includes(skill.instructions));
    assert.doesNotMatch(disabled, /OPTIONAL PLUGIN|Web research is enabled/);
    assert.ok(disabled.endsWith(task));
  }
});

test('missing packaged skill prevents backend startup before launching an executable', async () => {
  const backend = new GooseBackend({ ...options, executable: '/missing-executable-must-not-start',
    plugins: { taskResearch: true },
    skillsDirectory: fileURLToPath(new URL('./nonexistent-skills/', import.meta.url)) });
  await assert.rejects(backend.start(), /bundled Task research skill could not be loaded/);
  await backend.stop();
});

test('an enabled plugin without a bundled skills directory fails before launching an executable', async () => {
  const backend = new GooseBackend({ ...options, executable: '/missing-executable-must-not-start', plugins: { taskResearch: true } });
  await assert.rejects(backend.start(), /enabled Task research plugin.*bundled skills directory is missing/);
  await backend.stop();
});

test('backend independently removes web registration when the research plugin, permission or mode is disabled', () => {
  for (const mode of ['coding', 'research', 'assistant'] as const) {
    for (const taskResearch of [false, true]) {
      for (const webResearch of [false, true]) {
        const environment = backendEnvironment({ ...options, mode, plugins: { taskResearch }, utilities: { ...options.utilities, webResearch } });
        const actual = JSON.parse(environment.LOCAL_AGENT_UTILITIES!);
        assert.equal(actual.webResearch, mode !== 'assistant' && taskResearch && webResearch);
        assert.equal(Boolean(environment.LOCAL_AGENT_ACTION_URL), mode === 'coding');
      }
    }
  }
  const missingPluginPreference = backendEnvironment({ ...options, utilities: { ...options.utilities, webResearch: true } });
  assert.equal(JSON.parse(missingPluginPreference.LOCAL_AGENT_UTILITIES!).webResearch, false);
});

test('enabled project actions require an owned loopback approval endpoint', () => {
  for (const actionUrl of [undefined, 'https://example.org/actions', `http://localhost:2345/${'a'.repeat(64)}`, 'http://127.0.0.1:2345/guessable']) {
    assert.throws(() => backendEnvironment({ ...options, actionUrl }), /app-owned approval host/);
  }
  assert.equal(backendEnvironment(options).LOCAL_AGENT_ACTION_URL, options.actionUrl);
  assert.doesNotThrow(() => backendEnvironment({ ...options, actionUrl: undefined, utilities: { ...options.utilities, fileEditing: false, terminal: false } }));
});

test('emitted reviewed extension deadline permits approval and an explicit dependency command within the native cap', () => {
  const extensions = backendExtensions(options);
  const actions = extensions.find(extension => extension.server.name === 'reviewed_actions')!;
  assert.equal(actions.timeout, 1500);
  assert.equal(actions.timeout * 1000, actionRequestDeadlines.command);
  assert.ok(actions.timeout * 1000 > 10 * 60_000 + commandTimeoutLimits.maximum, 'The extension must not preempt a permitted review followed by a long command.');
  assert.ok(actionRequestDeadlines.normal < actions.timeout * 1000, 'Other local action requests retain their shorter native deadline.');
  assert.equal(actions.server.command, options.nodeExecutable);
  assert.deepEqual(actions.server.args, [options.bridgeExecutable]);
  assert.equal(extensions.find(extension => extension.server.name === 'local_files_and_research')?.timeout, 180);
  assert.equal(backendExtensions({ ...options, mode: 'assistant' }).some(extension => extension.server.name === 'reviewed_actions'), false);
  assert.equal(backendExtensions({ ...options, utilities: { ...options.utilities, fileEditing: false, terminal: false } }).some(extension => extension.server.name === 'reviewed_actions'), false);
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

test('cancellation detection recognizes owned interrupted requests without interpreting command prose', () => {
  for (const text of [cancelledActionText, interruptedTurnText, commandTimeoutText, actionRequestTimeoutText, actionResponseInterruptedText]) {
    assert.equal(cancelledActionResult([{ type: 'content', content: { type: 'text', text } }]), true);
    assert.equal(cancelledActionResult({ type: 'text', text: `Command output: ${text}` }), false);
    assert.equal(cancelledActionResult({ type: 'text', text: JSON.stringify({ text }) }), false);
    assert.equal(deniedActionResult({ type: 'text', text }), false);
  }
  for (const errorCode of ['CANCELLED', 'TURN_CANCELLED', 'COMMAND_TIMEOUT', 'COMMAND_INTERRUPTED']) {
    assert.equal(cancelledActionResult({ isError: true, errorCode }), true);
    assert.equal(cancelledActionResult({ isError: false, errorCode }), false);
  }
  assert.equal(cancelledActionResult({ type: 'text', text: 'fetch failed' }), false);
  assert.equal(cancelledActionResult({ type: 'text', text: { toString: 'untrusted' } }), false);
  assert.equal(cancelledActionResult({ isError: true, errorCode: { toString: 'untrusted' } }), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAgentCapabilities, taskInstructions } from '../agent-policy.ts';
import { DEFAULT_UTILITIES, effectiveUtilities, emptyState, migrateState } from '../state.ts';

test('new installations default to Agent while saved chat modes and grants remain intact', () => {
  assert.equal(emptyState().mode, 'coding');
  const existing = { ...emptyState(), mode: 'assistant', projectPath: '/existing-workspace' };
  assert.equal(migrateState(existing).mode, 'assistant');
  assert.equal(migrateState(existing).projectPath, '/existing-workspace');
});

test('an unvalidated model cannot silently execute an Agent request as plain chat', () => {
  assert.throws(() => assertAgentCapabilities('coding', DEFAULT_UTILITIES, false), /chat-only.*Check tools & speed/);
  assert.doesNotThrow(() => assertAgentCapabilities('assistant', effectiveUtilities('assistant', DEFAULT_UTILITIES), false));
  assert.doesNotThrow(() => assertAgentCapabilities('coding', DEFAULT_UTILITIES, true));
});

test('capability instructions advertise only actually registered utilities', () => {
  const readOnly = effectiveUtilities('coding', { ...DEFAULT_UTILITIES, fileEditing: false, terminal: false });
  const instructions = taskInstructions('coding', readOnly);
  const inventory = instructions.split('Available tools for this turn')[1];
  assert.match(inventory, /list_files/);
  assert.ok(!inventory.includes('write_file'));
  assert.ok(!inventory.includes('run_command'));
  assert.ok(!inventory.includes('web_search'));
  assert.doesNotThrow(() => assertAgentCapabilities('coding', readOnly, true));
  const noTools = { fileReading: false, projectSearch: false, fileEditing: false, terminal: false, webResearch: false };
  assert.throws(() => assertAgentCapabilities('coding', noTools, true), /utilities are disabled/);
  assert.doesNotThrow(() => assertAgentCapabilities('coding', { ...noTools, webResearch: true }, true));
  const webOnly = taskInstructions('coding', { ...noTools, webResearch: true }, true, { taskResearch: true }).split('Available tools for this turn')[1];
  assert.match(webOnly, /web_search and web_fetch/);
  assert.doesNotMatch(webOnly, /write_file|run_command|read_file/);
});

test('chat-only Research uses staged context without advertising disabled callable tools or verified current sources', () => {
  const instructions = taskInstructions('research', { ...DEFAULT_UTILITIES, webResearch: true }, false);
  assert.match(instructions, /no callable tools/);
  assert.match(instructions, /staged local context/);
  assert.match(instructions, /label claims unverified/);
  assert.match(instructions, /validated tool-capable model, the Task research plugin, and enabled web access/);
  assert.doesNotMatch(instructions, /web_search|web_fetch|read_file|run_command|Available tools for this turn/);
});

test('ordinary Agent instructions omit the optional research skill and keep action capabilities intact', () => {
  for (const mode of ['coding', 'research'] as const) {
    const preferences = { ...DEFAULT_UTILITIES, webResearch: true };
    const disabled = taskInstructions(mode, preferences);
    assert.doesNotMatch(disabled, /Task research|web_search|web_fetch/);
    assert.match(disabled, /current online facts.*verified/);
    const enabled = taskInstructions(mode, preferences, true, { taskResearch: true });
    assert.match(enabled, /enabled Task research plugin/);
    assert.match(enabled, /web_search and web_fetch/);
    const localOnly = taskInstructions(mode, DEFAULT_UTILITIES, true, { taskResearch: true });
    assert.match(localOnly, /enabled Task research plugin/);
    assert.match(localOnly, /Web research is disabled/);
    assert.doesNotMatch(localOnly, /web_search|web_fetch/);
  }
  const normalAgent = taskInstructions('coding', DEFAULT_UTILITIES);
  assert.match(normalAgent, /create_files|write_file/);
  assert.match(normalAgent, /run_command/);
  assert.match(normalAgent, /approval dialog/);
  assert.match(normalAgent, /Respect denials/);
});

test('Agent task execution remains general and requires prerequisite inspection, validation and repair', () => {
  const instructions = taskInstructions('coding', DEFAULT_UTILITIES);
  assert.match(instructions, /Inspect installed versions and prerequisites/);
  assert.match(instructions, /run appropriate validation/);
  assert.match(instructions, /repair observed failures.*tools and approvals/);
  assert.match(instructions, /Never claim.*passing test.*without tool evidence/);
  assert.match(instructions, /Do not automatically repeat completed commands or edits/);
  assert.doesNotMatch(instructions, /WordPress|docker|MariaDB/i);
});

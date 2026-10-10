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
});

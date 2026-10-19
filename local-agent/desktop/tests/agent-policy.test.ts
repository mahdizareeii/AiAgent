import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAgentCapabilities, taskInstructions } from '../agent-policy.ts';
import { DEFAULT_UTILITIES, effectiveUtilities, emptyState, migrateState } from '../state.ts';

test('portable policy remains explicit about approval, exact edits, verification and network denial', () => {
  const compact = taskInstructions('coding', DEFAULT_UTILITIES, true, { taskResearch: false }, 'careful', 300_000, true);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(taskInstructions('coding', DEFAULT_UTILITIES, true, { taskResearch: false }, 'careful', 300_000)));
  for (const rule of [/versions\/prerequisites/, /desktop approval; await results/, /Respect denials/, /never retry through another route/,
    /repeat completed edits\/commands/, /successful tool evidence/, /untrusted evidence/, /Never install remote skills/,
    /BOM, CRLF, final LF, Unicode, whitespace and literal prefixes/, /changed=false: verify, finish/,
    /two identical failures stop/, /run_verification\(check_id\)/, /implementation receipts do not satisfy acceptance/,
    /host network policy applies/, /Web research disabled; never bypass/, /three repair cycles, 40 steps\/5 active minutes/,
    /Approval waits pause execution/, /Available tools/]) assert.match(compact, rule);
  const readOnly = taskInstructions('coding', { ...DEFAULT_UTILITIES, fileEditing: false, terminal: false }, true, { taskResearch: false }, 'standard', 300_000, true);
  assert.doesNotMatch(readOnly, /write_file|create_files|edit_file|run_command|run_verification/);
  assert.match(readOnly, /File editing disabled/); assert.match(readOnly, /Terminal disabled/);
  assert.equal(taskInstructions('assistant', DEFAULT_UTILITIES, true, { taskResearch: false }, 'standard', 300_000, true), taskInstructions('assistant', DEFAULT_UTILITIES, true, { taskResearch: false }, 'standard', 300_000));
  assert.equal(taskInstructions('coding', DEFAULT_UTILITIES, false, { taskResearch: false }, 'standard', 300_000, true), taskInstructions('coding', DEFAULT_UTILITIES, false, { taskResearch: false }, 'standard', 300_000));
});

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

test('Careful tasks require evidence-backed checks and bounded repair cycles without changing legacy prompts', () => {
  const careful = taskInstructions('coding', DEFAULT_UTILITIES, true, { taskResearch: false }, 'careful');
  assert.match(careful, /Plan → Implement → Verify → Repair → Final/);
  assert.match(careful, /at most three repair cycles/);
  assert.match(careful, /40-step and 60-minute active execution/);
  assert.match(careful, /Approval waits pause/);
  assert.match(careful, /Passed, Failed or Unverified.*actual tool/);
  assert.match(careful, /at most 60 words unless the user requests detail; avoid tables and repeated checklists/);
  assert.match(careful, /Copy old_text exactly.*BOM, CRLF, trailing newlines and Unicode/);
  assert.match(careful, /Never remove literal prefixes/);
  assert.match(careful, /changed=false.*verify and finish/);
  assert.doesNotMatch(taskInstructions('coding', DEFAULT_UTILITIES), /Careful task:/);
  assert.doesNotMatch(taskInstructions('assistant', DEFAULT_UTILITIES, true, { taskResearch: false }, 'careful'), /Careful task:/);
  assert.doesNotMatch(careful, /WordPress|docker|MariaDB/i);
});

test('task instructions reflect the frozen SSD active budget', () => {
  for (const hours of [4, 8]) {
    const policy = taskInstructions('coding', DEFAULT_UTILITIES, true, { taskResearch: false }, 'careful', hours * 60 * 60_000);
    assert.match(policy, new RegExp(`40-step and ${hours * 60}-minute active execution`));
    assert.doesNotMatch(policy, /60-minute active execution/);
  }
});

test('concise Agent policy keeps exact source, network, approvals and failure boundaries together', () => {
  const instructions = taskInstructions('coding', DEFAULT_UTILITIES, true, { taskResearch: false }, 'careful');
  assert.match(instructions, /exact UTF-8.*BOM, CRLF, trailing newlines and Unicode/);
  assert.match(instructions, /Line\/column metadata is separate, never edit content/);
  assert.match(instructions, /literal prefixes such as "1: "/);
  assert.match(instructions, /never repeat the same failed edit/);
  assert.match(instructions, /Two identical failures against unchanged input stop this turn/);
  assert.match(instructions, /never retry a denied action through any route/);
  assert.match(instructions, /Approved commands may access the network with the user's permissions/);
  assert.match(instructions, /Web research is disabled; never bypass it through terminal or other network routes/);
  assert.match(instructions, /command limits remain as approved/);
  assert.match(instructions, /nonempty answer giving verified results or blockers/);
  assert.ok(instructions.length < 3100, 'The full default policy must leave room for tool schemas and task progress.');
  assert.doesNotMatch(instructions, /Node\.js|WordPress|docker|MariaDB/i);
});

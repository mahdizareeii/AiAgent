import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPrepareTools, canTrySsd, currentValidation, modelEvidence, trialDisplaysError } from '../renderer/model-controls.ts';
import { modelFitAllowsUse, modelIsUsable } from '../renderer/status-flow.ts';
import { composerPlaceholder, conversationStage, workingStatus } from '../renderer/conversation-flow.ts';
import { newSessionOptions } from '../renderer/task-flow.ts';
import { showOutcome } from '../renderer/task-evidence.ts';
import type { AgentStatus, LocalModel } from '../renderer/types.ts';

const model: LocalModel = { id: 'large-moe', name: 'Large MoE', description: 'Coding model', installed: true, downloadGB: 45, workingMemoryGB: 50, license: 'Apache-2.0', quantization: 'Q4_K_M', fit: 'insufficient', fitReason: 'Ordinary weights exceed usable RAM', toolCapable: true, integrity: 'verified', digest: 'artifact-set', templateHash: 'template', ssdEligibility: { supported: true, reason: 'Supported expert groups', minimumSlotsPerLayer: 30, engineReady: true } };
const status = { runtime: { ready: true, state: 'ready', version: 'v0.6.0', engineIdentity: 'ssd-worker' }, memoryMode: 'ssd-experts', selectedModel: model.id, models: [model], slowMode: false, profile: { backend: 'cpu', contextTokens: 4096, profileSignature: 'ssd-profile' }, experimentalTrial: { modelId: model.id, mode: 'ssd-experts', state: 'passed', probePassed: true, artifactSetDigest: model.digest, templateDigest: model.templateHash, engineDigest: 'ssd-worker', profileSignature: 'ssd-profile' } } as AgentStatus;

test('only exact failed-trial messages with recognized trial wrappers are duplicate errors', () => {
  const reason = 'The fixed Chat probe did not return exactly OK. finish=length, output tokens=16/16';
  const trial = { id: 'failed-trial', modelId: model.id, state: 'failed', reason };
  for (const error of [reason, `Error: ${reason}`, `RuntimeError: ${reason}`, `Error: RuntimeError: ${reason}`, `Error invoking remote method 'local-agent:startModelTrial': RuntimeError: ${reason}`, `Error invoking remote method 'local-agent:tryExperimentalModel': Error: ${reason}`]) assert.equal(trialDisplaysError(error, trial, trial.id), true, error);
  for (const error of [`${reason} (new failure)`, ` ${reason}`, `TypeError: ${reason}`, `Error invoking remote method 'local-agent:importModel': RuntimeError: ${reason}`, `Error invoking remote method 'local-agent:downloadModel': Error: ${reason}`, `Error invoking remote method 'local-agent:calibrateModel': ${reason}`]) assert.equal(trialDisplaysError(error, trial, trial.id), false, error);
  for (const state of ['loading', 'calibrating', 'passed', 'cancelled', 'stopped']) assert.equal(trialDisplaysError(`RuntimeError: ${reason}`, { ...trial, state }, trial.id), false);
  assert.equal(trialDisplaysError(reason, undefined), false);
  assert.equal(trialDisplaysError(null, trial, trial.id), false);
  assert.equal(trialDisplaysError(reason, trial), false, 'Identical unowned error text is not a duplicate.');
  assert.equal(trialDisplaysError(reason, trial, 'older-trial'), false);
  assert.equal(trialDisplaysError(reason, { ...trial, id: 'new-trial' }, trial.id), false);
});

test('SSD readiness is bound to verified artifact set, template, worker, and profile', () => {
  assert.equal(modelIsUsable(status), true);
  for (const patch of [{ mode: 'experimental-disk' as const }, { artifactSetDigest: 'old-weights' }, { templateDigest: 'old-template' }, { engineDigest: 'old-worker' }, { profileSignature: 'old-profile' }, { probePassed: false }]) {
    assert.equal(modelFitAllowsUse({ ...status, experimentalTrial: { ...status.experimentalTrial!, ...patch } }, model.id), false);
  }
  assert.equal(modelIsUsable({ ...status, models: [{ ...model, integrity: 'unverified' }] }), false);
  assert.equal(modelIsUsable({ ...status, models: [{ ...model, verificationError: 'Checksum mismatch' }] }), false);
});

test('a catalog template and measured speed cannot establish successful Chat, tools, or task quality', () => {
  const evidence = modelEvidence(status, { ...model, measuredTokensPerSecond: 24 });
  assert.deepEqual(evidence.map(item => [item.label, item.status]), [['Model files', 'passed'], ['Chat probe', 'unverified'], ['Tool format', 'unverified'], ['Task checks', 'unverified']]);
  assert.equal(modelEvidence(status, { ...model, digest: undefined })[0].status, 'unverified');
});

test('probe success is invalidated by changes in each bound identity', () => {
  const probe = { status: 'passed' as const, digest: model.digest, templateHash: model.templateHash, runtime: 'ssd-worker', profileSignature: 'ssd-profile' };
  assert.equal(modelEvidence(status, { ...model, chatProbe: probe })[1].status, 'passed');
  for (const patch of [{ digest: 'other' }, { templateHash: 'other' }, { runtime: 'other' }, { profileSignature: 'other' }]) assert.equal(modelEvidence(status, { ...model, chatProbe: { ...probe, ...patch } })[1].status, 'unverified');
});

test('changing the compute kernel profile invalidates old current probe and task checks', () => {
  const probe = { status: 'passed' as const, digest: model.digest, templateHash: model.templateHash, runtime: 'ssd-worker', profileSignature: 'cpu-repack-profile' };
  const record = { id: 'old-kernel-validation', modelId: model.id, digest: model.digest!, templateHash: model.templateHash!, runtime: 'ssd-worker', profileSignature: probe.profileSignature, startedAt: 'now', status: 'passed' as const, checks: [{ id: 'file', title: 'Exact file readback', status: 'passed' as const, detail: 'Old kernel result' }] };
  const old = { ...status, profile: { ...status.profile!, profileSignature: probe.profileSignature }, validationRecords: [record] };
  assert.equal(currentValidation(old, model).current, true);
  assert.equal(modelEvidence(old, { ...model, chatProbe: probe })[1].status, 'passed');
  const changed = { ...old, profile: { ...old.profile, profileSignature: 'validated-standard-cpu-no-repack-profile' } };
  assert.equal(currentValidation(changed, model).current, false);
  assert.equal(modelEvidence(changed, { ...model, chatProbe: probe })[1].status, 'unverified');
  assert.equal(modelFitAllowsUse({ ...changed, experimentalTrial: { ...status.experimentalTrial!, profileSignature: probe.profileSignature } }, model.id), false);
});

test('failed task validation preserves mixed checks and never promotes a partial pass', () => {
  const record = { id: 'validation', modelId: model.id, digest: model.digest!, templateHash: model.templateHash!, runtime: 'ssd-worker', profileSignature: 'ssd-profile', startedAt: 'now', status: 'failed' as const, checks: [{ id: 'chat', title: 'Chat', status: 'passed' as const, detail: '42' }, { id: 'tool-format', title: 'Tool format', status: 'failed' as const, detail: 'Invalid call' }, { id: 'file-task', title: 'File task', status: 'unverified' as const, detail: 'Not run' }] };
  const checked = { ...status, validationRecords: [record] };
  assert.equal(currentValidation(checked, model).current, false);
  assert.deepEqual(modelEvidence(checked, model).map(item => item.status), ['passed', 'passed', 'failed', 'failed']);
  assert.deepEqual(record.checks.map(check => check.status), ['passed', 'failed', 'unverified']);
});

test('SSD trials require supported installed artifacts and reject integrity or budget blockers', () => {
  assert.equal(canTrySsd(model), true);
  for (const patch of [{ installed: false }, { integrity: 'failed' as const }, { verificationError: 'Truncated part' }, { ssdEligibility: { ...model.ssdEligibility!, supported: false } }, { trialBlocker: { code: 'MINIMUM_CACHE', message: 'Not enough slots' } }]) assert.equal(canTrySsd({ ...model, ...patch }), false);
});

test('eligible unverified tool templates can reach host preparation while failed probes and chat-only imports cannot', () => {
  assert.equal(canPrepareTools({ ...model, toolCapable: false, toolValidationEligible: true }), true);
  assert.equal(canPrepareTools({ ...model, toolCapable: false, toolValidationEligible: true, toolProbe: { status: 'unverified' } }), true);
  assert.equal(canPrepareTools({ ...model, toolCapable: false, toolValidationEligible: true, toolProbe: { status: 'failed' } }), false);
  assert.equal(canPrepareTools({ ...model, toolCapable: true, toolValidationEligible: true, toolProbe: { status: 'failed' } }), false);
  assert.equal(canPrepareTools({ ...model, toolCapable: false, toolValidationEligible: false }), false);
  assert.equal(canPrepareTools(undefined), false);
});

test('a verified historical SSD binding permits explicit preparation without claiming a live probe', () => {
  const retained = { ...model, needsPreparation: true, historicalBindingVerified: true };
  const reopened = { ...status, models: [retained], experimentalTrial: { ...status.experimentalTrial!, state: 'stopped', probePassed: false } };
  assert.equal(modelIsUsable(reopened), true);
  assert.equal(modelIsUsable({ ...reopened, models: [{ ...retained, historicalBindingVerified: false }] }), false);
  assert.equal(modelEvidence(reopened, { ...retained, chatProbe: { status: 'passed', digest: model.digest, templateHash: model.templateHash, runtime: 'ssd-worker', profileSignature: 'ssd-profile' } })[1].status, 'unverified');
});

test('Chat and Task activity show real progress without repeating execution policy or missing-model text while busy', () => {
  const policy = { stage: 'Plan → Implement → Verify → Repair → Final', message: 'Results are checked against tool evidence; approvals pause the execution clock.' };
  assert.equal(conversationStage(policy), null);
  assert.equal(workingStatus({ stage: conversationStage(policy) }), 'Working locally');
  const reading = { stage: 'reading', completed: 3, total: 9, message: 'Reading source pages', resumable: true };
  assert.equal(conversationStage(reading), reading);
  assert.doesNotMatch(composerPlaceholder('assistant', false, true, false), /choose|model|task/i);
  assert.doesNotMatch(composerPlaceholder('coding', false, true, false), /choose|model/i);
  assert.match(composerPlaceholder('assistant', false, false, false), /choose a local model/);
  assert.match(composerPlaceholder('assistant', true, false, false), /Ask a question/);
});

test('new Chat omits a hidden workspace grant while tasks and retained session behavior remain intact', () => {
  assert.deepEqual(newSessionOptions('assistant', '/workspace/project', 'careful'), { mode: 'assistant', taskEffort: 'careful' });
  assert.deepEqual(newSessionOptions('coding', '/workspace/project', 'careful'), { mode: 'coding', projectPath: '/workspace/project', taskEffort: 'careful' });
  assert.equal(newSessionOptions('coding', '/workspace/project', 'standard').taskEffort, 'standard');
});

test('completed ordinary Chat is concise but real reads and failure outcomes remain visible', () => {
  const response = { status: 'completed' as const, finishReason: 'end_turn', checks: [] };
  assert.equal(showOutcome('assistant', response), false);
  assert.equal(showOutcome('coding', response), true);
  assert.equal(showOutcome('assistant', { ...response, status: 'blocked' }), true);
  assert.equal(showOutcome('assistant', { ...response, checks: [{ id: 'read', title: 'Source read', status: 'passed', detail: 'Exact readback' }] }), true);
});

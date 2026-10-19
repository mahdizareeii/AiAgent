import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CATALOG } from '../catalog.ts';
import { GIB } from '../hardware.ts';
import { PORTABLE_CPU_PROFILE } from '../portable-admission.ts';
import { EIGHT_GB_PROTOCOL, EIGHT_GB_ACCEPTANCE_PROMPT, EIGHT_GB_SUITE_DIGEST, EIGHT_GB_FIXTURES, evaluateEightGBComparison, inspectEightGBEvidence, rankEightGBCandidates, type EightGBEvidence } from '../../../scripts/8gb-validation/protocol.ts';
import { runEightGBValidation } from '../../../scripts/8gb-validation/run.ts';

/** Tiny synthetic report-policy fixtures only. These tests establish no model,
 * platform, memory stability or task-quality evidence. */
const startFor = (e: EightGBEvidence) => Date.parse(e.latencies[0].requestedAt);
function evidence(modelId = 'qwen3.5:4b', failedQuality = 3): EightGBEvidence {
  const start = Date.parse('2026-10-17T00:00:00Z')+(modelId==='qwen3.5:4b'?0:500_000); let fail = failedQuality, index = 0;
  return { complete:true,errors:[],driver:{id:'real-electron-v1',controllerExit:{code:0,signal:null},controlsPassed:true,rawEventsPath:'synthetic-policy-fixture-only.jsonl',liveControlsPath:'synthetic-policy-fixture-only.json'},schemaVersion: 1, protocolId: EIGHT_GB_PROTOCOL.id, suiteDigest: EIGHT_GB_SUITE_DIGEST, runId: `fixture-${modelId}`, modelId, completedAt: new Date(start + 400_000).toISOString(),
    publicNetwork: false, syntheticProvider: false, ownedProcessesStopped: true, lateFatal: false, sourceBinding: 'a'.repeat(64), resourceBinding: 'b'.repeat(64), modelDigest: MODEL_CATALOG.find(m => m.id === modelId)!.sha256, engineDigest: 'c'.repeat(64), templateDigest: 'd'.repeat(64), profile: { ...PORTABLE_CPU_PROFILE },
    hardware: { target: 'linux-x64/cpu', memoryScope: 'whole-os', environment: 'whole-os-vm', installedMemoryBytes: 8 * GIB, totalMemoryBytes: 8 * GIB, osRelease: 'fixture-os', evidencePath: 'retained-hardware.json' },
    latencies: ['cold', 'warm'].map((phase, i) => ({ phase: phase as 'cold' | 'warm', prompt: EIGHT_GB_ACCEPTANCE_PROMPT, requestedAt: new Date(start + i * 10_000).toISOString(), verificationStartedAt: new Date(start + i * 10_000).toISOString(), verifiedAt: new Date(start + i * 10_000 + 1000).toISOString(), preparedAt: new Date(start + i * 10_000 + 2000).toISOString(), completedAt: new Date(start + i * 10_000 + 3000).toISOString(), answer: '42' })),
    monitoring: { startedAt: new Date(start).toISOString(), completedAt: new Date(start + 100_000).toISOString(), modelSpawnedAt: new Date(start + 2000).toISOString(), modelStoppedAt: new Date(start + 100_000).toISOString(), childPid: 2, controllerPid: 1, allocationWorkingBytes: 4.5 * GIB, allocationEvidencePath: 'retained-plan.json',
      samples: Array.from({ length: 51 }, (_, i) => ({ sampledAt: new Date(start + i * 2000).toISOString(), pid: i === 0 || i === 50 ? null : 2, parentPid: i === 0 || i === 50 ? null : 1, rssBytes: i === 0 || i === 50 ? 0 : 4 * GIB, residentBytes: i === 0 || i === 50 ? 0 : 4 * GIB, availableMemoryBytes: 1.5 * GIB, pressure: 'normal' })) },
    cases: EIGHT_GB_FIXTURES.flatMap(fixture => [1, 2, 3].map(repeat => { const failed = fixture.kind === 'quality' && fail-- > 0, at=start+20_000+index++*2000; return { fixtureId: fixture.id, repeat, startedAt: new Date(at).toISOString(), completedAt: new Date(at+1000).toISOString(), status: fixture.kind === 'safety' ? 'blocked' : failed ? 'blocked' : 'completed', verification: failed || fixture.kind === 'safety' ? 'unverified' : 'passed', falseVerified: false, replayCount: 0, independentChecks: fixture.checks.map(id => ({ id, passed: !failed })) } as const; })) };
}
test('new 8 GB protocol requires three repetitions, cold/warm latency, every safety case and 5 percentage points', () => {
  const reference = evidence(), candidate = evidence('qwen3.5:9b-ud-iq2-m', 1);
  const outcome = evaluateEightGBComparison(reference, candidate);
  assert.equal(outcome.eligibleForIndependentSupportReview, true); assert(outcome.qualityGain >= .05); assert.equal(outcome.qualified, false); assert.equal(outcome.supportClaimEstablished, false);
  assert.equal(evaluateEightGBComparison(reference, evidence(candidate.modelId, 2)).eligibleForIndependentSupportReview, false);
  const whitespace=structuredClone(candidate);whitespace.latencies[0].answer='42\n';assert.equal(inspectEightGBEvidence(whitespace).evidence.latencies[0].answer,'42\n');
  whitespace.latencies[0].answer='The answer is42';assert.throws(()=>inspectEightGBEvidence(whitespace));
  const unsafe = structuredClone(candidate); unsafe.cases.at(-1)!.independentChecks[0].passed = false;
  assert.equal(evaluateEightGBComparison(reference, unsafe).eligibleForIndependentSupportReview, false);
});
test('larger host with process limit, excessive latency, sample gaps, wrong owner and late fatal cannot pass', () => {
  const base = evidence();
  for (const mutate of [
    (e: EightGBEvidence) => { e.hardware.installedMemoryBytes = 24 * GIB; },
    (e: EightGBEvidence) => { (e.hardware as any).memoryScope = 'process-limit'; },
    (e: EightGBEvidence) => { e.latencies[0].completedAt = new Date(startFor(e) + 300_001).toISOString(); },
    (e: EightGBEvidence) => { e.monitoring.samples.splice(25, 3); },
    (e: EightGBEvidence) => { e.monitoring.samples[25].parentPid = 99; },
    (e: EightGBEvidence) => { e.monitoring.samples[25].availableMemoryBytes = GIB - 1; },
    (e: EightGBEvidence) => { e.monitoring.samples[25].residentBytes = 6 * GIB; },
    (e: EightGBEvidence) => { (e as any).lateFatal = true; },
    (e: EightGBEvidence) => { e.complete=false; },
    (e: EightGBEvidence) => { e.errors.push('Raw retention failed'); },
    (e: EightGBEvidence) => { e.driver.controlsPassed=false; },
    (e: EightGBEvidence) => { e.driver.controllerExit.code=1; },
  ]) { const altered = structuredClone(base); mutate(altered); assert.throws(() => inspectEightGBEvidence(altered)); }
});
test('partial/duplicate runs, false completion, replay, changed model and unmatched source are rejected', () => {
  const base = evidence('qwen3.5:9b-ud-iq2-m', 0);
  for (const mutate of [
    (e: EightGBEvidence) => { e.cases.pop(); }, (e: EightGBEvidence) => { e.cases[1] = e.cases[0]; },
    (e: EightGBEvidence) => { e.cases[0].falseVerified = true; }, (e: EightGBEvidence) => { e.cases[0].replayCount = 1; },
    (e: EightGBEvidence) => { e.cases[0].independentChecks.pop(); }, (e: EightGBEvidence) => { e.modelDigest = 'f'.repeat(64); },
    (e: EightGBEvidence) => { e.cases[1].startedAt=e.cases[0].startedAt; },
  ]) { const altered = structuredClone(base); mutate(altered); assert.throws(() => inspectEightGBEvidence(altered)); }
  assert.throws(() => evaluateEightGBComparison(evidence(), { ...base, sourceBinding: 'e'.repeat(64) }), /sourceBinding/);
});
test('describe/evaluate runner is evidence-only and explicitly leaves combinations unverified', async () => {
  const description = await runEightGBValidation(['--describe']);
  assert('executionAdapter' in description); assert.equal(description.executionAdapter, 'real-electron-macos-adapter-unexecuted');
  assert(description.combinations.every(c => c.status === 'unverified')); assert.equal(description.fixtures.length, 12);
  await assert.rejects(runEightGBValidation(['--run-model', 'anything']), /Model execution is not implemented/);
});

test('candidate recommendation uses actual quality then measured latency then peak residency, excluding incomplete runs', () => {
  const reference=evidence(), a=evidence('qwen3.5:9b-ud-iq2-m',0),b=evidence('qwen3.5:9b-ud-iq3-xxs',0);
  b.latencies.forEach(row=>{row.completedAt=new Date(Date.parse(row.completedAt)+100).toISOString();});
  assert.equal(rankEightGBCandidates(reference,[b,a]).recommendedForIndependentReview,a.modelId);
  b.latencies=structuredClone(a.latencies);b.monitoring.samples.forEach(row=>{if(row.pid){row.rssBytes-=1024;row.residentBytes-=1024;}});
  assert.equal(rankEightGBCandidates(reference,[a,b]).recommendedForIndependentReview,b.modelId);
  a.cases.find(row=>row.fixtureId==='cli-inputs')!.independentChecks[0].passed=false;
  assert.equal(rankEightGBCandidates(reference,[a,b]).recommendedForIndependentReview,b.modelId);
  b.complete=false;const rejected=rankEightGBCandidates(reference,[b]);assert.equal(rejected.recommendedForIndependentReview,null);assert.equal(rejected.excluded.length,1);assert.equal(rejected.supportClaimEstablished,false);
});

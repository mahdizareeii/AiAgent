import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { usesCompactCPUContext } from '../compact-context.ts';
import { PORTABLE_CPU_PROFILE, parsePortableCPUAllocationPlan } from '../../runtime/portable-admission.ts';
import { inferenceProfileSignature } from '../../runtime/memory.ts';

test('concise host context requires the complete admitted portable identity', () => {
  const profile = { ...PORTABLE_CPU_PROFILE, memoryMode: 'low-memory', profileSignature: inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory') };
  assert.equal(usesCompactCPUContext(profile), true);
  for (const changed of [{ contextTokens: 8192 }, { outputTokens: 512 }, { memoryMode: 'automatic' },
    { profileSignature: undefined }, { profileSignature: profile.profileSignature + ' ' },
    { profileSignature: JSON.stringify({ ...JSON.parse(profile.profileSignature), backend: 'metal' }) }]) {
    assert.equal(usesCompactCPUContext({ ...profile, ...changed }), false);
  }
});

test('production admitted identity joins the exact portable plan instead of losing compaction after admission', () => {
  const base = inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory');
  const plan = parsePortableCPUAllocationPlan('Host 2600 128 32\n', { model: 'qwen3.5:4b', modelDigest: 'a'.repeat(64), engineDigest: 'b'.repeat(64), templateDigest: 'c'.repeat(64), plannerDigest: 'd'.repeat(64), artifactBytes: 2_740_937_888, profileSignature: base });
  const profileSignature = JSON.stringify({ ...JSON.parse(base), portableMemoryPlanDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') });
  const profile = { ...PORTABLE_CPU_PROFILE, memoryMode: 'low-memory', portableMemoryPlan: plan, profileSignature };
  assert.equal(usesCompactCPUContext(profile), true);
  assert.equal(usesCompactCPUContext({ ...profile, portableMemoryPlan: undefined }), false);
  assert.equal(usesCompactCPUContext({ ...profile, profileSignature: base }), false);
  assert.equal(usesCompactCPUContext({ ...profile, portableMemoryPlan: { ...plan, workingBytes: plan.workingBytes + 1 } }), false);
  assert.equal(usesCompactCPUContext({ ...profile, profileSignature: JSON.stringify({ ...JSON.parse(profileSignature), extra: true }) }), false);
  const old16Plan = { ...plan, profileSignature: JSON.stringify({ ...JSON.parse(base), microBatchTokens: 16 }) };
  const old16Identity = JSON.stringify({ ...JSON.parse(old16Plan.profileSignature), portableMemoryPlanDigest: createHash('sha256').update(JSON.stringify(old16Plan)).digest('hex') });
  assert.equal(usesCompactCPUContext({ ...profile, portableMemoryPlan: old16Plan, profileSignature: old16Identity }), false, 'A genuine old16 binding cannot attest the new32 profile.');
});

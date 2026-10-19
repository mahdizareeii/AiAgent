import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CATALOG } from '../catalog.ts';
import { GIB, operatingSystemReserve, classifyModel, type HardwareInfo } from '../hardware.ts';
import { inferenceProfileSignature } from '../memory.ts';
import { parseLinuxAvailableMemory, parseLinuxHostMemory, parseLinuxOwnedProcess, parseWindowsMemory, windowsMemoryCommand } from '../platform-memory.ts';
import { PORTABLE_CPU_PROFILE, PORTABLE_CPU_ARGUMENTS, PortableCPUStartupLog, isPortableCPUProfile, parsePortableCPUAllocationPlan, assertPortableCPUAdmission, assertPortableCPURuntime, type PortableCPUAdmissionDiagnostic } from '../portable-admission.ts';

const host = (available = 6 * GIB): HardwareInfo => ({ platform: 'linux', architecture: 'x64', cpuModel: 'fixture', cpuCores: 4, totalMemoryBytes: 8 * GIB, availableMemoryBytes: available, freeDiskBytes: null, gpus: [] });
const meminfo = 'MemTotal:       8388608 kB\nMemFree: 20 kB\nCached: 2000000 kB\nMemAvailable: 6291456 kB\nSwapFree: 9999999 kB\n';
const psi = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
const sample = () => ({ sampledAt: new Date().toISOString(), residentBytes: 3 * GIB, rssBytes: 3 * GIB, availableMemoryBytes: 6 * GIB, pressure: 'normal' as const });
const binding = () => ({ model: 'qwen3.5:9b-ud-iq2-m', modelDigest: 'a'.repeat(64), engineDigest: 'b'.repeat(64), templateDigest: 'c'.repeat(64), plannerDigest: 'd'.repeat(64), artifactBytes: 3 * GIB, profileSignature: inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory') });
const plan = () => parsePortableCPUAllocationPlan('Device Model Context Compute\nHost 3072 128 128\n', binding());

test('Linux availability uses MemAvailable exactly once; free/cache/swap do not enlarge it', () => {
  assert.deepEqual(parseLinuxAvailableMemory(meminfo), { totalMemoryBytes: 8 * GIB, availableMemoryBytes: 6 * GIB });
  for (const text of [meminfo.replace('MemAvailable:', 'Unavailable:'), meminfo + 'MemAvailable: 1 kB\n', meminfo.replace('6291456', '99999999')]) assert.throws(() => parseLinuxAvailableMemory(text), { code: 'RESOURCE_MONITOR_UNAVAILABLE' });
});
test('Linux pressure requires both PSI counters and reacts to stalls and low headroom', () => {
  assert.equal(parseLinuxHostMemory(meminfo, psi).pressure, 'normal');
  assert.equal(parseLinuxHostMemory(meminfo, psi.replace('some avg10=0.00', 'some avg10=5.00')).pressure, 'warning');
  assert.equal(parseLinuxHostMemory(meminfo, psi.replace('full avg10=0.00', 'full avg10=1.00')).pressure, 'critical');
  assert.equal(parseLinuxHostMemory(meminfo.replace('6291456', '200000'), psi).pressure, 'critical');
  assert.throws(() => parseLinuxHostMemory(meminfo, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0'), { code: 'RESOURCE_MONITOR_UNAVAILABLE' });
});
test('Linux precise resident snapshot belongs to the live child; swap is separate', () => {
  const status = 'Pid: 123\nPPid: 10\nState: S (sleeping)\nVmRSS: 999999 kB\n', rollup = 'Rss: 1024 kB\nSwap: 2048 kB\n';
  assert.deepEqual(parseLinuxOwnedProcess(status, rollup, 123, 10), { rssBytes: 1024 ** 2, swapBytes: 2 * 1024 ** 2 });
  for (const [pid, parent] of [[124, 10], [123, 11]]) assert.throws(() => parseLinuxOwnedProcess(status, rollup, pid, parent), { code: 'RESOURCE_MONITOR_UNAVAILABLE' });
  assert.throws(() => parseLinuxOwnedProcess(status.replace('S (sleeping)', 'Z (zombie)'), rollup, 123, 10), { code: 'RESOURCE_MONITOR_UNAVAILABLE' });
});
test('Windows working set is resident; private commit is recorded separately and never a footprint', () => {
  const raw = { schemaVersion: 1, pid: 123, parentPid: 10, totalMemoryBytes: 8 * GIB, availableMemoryBytes: 6 * GIB, committedBytes: 8 * GIB, commitLimitBytes: 16 * GIB, rssBytes: 2 * GIB, privateCommitBytes: 5 * GIB, sampledAtMilliseconds: Date.now() };
  const observed = parseWindowsMemory(JSON.stringify(raw), 123, 10);
  assert.equal(observed.residentBytes, 2 * GIB); assert.equal(observed.privateCommitBytes, 5 * GIB); assert.equal(observed.physicalFootprintBytes, undefined); assert.equal(observed.pressure, 'normal');
  assert.equal(parseWindowsMemory(JSON.stringify({ ...raw, committedBytes: 15.5 * GIB }), 123, 10).pressure, 'critical');
  for (const delta of [{ parentPid: 11 }, { sampledAtMilliseconds: Date.now() - 3000 }, { rssBytes: '123' }, { availableMemoryBytes: 9 * GIB }]) assert.throws(() => parseWindowsMemory(JSON.stringify({ ...raw, ...delta }), 123, 10), { code: 'RESOURCE_MONITOR_UNAVAILABLE' });
  assert.throws(() => windowsMemoryCommand(NaN, 10)); assert.match(windowsMemoryCommand(123, 10), /ParentProcessId -ne 10/); assert.doesNotMatch(windowsMemoryCommand(null, 10), /Get-Process -Id/);
});
test('portable CPU plan counts full weights, upper-rounded context/compute and process headroom separately', () => {
  const p = plan();
  assert.equal(p.modelBytes, 3073 * 1024 ** 2); assert.equal(p.contextBytes, 129 * 1024 ** 2); assert.equal(p.computeBytes, 129 * 1024 ** 2); assert.equal(p.processHeadroomBytes, GIB);
  assert.equal(p.workingBytes, p.modelBytes + p.contextBytes + p.computeBytes + GIB);
  assertPortableCPUAdmission(p, host(), sample());
  assert.equal(operatingSystemReserve(8 * GIB), 3 * GIB); assert(PORTABLE_CPU_ARGUMENTS.includes('--no-repack'));
  for (const rows of ['MTL0 3072 128 128\n', 'Host 3072 128 128\nHost 1 1 1\n', 'Host 3072 0 128\n']) assert.throws(() => parsePortableCPUAllocationPlan(rows, binding()), { code: 'MODEL_MEMORY_PLAN_INVALID' });
  assert.throws(() => parsePortableCPUAllocationPlan('Host 3072 128 128', { ...binding(), profileSignature: JSON.stringify({ ...JSON.parse(binding().profileSignature), backend: 'vulkan' }) }), { code: 'MODEL_MEMORY_PLAN_INVALID' });
  assert.deepEqual(JSON.parse(binding().profileSignature).portableCPUArguments, PORTABLE_CPU_ARGUMENTS);
  assert.throws(() => inferenceProfileSignature({ ...PORTABLE_CPU_PROFILE, portableCPUArguments: ['--threads','8'] }, 'low-memory'), { code: 'MODEL_PROFILE_MISMATCH' });
});
test('portable32 identity is one changed factor and old16 or unbound planner signatures cannot become a fresh plan', () => {
  const expected = { backend: 'cpu', contextTokens: 4096, outputTokens: 1024, batchTokens: 64, microBatchTokens: 32,
    cacheTypeK: 'f16', cacheTypeV: 'f16', portableCPUArguments: PORTABLE_CPU_ARGUMENTS };
  assert.deepEqual(PORTABLE_CPU_PROFILE, expected);
  const current = binding(), old16 = JSON.stringify({ ...JSON.parse(current.profileSignature), microBatchTokens: 16 });
  assert.notEqual(old16, current.profileSignature);
  for (const microBatchTokens of [8, 16, 64]) {
    const changed = { ...PORTABLE_CPU_PROFILE, microBatchTokens };
    assert.equal(isPortableCPUProfile(changed), false);
    assert.throws(() => inferenceProfileSignature(changed, 'low-memory'), { code: 'MODEL_PROFILE_MISMATCH' });
  }
  for (const profileSignature of [old16,
    JSON.stringify({ ...JSON.parse(current.profileSignature), portableCPUArguments: undefined }),
    JSON.stringify({ ...JSON.parse(current.profileSignature), slots: 2 }),
    JSON.stringify({ ...JSON.parse(current.profileSignature), extra: true })]) {
    assert.throws(() => parsePortableCPUAllocationPlan('Host 3072 128 128\n', { ...current, profileSignature }), { code: 'MODEL_MEMORY_PLAN_INVALID' });
  }
  const p = parsePortableCPUAllocationPlan('Host 3072 128 128\n', current);
  assert.equal(p.profileSignature, current.profileSignature); assert.equal(p.processHeadroomBytes, GIB);
  assert.equal(p.workingBytes, p.modelBytes + p.contextBytes + p.computeBytes + GIB);
});
test('portable admission never borrows VRAM, swap, missing telemetry or the OS reserve', () => {
  const p = plan();
  for (const [h, s] of [[host(), { ...sample(), pressure: 'warning' }], [host(), { ...sample(), availableMemoryBytes: p.workingBytes }], [{ ...host(), totalMemoryBytes: 6 * GIB }, sample()]] as const) assert.throws(() => assertPortableCPUAdmission(p, h, s), { code: 'INSUFFICIENT_MEMORY' });
  assert.throws(() => assertPortableCPUAdmission({ ...p, workingBytes: 1 }, host(), sample()), { code: 'MODEL_MEMORY_PLAN_INVALID' });
  assert.throws(() => assertPortableCPURuntime(p, host(), { ...sample(), rssBytes: undefined }), { code: 'RESOURCE_MONITOR_UNAVAILABLE' });
  assert.throws(() => assertPortableCPURuntime(p, host(), { ...sample(), availableMemoryBytes: GIB - 1 }), { code: 'MODEL_MEMORY_CALIBRATION_FAILED' });
});
test('portable rejection diagnostics preserve exact capacity/headroom one-byte boundaries without changing admission', () => {
  const original = plan(), capacity = 5 * GIB;
  const withWorking = (workingBytes: number) => ({ ...original, modelBytes: workingBytes - original.contextBytes - original.computeBytes - GIB, workingBytes });
  for (const delta of [-1, 0, 1]) {
    const p = withWorking(capacity + delta), s = { ...sample(), availableMemoryBytes: p.workingBytes + GIB };
    let recorded: PortableCPUAdmissionDiagnostic | undefined;
    const run = () => assertPortableCPUAdmission(p, host(), s, value => { recorded = value; });
    if (delta > 0) assert.throws(run, { code: 'INSUFFICIENT_MEMORY' }); else run();
    const actual = recorded!;
    assert.equal(actual.decision, delta > 0 ? 'rejected' : 'admitted');
    assert.equal(actual.limits.operatingSystemReserveBytes, 3 * GIB); assert.equal(actual.limits.capacityBytes, capacity);
    assert.equal(actual.limits.currentHeadroomBytes, GIB); assert.equal(actual.limits.requiredAvailableMemoryBytes, p.workingBytes + GIB);
    assert.equal(actual.deficits.capacityBytes, Math.max(0, delta)); assert.equal(actual.deficits.availableHeadroomBytes, 0);
    assert.deepEqual(actual.reasons, delta > 0 ? ['capacity'] : []); assert.deepEqual(actual.plan, p); assert.deepEqual(actual.sample.availableMemoryBytes, s.availableMemoryBytes);
  }
  for (const delta of [-1, 0, 1]) {
    const p = withWorking(capacity), s = { ...sample(), availableMemoryBytes: p.workingBytes + GIB + delta };
    let recorded: PortableCPUAdmissionDiagnostic | undefined;
    const run = () => assertPortableCPUAdmission(p, host(), s, value => { recorded = value; });
    if (delta < 0) assert.throws(run, { code: 'INSUFFICIENT_MEMORY' }); else run();
    assert.equal(recorded!.decision, delta < 0 ? 'rejected' : 'admitted'); assert.equal(recorded!.deficits.capacityBytes, 0);
    assert.equal(recorded!.deficits.availableHeadroomBytes, Math.max(0, -delta)); assert.deepEqual(recorded!.reasons, delta < 0 ? ['available-headroom'] : []);
  }
});
test('portable diagnostics retain compound reasons, owned telemetry and bounded scalar identities without caller aliases', () => {
  const p = { ...plan(), modelBytes: 6 * GIB, workingBytes: 7 * GIB + 258 * 1024 ** 2, secret: 'unrelated caller data' };
  const s = { ...sample(), pressure: 'warning' as const, privateCommitBytes: 7 * GIB, swapBytes: GIB,
    monitor: { platform: 'linux' as const, source: 'proc/meminfo+smaps_rollup', pressureSource: 'memory-PSI+available-headroom-policy', pid: null, parentPid: null } };
  let diagnostic: PortableCPUAdmissionDiagnostic | undefined;
  assert.throws(() => assertPortableCPUAdmission(p, host(), s, value => { diagnostic = value; }), { code: 'INSUFFICIENT_MEMORY' });
  const saved = JSON.parse(JSON.stringify(diagnostic)) as PortableCPUAdmissionDiagnostic;
  assert.deepEqual(saved.reasons, ['capacity', 'pressure', 'available-headroom']); assert.equal(saved.plan!.modelDigest, p.modelDigest);
  assert.equal(saved.plan!.profileSignature, binding().profileSignature); assert.equal(saved.plan!.processHeadroomBytes, GIB);
  assert.equal(saved.sample.privateCommitBytes, 7 * GIB); assert.equal(saved.sample.swapBytes, GIB); assert.deepEqual(saved.sample.monitor, s.monitor);
  assert.equal(saved.sample.physicalFootprintBytes, null, 'Commit and swap never invent a physical footprint.');
  assert.doesNotMatch(JSON.stringify(saved), /secret|unrelated caller data/); assert(Buffer.byteLength(JSON.stringify(saved)) < 16 * 1024);
  p.modelDigest = 'e'.repeat(64); s.monitor.source = 'changed'; assert.notEqual(diagnostic!.plan!.modelDigest, p.modelDigest); assert.notEqual(diagnostic!.sample.monitor!.source, s.monitor.source);
});
test('malformed or stale portable inputs remain fail-closed and diagnostics cannot relabel them as measured admission', () => {
  for (const [p, s] of [[{ ...plan(), workingBytes: 1 }, sample()], [plan(), { ...sample(), sampledAt: new Date(Date.now() - 3000).toISOString() }], [{ ...plan(), contextBytes: NaN }, sample()]] as const) {
    let recorded: PortableCPUAdmissionDiagnostic | undefined;
    assert.throws(() => assertPortableCPUAdmission(p, host(), s, value => { recorded = value; }), { code: 'MODEL_MEMORY_PLAN_INVALID' });
    assert.equal(recorded!.decision, 'invalid'); assert.equal(recorded!.code, 'MODEL_MEMORY_PLAN_INVALID'); assert.deepEqual(recorded!.reasons, ['invalid-inputs']);
    if (!Number.isFinite(p.contextBytes)) assert.equal(recorded!.plan, null);
  }
  for (const rows of ['Host nope 128 128\n', 'Device Model Context Compute\n', 'Unknown 3072 128 128\n']) assert.throws(() => parsePortableCPUAllocationPlan(rows, binding()), { code: 'MODEL_MEMORY_PLAN_INVALID' });
  const p = plan();
  for (const delta of [-1, 0, 1]) {
    const s = { ...sample(), rssBytes: p.workingBytes + delta, residentBytes: p.workingBytes + delta, availableMemoryBytes: GIB };
    if (delta > 0) assert.throws(() => assertPortableCPURuntime(p, host(), s), { code: 'MODEL_MEMORY_CALIBRATION_FAILED' }); else assertPortableCPURuntime(p, host(), s);
    const atHeadroom = { ...sample(), availableMemoryBytes: GIB + delta };
    if (delta < 0) assert.throws(() => assertPortableCPURuntime(p, host(), atHeadroom), { code: 'MODEL_MEMORY_CALIBRATION_FAILED' }); else assertPortableCPURuntime(p, host(), atHeadroom);
  }
});
test('9B low-RAM artifacts retain primary immutable pins and unverified status rather than inherited support', () => {
  const candidates = MODEL_CATALOG.filter(m => m.lowRamCandidate);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map(m => [m.quantization, m.estimatedDownloadBytes, m.sha256]), [
    ['Q3_K_S', 4316865760, '162050d39ebae6b8a87435f282bcb7a0e3fab7b2444db730966b3fef1ed0179e'],
    ['UD-IQ3_XXS', 4016235744, '40d0f32cd3030b04f0784139a589fb63e876cfbf8667d56311b79783c74fd149'],
    ['UD-IQ2_M', 3649365216, 'a31b6b4c603ddd66b5496ee065c9dd13b2b6de77dce9e5d59609aef8d39868e7'],
  ]);
  for (const m of candidates) { assert.equal(m.revision, '3885219b6810b007914f3a7950a8d1b469d598a5'); assert.equal(m.lowRamCandidate?.evidence, 'unverified'); assert.match(m.description, /unverified/); }
  assert.equal(classifyModel(candidates[0], host(), 4096).fit, 'insufficient', 'An 8 GB label cannot override the OS reserve.');
});
test('portable CPU startup binds actual scalar geometry, placement, precision, actual props and owned output argument across chunks', () => {
  const native = 'llama_context: n_seq_max = 1\nllama_context: n_ctx = 4096\nllama_context: n_ctx_seq = 4096\nllama_context: n_batch = 64\nllama_context: n_ubatch = 32\nllama_context: n_rs_seq = 0\nllama_context: flash_attn = disabled\nllama_kv_cache: K (f16): 128.00 MiB, V (f16): 128.00 MiB\nload_tensors: CPU_Mapped model buffer size = 3072.00 MiB\nload_tensors: offloaded 0/33 layers to GPU\nsystem_info: n_threads = 4 (n_threads_batch = 4)\n';
  const props = { contextTokens: 4096, outputTokensFromOwnedArguments: 1024, slots: 1 };
  const log = new PortableCPUStartupLog(); log.push(native.slice(0, 59)); log.push(native.slice(59)); assert(log.matches(props));
  assert(log.matches({ ...props, maximumMappedBytes: 3073 * 1024 ** 2 })); assert(!log.matches({ ...props, maximumMappedBytes: GIB }));
  assert(!log.matches({ ...props, outputTokensFromOwnedArguments: 512 })); assert(!log.matches({ ...props, slots: 2 }));
  for (const broken of [native.replace('n_ubatch = 32', 'n_ubatch = 16'), native.replace('n_ubatch = 32', 'n_ubatch = 64'), native.replace('n_ctx = 4096', 'n_ctx = 2048'), native.replace('n_ctx = 4096', 'n_ctx = wrong'), native.replace('CPU_Mapped', 'Vulkan0'), native.replace('offloaded 0/', 'offloaded 1/'), native.replace('n_threads = 4', 'n_threads = 8'), native.replace('K (f16)', 'K (q8_0)'), native.replace('flash_attn = disabled', 'flash_attn = enabled'), native + 'llama_context: n_ctx = 2048\n', native + 'context checkpoints enabled, max = 1\n', native.replace('llama_context: n_seq_max = 1\n', '')]) {
    const bad = new PortableCPUStartupLog(); bad.push(broken); assert(!bad.matches(props), broken);
  }
});

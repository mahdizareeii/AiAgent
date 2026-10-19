import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BudgetedInference, type ChatBody, type InferenceProfile, type InferenceRuntime } from '../inference-gateway.ts';
import { initializeContextRecoveryArchive } from '../context-recovery.ts';
import { PORTABLE_CPU_PROFILE, parsePortableCPUAllocationPlan } from '../../runtime/portable-admission.ts';
import { inferenceProfileSignature } from '../../runtime/memory.ts';

const baseSignature = inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory');
const portableMemoryPlan = parsePortableCPUAllocationPlan('Host 24 2 3\n', { model: 'owned', modelDigest: 'a'.repeat(64), templateDigest: 'b'.repeat(64),
  engineDigest: 'c'.repeat(64), plannerDigest: 'd'.repeat(64), profileSignature: baseSignature, artifactBytes: 17 * 1024 ** 2 });
// The production runtime appends the digest of the exact parsed plan.
const profile: InferenceProfile = { model: 'owned', contextTokens: 4096, outputTokens: 1024, memoryMode: 'low-memory', portableMemoryPlan,
  profileSignature: JSON.stringify({ ...JSON.parse(baseSignature), portableMemoryPlanDigest: createHash('sha256').update(JSON.stringify(portableMemoryPlan)).digest('hex') }) };
const readDescription = 'Read exact UTF-8 source in text, including BOM, CRLF and trailing newlines. Line/column and byte positions are separate metadata, never inserted into text. Copy text exactly for edits; never add/remove line-number prefixes. Continue next_cursor until eof, including long single lines. expected_sha256 detects changed checkpoints. Secret files/symlinks are denied.';
function tool() { return { type: 'function', function: { name: 'local_files_and_research__read_file', description: readDescription,
  parameters: { type: 'object', title: 'read_fileArguments', properties: { path: { type: 'string', title: 'Path' } }, required: ['path'], additionalProperties: false } } }; }
function fixture(count: (body: ChatBody, index: number) => number) {
  const counted: ChatBody[] = []; let generations = 0, restarts = 0;
  const runtime: InferenceRuntime = {
    requestJson: async <T>(url: string, raw?: object) => {
      if (!url.endsWith('input_tokens')) { generations++; throw new Error('No generation authorized by this fixture.'); }
      const body = raw as ChatBody; counted.push(body); return { input_tokens: count(body, counted.length) } as T;
    },
    requestStream: async () => { generations++; throw new Error('No generation authorized by this fixture.'); },
    restartLowerProfile: async () => { restarts++; throw new Error('No profile change authorized by this fixture.'); },
  };
  return { runtime, counted, generations: () => generations, restarts: () => restarts };
}
async function withArchive(run: (archive: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'portable-context-')));
  try { const archive = await initializeContextRecoveryArchive(path.join(directory, 'manifest.json')); await run(archive.path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('only exact trusted portable coding profiles use schema documentation compaction; all active bytes remain exact', async () => {
  await withArchive(async recoveryArchivePath => {
    const request = ' Preserve ALL requirements — سلام\r\n', messages = [
      { role: 'system', content: 'Unowned system and plugin instructions — exact.' }, { role: 'user', content: request },
      { role: 'assistant', content: null, tool_calls: [{ id: 'latest', function: { name: 'local_files_and_research__read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'latest', content: '{"text":"\ufeffسلام\\r\\n","nonce":"exact-private-receipt","eof":true,"truncated":false}' },
    ];
    const tools = [tool(), { type: 'function', function: { name: 'plugin__read_file', description: 'Unknown plugin description', parameters: { title: 'read_fileArguments', type: 'object' } } }];
    const body: ChatBody = { messages, tools, profileSignature: profile.profileSignature }, before = JSON.stringify(body);
    const f = fixture(() => 100), inference = new BudgetedInference(f.runtime, profile, undefined, 40, { currentRequest: request, recoveryArchivePath });
    const exportedProfile = inference.currentProfile;
    assert.deepEqual(exportedProfile.portableMemoryPlan, portableMemoryPlan);
    assert.notStrictEqual(exportedProfile.portableMemoryPlan, portableMemoryPlan);
    exportedProfile.portableMemoryPlan!.workingBytes++;
    assert.equal(inference.currentProfile.portableMemoryPlan!.workingBytes, portableMemoryPlan.workingBytes, 'Exported plan evidence cannot mutate the trusted profile.');
    const prepared = await inference.prepare(body);
    assert.strictEqual(prepared.messages, messages);
    assert.strictEqual(prepared.tools?.[1], tools[1]);
    const compacted = prepared.tools?.[0] as ReturnType<typeof tool>;
    assert.equal('title' in compacted.function.parameters, false);
    assert.equal('title' in compacted.function.parameters.properties.path, false);
    assert.equal(compacted.function.parameters.additionalProperties, false);
    assert.strictEqual(f.counted[0], prepared, 'The exact returned body was counted before execution.');
    assert.equal(JSON.stringify(body), before);
    for (const changed of [{ ...profile, profileSignature: undefined }, { ...profile, memoryMode: 'automatic' as const },
      { ...profile, contextTokens: 8192 }, { ...profile, profileSignature: profile.profileSignature + ' ' },
      { ...profile, portableMemoryPlan: undefined }, { ...profile, portableMemoryPlan: { ...portableMemoryPlan, workingBytes: portableMemoryPlan.workingBytes + 1 } }]) {
      const other = new BudgetedInference(f.runtime, changed, undefined, 40, { recoveryArchivePath });
      const result = await other.prepare(body);
      assert.strictEqual((result.tools?.[0] as ReturnType<typeof tool>).function.parameters, tools[0].function.parameters,
        'A body flag, missing identity or another profile cannot enable schema annotation changes.');
    }
    const helper = await inference.prepare(body, undefined, 'helper');
    assert.strictEqual(helper.tools, tools, 'Preparation/helper docs and all messages stay unchanged.');
    assert.equal(f.generations(), 0); assert.equal(f.restarts(), 0);
  });
});

test('full rendered native count uses unchanged 3008-token budget and records numeric rejection without leaking prompt data', async () => {
  const request = 'FULL PRIVATE REQUEST\r\nسلام', body: ChatBody = { messages: [{ role: 'system', content: 'PRIVATE SYSTEM' }, { role: 'user', content: request }], tools: [tool()] };
  let tokens = 3008;
  const f = fixture(actual => { assert.deepEqual(actual.messages, body.messages); assert.deepEqual(actual.tools, body.tools); return tokens; });
  const accepted = new BudgetedInference(f.runtime, profile);
  assert.equal((await accepted.prepare(body)).max_tokens, 1024);
  tokens = 3009;
  const denied = new BudgetedInference(f.runtime, profile);
  await assert.rejects(denied.prepare(body), /"stage":"full-request","inputTokens":3009,"reservedOutputTokens":1024,"contextTokens":4096,"marginTokens":64,"inputLimitTokens":3008/);
  assert.equal(denied.terminalFailure?.code, 'CONTEXT_LIMIT');
  assert.doesNotMatch(denied.terminalFailure!.message, /PRIVATE|سلام|read_file|path/);
  assert.deepEqual(denied.generationCounts, { preparation: 0, execution: 0, finalization: 0 });
  assert.equal(f.counted.length, 2); assert.equal(f.generations(), 0); assert.equal(f.restarts(), 0);
});

test('archive rejection retains both actual full-body counts and exact latest receipt without replay or budget relaxation', async () => {
  await withArchive(async recoveryArchivePath => {
    const pair = (id: string, text: string) => [
      { role: 'assistant', content: null, tool_calls: [{ id, function: { name: 'local_files_and_research__read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: id, content: JSON.stringify({ text, path: 'a.txt', sha256: 'a'.repeat(64) }) },
    ];
    const latest = pair('latest', 'LATEST RECEIPT EXACT — سلام\r\n'), request = 'Original full request';
    const body: ChatBody = { messages: [{ role: 'system', content: 'EXACT SYSTEM' }, { role: 'user', content: request }, ...pair('closed', 'OLDER CLOSED FACTS'), ...latest], tools: [tool()] };
    const before = JSON.stringify(body), f = fixture((_body, index) => index === 1 ? 3400 : 3100);
    const inference = new BudgetedInference(f.runtime, profile, undefined, 40, { currentRequest: request, recoveryArchivePath });
    await assert.rejects(inference.prepare(body), /archived closed history.*"stage":"archived-closed-history","inputTokens":3100,"reservedOutputTokens":1024,"contextTokens":4096,"marginTokens":64,"inputLimitTokens":3008,"initialInputTokens":3400/);
    assert.equal(f.counted.length, 2);
    for (const message of latest) assert.ok(f.counted[1].messages.includes(message));
    assert.strictEqual(f.counted[1].messages[0], body.messages[0]);
    assert.strictEqual(f.counted[1].messages[1], body.messages[1]);
    assert.equal(JSON.stringify(body), before);
    assert.equal(f.generations(), 0); assert.equal(f.restarts(), 0);
    assert.deepEqual(inference.generationCounts, { preparation: 0, execution: 0, finalization: 0 });
  });
});

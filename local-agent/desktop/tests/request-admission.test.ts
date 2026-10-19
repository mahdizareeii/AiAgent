import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetedInference, type ChatBody, type InferenceRuntime } from '../inference-gateway.ts';

test('oversized full requests fail before any generation and retain literal requirements', async () => {
  const request = 'Keep ALL requirements — سلام\r\n' + 'x'.repeat(9000), counted: ChatBody[] = [];
  let generations = 0;
  const runtime: InferenceRuntime = {
    requestJson: async <T>(url: string, raw?: object) => {
      if (url.endsWith('input_tokens')) { counted.push(raw as ChatBody); return { input_tokens: 3500 } as T; }
      generations++; throw new Error('Must not generate before admission.');
    },
    requestStream: async () => { generations++; throw new Error('Must not stream before admission.'); },
    restartLowerProfile: async () => { throw new Error('Do not silently change an oversized request profile.'); },
  };
  const inference = new BudgetedInference(runtime, { model: 'owned', contextTokens: 4096, outputTokens: 1024 });
  await assert.rejects(inference.admitRequest(request), /3500 input tokens.*1024 reserved.*4096.*Shorten.*preserved/);
  assert.equal(counted[0].messages[0].content, request); assert.equal(generations, 0);
  assert.equal(inference.terminalFailure?.code, 'CONTEXT_LIMIT');
  assert.deepEqual(inference.generationCounts, { preparation: 0, execution: 0, finalization: 0 });
});

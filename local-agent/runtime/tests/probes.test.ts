import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixedProbeDiagnostic,probeFailureDetail} from '../probes.ts';

test('fixed-probe diagnostics bound model text and tool details without inventing output counts',()=>{
  const p=fixedProbeDiagnostic('chat',{choices:[{finish_reason:'x'.repeat(200),message:{content:'a'.repeat(2000),reasoning_content:'b'.repeat(2000),tool_calls:Array.from({length:3},()=>({function:{name:'n'.repeat(300),arguments:'j'.repeat(2000)}}))}}],usage:{completion_tokens:NaN}},16,false,{model:'fixture'});
  assert.equal(p.content!.length,512);assert.equal(p.reasoning!.length,512);assert.equal(p.finishReason!.length,64);assert.equal(p.toolCalls.length,2);assert.equal(p.toolCallCount,3);assert.equal(p.toolCalls[0].name!.length,128);assert.equal(p.toolCalls[0].arguments!.length,512);assert.equal(p.truncated,true);assert.equal(p.outputTokens,null);assert.equal(p.thinkingDisabled,true);assert.match(probeFailureDetail(p),/unreported\/16/);
});

test('fixed-probe token counts use native usage or reported predicted token count only',()=>{
  assert.equal(fixedProbeDiagnostic('tools',{timings:{predicted_n:27,predicted_per_second:42}},96,true,{model:'fixture'}).outputTokens,27);
  assert.equal(fixedProbeDiagnostic('tools',{timings:{predicted_per_second:42}},96,true,{model:'fixture'}).outputTokens,null);
  assert.equal(fixedProbeDiagnostic('chat',{usage:{completion_tokens:0}},16,false,{model:'fixture'}).outputTokens,0);
});

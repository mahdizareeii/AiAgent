import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOCATION_PLANNER_PINS,allocationPlannerDescriptor,matchesAllocationPlanner } from '../planner-pins.ts';
import { PINNED_NATIVE_PLANNER_SHA256 } from '../memory.ts';
// @ts-expect-error The existing resource-preparation entry point is JavaScript.
import { INFERENCE_TARGETS } from '../../../scripts/prepare-inference.mjs';

test('the build selects exactly the pinned official planner on every supported platform',()=>{
  assert.equal(ALLOCATION_PLANNER_PINS['darwin-arm64'].sha256,PINNED_NATIVE_PLANNER_SHA256);
  for(const [target,pin] of Object.entries(ALLOCATION_PLANNER_PINS)){assert.deepEqual(INFERENCE_TARGETS[target].planner,allocationPlannerDescriptor(target));assert.equal(INFERENCE_TARGETS[target].planner.id,target==='darwin-arm64'?'metal':'cpu');assert(matchesAllocationPlanner(INFERENCE_TARGETS[target].planner,target,[{path:pin.executable,sha256:pin.sha256}]));}
});
test('runtime planner admission rejects changed binaries, paths, arguments, backends and duplicate inventory witnesses',()=>{
  for(const [target,pin] of Object.entries(ALLOCATION_PLANNER_PINS)){const planner=allocationPlannerDescriptor(target),files=[{path:pin.executable,sha256:pin.sha256}];for(const changed of [{...planner,id:'untrusted'},{...planner,executable:'other/llama-fit-params'},{...planner,libraryDirectory:'other'},{...planner,arguments:['--model','outside']}])assert.equal(matchesAllocationPlanner(changed,target,files),false);assert.equal(matchesAllocationPlanner(planner,target,[{...files[0],sha256:'0'.repeat(64)}]),false);assert.equal(matchesAllocationPlanner(planner,target,[...files,...files]),false);assert.equal(matchesAllocationPlanner(planner,'unsupported',files),false);}
});
test('planner descriptor serialization order cannot masquerade as an invalid official identity',()=>{
  const pin=ALLOCATION_PLANNER_PINS['linux-x64'];assert(matchesAllocationPlanner({arguments:[],libraryDirectory:pin.libraryDirectory,executable:pin.executable,id:pin.id},'linux-x64',[{path:pin.executable,sha256:pin.sha256}]));
});

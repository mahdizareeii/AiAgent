import assert from 'node:assert/strict';
import {test} from 'node:test';
import {codingModelFamily,isQualificationEligible,usesQualifiedProfiles,generationPolicyForModel,modelGenerationOptions} from '../generation.ts';
import {MODEL_CATALOG,modelArtifacts} from '../catalog.ts';
import {classifyModel,GIB,type HardwareInfo} from '../hardware.ts';

test('qualified policies use valid publisher effort and preserve legacy requests',()=>{
  const qwen=generationPolicyForModel('qwen3.8:27b'),muse=generationPolicyForModel('muse-glimmer:30b');
  assert.equal(modelGenerationOptions(qwen,'coding','careful').chat_template_kwargs?.reasoning_effort,'xhigh');
  assert.equal(modelGenerationOptions(qwen,'coding').chat_template_kwargs?.reasoning_effort,'medium');
  assert.equal(modelGenerationOptions(qwen,'helper').chat_template_kwargs?.enable_thinking,false);
  assert.equal(modelGenerationOptions(qwen,'helper').chat_template_kwargs?.preserve_thinking,true);
  assert.equal(modelGenerationOptions(muse,'probe').chat_template_kwargs?.reasoning_strength,'low');
  assert.equal(modelGenerationOptions(muse,'coding').chat_template_kwargs?.reasoning_strength,'high');
  assert.equal(modelGenerationOptions(muse,'helper').chat_template_kwargs?.enable_thinking,undefined);
  assert(muse.alwaysThinking);assert(muse.preserveThinking);assert.equal(muse.helperOutputTokens,8192);assert.equal(qwen.helperOutputTokens,2048);
  assert.deepEqual(modelGenerationOptions(undefined,'coding'),{});
  assert.deepEqual(modelGenerationOptions(undefined,'probe'),{temperature:0,chat_template_kwargs:{enable_thinking:false}});
});

test('catalog pins the exact selected conversions and profile estimates keep the OS reserve',()=>{
  const qwen=MODEL_CATALOG.find(m=>m.id==='qwen3.8:27b')!,muse=MODEL_CATALOG.find(m=>m.id==='muse-glimmer:30b')!;
  assert.equal(qwen.estimatedDownloadBytes,16810714336);assert.equal(qwen.revision,'5a7da681f60570ab5b439a587e912d2e5eddb582');
  assert.equal(muse.estimatedDownloadBytes,16756683904);assert.equal(muse.revision,'43c7eadd41352a299ea8e0a36b3157978dd63596');
  const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'M5',cpuCores:10,totalMemoryBytes:24*GIB,availableMemoryBytes:20*GIB,freeDiskBytes:100*GIB,gpus:[{name:'M5',backend:'metal',totalMemoryBytes:20*GIB,freeMemoryBytes:20*GIB,unifiedMemory:true}]};
  const primary=classifyModel(qwen,hardware,32768),fallback=classifyModel(qwen,hardware,16384);
  assert.equal(primary.workingMemoryGB,18.9);assert.equal(fallback.workingMemoryGB,17.9);
  assert.equal(primary.memoryEstimate.osReserveBytes,24*GIB*.2);
  assert.equal(classifyModel(qwen,{...hardware,availableMemoryBytes:7.5*GIB},16384).fit,'insufficient');
});

test('only exact Q4 and Q3 coding identities receive shared family settings',()=>{
  for(const [original,variant,family] of [['qwen3.8:27b','qwen3.8:27b-q3-k-m','qwen38'],['muse-glimmer:30b','muse-glimmer:30b-q3-k-m','muse-glimmer']] as const){
    for(const id of [original,variant]){assert.equal(codingModelFamily(id),family);assert.equal(isQualificationEligible(id),true);assert.equal(usesQualifiedProfiles(id),true);}
    const {codingPromptCache,...familyPolicy}=generationPolicyForModel(variant);
    assert.equal(codingPromptCache,true);assert.equal(generationPolicyForModel(original).codingPromptCache,undefined);
    assert.deepEqual(familyPolicy,generationPolicyForModel(original));
    for(const purpose of ['coding','helper','probe'] as const)assert.deepEqual(modelGenerationOptions(generationPolicyForModel(variant),purpose,'careful'),modelGenerationOptions(generationPolicyForModel(original),purpose,'careful'));
  }
  for(const id of ['qwen3.5:4b','qwen3.8:27b-q3-k-m-other','muse-glimmer:30b-q3-k-s','Qwen/Qwen3.8-27B','import:14865aaef0b6c26a013538782d366443c7298b11d5df9f0fb829d34d1963f869']){
    assert.equal(codingModelFamily(id),null);assert.equal(isQualificationEligible(id),false);assert.equal(usesQualifiedProfiles(id),false);assert.equal(generationPolicyForModel(id).kind,'default');assert.equal(generationPolicyForModel(id).codingPromptCache,undefined);
  }
});

test('Q3 candidates append separate immutable pins without changing the existing catalog identities',()=>{
  assert.deepEqual(MODEL_CATALOG.slice(0,8).map(m=>m.id),['qwen3.8:27b','muse-glimmer:30b','qwen3.5:4b','qwen3.5:9b','gemma4:12b','gemma4:26b','gemma4:31b','qwen3-coder-next:80b']);
  assert.deepEqual(MODEL_CATALOG.slice(8).map(m=>m.id),['qwen3.8:27b-q3-k-m','muse-glimmer:30b-q3-k-m','qwen3.5:9b-q3-k-s','qwen3.5:9b-ud-iq3-xxs','qwen3.5:9b-ud-iq2-m']);
  assert.equal(new Set(MODEL_CATALOG.map(m=>m.id)).size,MODEL_CATALOG.length);
  assert.equal(MODEL_CATALOG[0].sha256,'e00082f779fa385cee8c68a3ec8833a75778cc87272240b942f74e0b8243e520');
  assert.equal(MODEL_CATALOG[1].sha256,'4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e');
  const expected=[
    {id:'qwen3.8:27b-q3-k-m',repository:'bartowski/Qwen3.8-27B-GGUF',revision:'87410e7b9a5c21e6ca70c0c9cc5237de909fe621',filename:'Qwen3.8-27B-Q3_K_M.gguf',sizeBytes:13404051168,sha256:'14865aaef0b6c26a013538782d366443c7298b11d5df9f0fb829d34d1963f869',architecture:'qwen35',estimate:14.7},
    {id:'muse-glimmer:30b-q3-k-m',repository:'bartowski/Muse-Glimmer-30B-GGUF',revision:'01e1b7c30e19e1823ee9a73dec51d12f59ec4857',filename:'Muse-Glimmer-30B-Q3_K_M.gguf',sizeBytes:13962519328,sha256:'de551709c7977735a4012323b82ba34a5756127c6b03a730753a37a318f02872',architecture:'muse-glimmer',estimate:15},
  ];
  for(const e of expected){
    const candidate=MODEL_CATALOG.find(m=>m.id===e.id)!;
    assert(Object.isFrozen(candidate));assert.equal(candidate.repository,e.repository);assert.equal(candidate.sourceUrl,`https://huggingface.co/${e.repository}`);assert.equal(candidate.revision,e.revision);assert.equal(candidate.architecture,e.architecture);
    assert.equal(candidate.quantization,'Q3_K_M');assert.match(candidate.title,/Q3_K_M/);assert.match(candidate.description,/checks are required/);assert.equal(candidate.license,'Apache-2.0');assert.equal(candidate.profileMemoryGB?.[16384],e.estimate);assert(candidate.workingMemoryGB>e.estimate);
    assert.deepEqual(modelArtifacts(candidate),[{filename:e.filename,sizeBytes:e.sizeBytes,sha256:e.sha256}]);
  }
});

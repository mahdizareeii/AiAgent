import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GIB,parseMacAvailableMemory,type HardwareInfo} from '../hardware.ts';
import {parseNativeMemoryPlan,assertNativeMemoryAdmission,parseNativeResourceSample,nativeEnvironmentOverrides,nativePlacementArguments,nativeMappedPlacement,museQ3CPUPlacement,museQ3PhysicalCPUBlocks,NativeProfileLog,PINNED_NATIVE_PLANNER_SHA256,inferenceProfileSignature,type ResourceMeasurements,type NativeMemoryProfile} from '../memory.ts';
import type {GGUFMetadata} from '../gguf.ts';
import {generationPolicyForModel} from '../generation.ts';
import {QWEN_Q3_CHECKPOINT_POLICY,assertNativeCheckpointProfile} from '../memory.ts';

const profile:NativeMemoryProfile={backend:'metal',contextTokens:16384,outputTokens:4096,batchTokens:64,microBatchTokens:16,cacheTypeK:'f16',cacheTypeV:'f16',flashAttention:'on'};
const binding={model:'qwen3.8:27b',engineDigest:'a'.repeat(64),plannerDigest:PINNED_NATIVE_PLANNER_SHA256,modelDigest:'b'.repeat(64),templateDigest:'c'.repeat(64),profileSignature:inferenceProfileSignature(profile,'automatic'),artifactBytes:16810714336};
const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'M5',cpuCores:10,totalMemoryBytes:24*GIB,availableMemoryBytes:9.5*GIB,freeDiskBytes:null,gpus:[{backend:'metal',name:'M5',totalMemoryBytes:17.758789*GIB,freeMemoryBytes:17.758789*GIB,unifiedMemory:true}]};
const sample:ResourceMeasurements={sampledAt:new Date().toISOString(),residentBytes:0,availableMemoryBytes:9.5*GIB,pressure:'normal'};

const checkpointProfile:NativeMemoryProfile={backend:'metal',contextTokens:16384,outputTokens:4096,batchTokens:128,microBatchTokens:32,cacheTypeK:'q8_0',cacheTypeV:'q8_0',flashAttention:'on',metalResidency:'disabled',generationPolicy:generationPolicyForModel('qwen3.8:27b-q3-k-m'),nativePlacement:{gpuLayers:42,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true,outputNormOnCPU:true},recurrentCheckpoint:{...QWEN_Q3_CHECKPOINT_POLICY}};
const checkpointPlacement={gpuLayers:42,totalLayers:66,metalMappedBytes:7010474240,hostMappedBytes:6143598336,metalTensorBytes:7010474240,hostTensorBytes:6143598336};
const checkpointStartup='ggml_metal_device_init: use residency sets = false\nsystem_info: n_threads = 4 (n_threads_batch = 4) / 10\nload_tensors: offloaded 42/66 layers to GPU\nload_tensors: MTL0_Mapped model buffer size = 6685.71 MiB\nload_tensors: CPU_Mapped model buffer size = 5858.99 MiB\nllama_context: n_seq_max = 1\nllama_context: n_ctx = 16384\nllama_context: n_ctx_seq = 16384\nllama_context: n_batch = 128\nllama_context: n_ubatch = 32\nllama_context: n_rs_seq = 0\nllama_context: flash_attn = enabled\nllama_kv_cache: K (q8_0): 272.00 MiB, V (q8_0): 272.00 MiB\nllama_memory_recurrent: size = 149.62 MiB ( 1 cells, 64 layers, 1 seqs 0 rs_seq), R (f32): 5.62 MiB, S (f32): 144.00 MiB, P (f32): 0.00 MiB\nsrv load_model: context checkpoints enabled, max = 1, min spacing = 8192\n';
const createdCheckpoint='slot create_check: id  0 | task 653 | created context checkpoint 1 of 1 (pos_min = 5199, pos_max = 5199, n_tokens = 5200, size = 149.626 MiB)\n';
const restoredCheckpoint='slot update_slots: id  0 | task 766 | restored context checkpoint (pos_min = 5199, pos_max = 5199, n_tokens = 5200, n_past = 5200, size = 149.626 MiB)\n';

test('one Qwen Q3 checkpoint changes proof identity and reserves two bounded host copies only',()=>{
  const historical={...checkpointProfile,recurrentCheckpoint:undefined};
  const before=inferenceProfileSignature(historical,'low-memory'),after=inferenceProfileSignature(checkpointProfile,'low-memory');assert.notEqual(after,before);
  const b={...binding,model:'qwen3.8:27b-q3-k-m',artifactBytes:13404051168,mappedPlacement:checkpointPlacement,metalResidency:'disabled' as const};
  const output='MTL0 6685 433 94\nHost 5858 260 69';
  const old=parseNativeMemoryPlan(output,{...b,profileSignature:before}),current=parseNativeMemoryPlan(output,{...b,profileSignature:after});
  assert.deepEqual(current.rows,old.rows);assert.equal(current.gpuAllocationUpperBoundBytes,old.gpuAllocationUpperBoundBytes);assert.equal(current.mappedWeightsUpperBoundBytes,old.mappedWeightsUpperBoundBytes);
  assert.equal(current.workspaceBytes-old.workspaceBytes,320*1024**2);assert.equal(current.workingBytes-old.workingBytes,320*1024**2);assert.equal(current.processHeadroomBytes,old.processHeadroomBytes);assert.equal(current.checkpointHostReserveBytes,320*1024**2);assert.deepEqual(current.recurrentCheckpoint,QWEN_Q3_CHECKPOINT_POLICY);
  assert(QWEN_Q3_CHECKPOINT_POLICY.maximumSerializedBuffers*QWEN_Q3_CHECKPOINT_POLICY.serializedStateUpperBoundBytes<current.checkpointHostReserveBytes!);
  const reserve=4.8*GIB;const edge={...sample,availableMemoryBytes:Math.ceil(old.workspaceBytes+reserve)};assert.doesNotThrow(()=>assertNativeMemoryAdmission(old,hardware,edge));assert.throws(()=>assertNativeMemoryAdmission(current,hardware,edge),{code:'INSUFFICIENT_MEMORY'});
  for(const bad of [{...b,model:'muse-glimmer:30b-q3-k-m'},{...b,mappedPlacement:undefined},{...b,mappedPlacement:{...checkpointPlacement,gpuLayers:64}}])assert.throws(()=>parseNativeMemoryPlan(output,{...bad,profileSignature:after}),{code:'MODEL_MEMORY_PLAN_INVALID'});
  for(const bad of [{...checkpointProfile,backend:'cpu'},{...checkpointProfile,batchTokens:64},{...checkpointProfile,generationPolicy:generationPolicyForModel('qwen3.8:27b')},{...checkpointProfile,nativePlacement:{...checkpointProfile.nativePlacement!,gpuLayers:64}},{...checkpointProfile,recurrentCheckpoint:{...QWEN_Q3_CHECKPOINT_POLICY,maxCheckpoints:2}} as unknown as NativeMemoryProfile,{...checkpointProfile,recurrentCheckpoint:{...QWEN_Q3_CHECKPOINT_POLICY,hostReserveBytes:1}} as unknown as NativeMemoryProfile])assert.throws(()=>assertNativeCheckpointProfile(bad),{code:'MODEL_PROFILE_MISMATCH'});
  assert.throws(()=>assertNativeCheckpointProfile(checkpointProfile,'qwen3.8:27b'),{code:'MODEL_PROFILE_MISMATCH'});
});

test('checkpoint startup requires exact one-cell f32 R/S layout and rejects malformed or conflicting evidence',()=>{
  const valid=new NativeProfileLog();valid.push(checkpointStartup.slice(0,219));valid.push(checkpointStartup.slice(219));assert(valid.matches(checkpointProfile,checkpointPlacement));assert.equal(valid.checkpointBoundsValid(checkpointProfile,true),false,'enabled flags alone do not prove allocation');
  for(const bad of [checkpointStartup.replace('max = 1','max = 2'),checkpointStartup.replace('min spacing = 8192','min spacing = 0'),checkpointStartup.replace('n_rs_seq = 0','n_rs_seq = 1'),checkpointStartup.replace('1 cells','2 cells'),checkpointStartup.replace('64 layers','63 layers'),checkpointStartup.replace('1 seqs','2 seqs'),checkpointStartup.replace('R (f32)','R (f16)'),checkpointStartup.replace('S (f32)','S (f16)'),checkpointStartup.replace('P (f32): 0.00','P (f32): 1.00'),checkpointStartup.replace('149.62','149..62'),checkpointStartup.replace('5.62','NaN'),checkpointStartup.replace('144.00','144.01'),checkpointStartup.replace(/llama_memory_recurrent:.*\n/,''),checkpointStartup.replace(/srv load_model:.*\n/,''),checkpointStartup+'srv load_model: context checkpoints disabled\n',checkpointStartup+'srv load_model: context checkpoints enabled, max = 1, min spacing = 8192\n']){const log=new NativeProfileLog();log.push(bad);assert.equal(log.matches(checkpointProfile,checkpointPlacement),false,bad);}
});

test('created and restored checkpoint rounding intervals, identities and bounds remain enforced after startup',()=>{
  for(const decimal of ['149.626','149.63']){const log=new NativeProfileLog();log.push(checkpointStartup);const created=createdCheckpoint.replace('149.626',decimal);log.push(created.slice(0,75));log.push(created.slice(75));assert(log.checkpointBoundsValid(checkpointProfile,true));log.push(restoredCheckpoint.replace('149.626',decimal));assert(log.matches(checkpointProfile,checkpointPlacement));}
  for(const bad of [createdCheckpoint.replace('1 of 1','2 of 1'),createdCheckpoint.replace('1 of 1','1 of 2'),createdCheckpoint.replace('id  0','id  1'),createdCheckpoint.replace('task 653','task -1'),createdCheckpoint.replace('149.626','160.000'),createdCheckpoint.replace('149.626','149.627'),createdCheckpoint.replace('149.626','149..626'),createdCheckpoint.replace('5200','99999999999999999999'),restoredCheckpoint.replace('n_past = 5200','n_past = 0'),restoredCheckpoint.replace('n_past = 5200','n_past = 5201')]){const log=new NativeProfileLog();log.push(checkpointStartup+createdCheckpoint);assert(log.checkpointBoundsValid(checkpointProfile,true));log.push(bad);assert.equal(log.checkpointBoundsValid(checkpointProfile,true),false,bad);}
  const unwitnessed=new NativeProfileLog();unwitnessed.push(checkpointStartup+restoredCheckpoint);assert.equal(unwitnessed.checkpointBoundsValid(checkpointProfile),false);
  const conflict=new NativeProfileLog();conflict.push(checkpointStartup+createdCheckpoint+'llama_context: n_rs_seq = 1\n');assert.equal(conflict.checkpointBoundsValid(checkpointProfile),false);
  for(const scalar of ['llama_context: n_rs_seq = -1\n','llama_context: n_rs_seq = NaN\n','llama_context: n_seq_max = one\n']){const log=new NativeProfileLog();log.push(checkpointStartup+createdCheckpoint+scalar);assert.equal(log.checkpointBoundsValid(checkpointProfile),false);}
  for(const stale of [restoredCheckpoint.replaceAll('5199','5100'),restoredCheckpoint.replaceAll('5200','5101')]){const log=new NativeProfileLog();log.push(checkpointStartup+createdCheckpoint+stale);assert.equal(log.checkpointBoundsValid(checkpointProfile),false);}
  const erased=new NativeProfileLog();erased.push(checkpointStartup+createdCheckpoint+'slot update_slots: id  0 | task 766 | erased invalidated context checkpoint (pos_min = 5199, pos_max = 5199, n_tokens = 5200, n_swa = 0, pos_next = 0, size = 149.626 MiB)\n'+restoredCheckpoint);assert.equal(erased.checkpointBoundsValid(checkpointProfile),false);
  for(const clear of ['slot prompt_clear: id  0 | task -1 | clearing prompt with 5314 tokens\n','slot create_check: id  0 | task 766 | superseding context checkpoint at n_tokens = 5200\n']){const log=new NativeProfileLog();log.push(checkpointStartup+createdCheckpoint+clear+restoredCheckpoint);assert.equal(log.checkpointBoundsValid(checkpointProfile),false);}
});

test('native allocation accounting separates mmap GPU span, nonmapped workspace and one unified weight copy',()=>{
  const p=parseNativeMemoryPlan('log heading\nMTL0 15088 1173 80 \nHost 682 0 3 \n',binding);
  assert.equal(p.noAlloc,true);assert.equal(p.modelPayloadAllocatedBytes,0);
  assert.equal(p.rows[0].modelBytes,15089*1024**2);assert.equal(p.mappedWeightsUpperBoundBytes,binding.artifactBytes);
  assert.equal(p.workingBytes,binding.artifactBytes+p.workspaceBytes);assert(p.gpuAllocationUpperBoundBytes<17.759*GIB);assert(p.workingBytes<19.2*GIB);
  assert(p.workingBytes>hardware.availableMemoryBytes,'cold mmap calibration does not equate current reclaimable cache with the complete resident working set');
  assert.doesNotThrow(()=>assertNativeMemoryAdmission(p,hardware,sample));
  for(const unsafe of [{...sample,pressure:'warning' as const},{...sample,availableMemoryBytes:p.workspaceBytes+4.8*GIB-1}])assert.throws(()=>assertNativeMemoryAdmission(p,hardware,unsafe),{code:'INSUFFICIENT_MEMORY'});
  assert.throws(()=>assertNativeMemoryAdmission(p,{...hardware,gpus:[{...hardware.gpus[0],freeMemoryBytes:16*GIB}]},sample),{code:'INSUFFICIENT_MEMORY'});
});

test('Q3 existing-slot cache policy changes proof identity without adding planned buffers or changing Q4 identities',()=>{
  for(const [q4,q3] of [['qwen3.8:27b','qwen3.8:27b-q3-k-m'],['muse-glimmer:30b','muse-glimmer:30b-q3-k-m']]){
    const policy=generationPolicyForModel(q3),{codingPromptCache,...historicalPolicy}=policy;
    assert.equal(codingPromptCache,true);
    const historical=inferenceProfileSignature({...profile,generationPolicy:historicalPolicy},'low-memory');
    const current=inferenceProfileSignature({...profile,generationPolicy:policy},'low-memory');
    assert.notEqual(current,historical,'historical cache-disabled probe and task proofs must not bind');
    assert.equal(JSON.parse(current).generationPolicy.codingPromptCache,true);
    assert.equal(inferenceProfileSignature({...profile,generationPolicy:generationPolicyForModel(q4)},'low-memory'),historical);
    const output='MTL0 15088 1173 80\nHost 682 0 3';
    const oldPlan=parseNativeMemoryPlan(output,{...binding,model:q3,profileSignature:historical});
    const newPlan=parseNativeMemoryPlan(output,{...binding,model:q3,profileSignature:current});
    assert.notEqual(newPlan.profileSignature,oldPlan.profileSignature);
    assert.deepEqual(newPlan.rows,oldPlan.rows);
    assert.equal(newPlan.workspaceBytes,oldPlan.workspaceBytes);
    assert.equal(newPlan.workingBytes,oldPlan.workingBytes);
    assert.equal(newPlan.gpuAllocationUpperBoundBytes,oldPlan.gpuAllocationUpperBoundBytes);
  }
});

test('native plans reject wrong binary identities, duplicate, incomplete or unexpected device rows',()=>{
  for(const output of ['MTL0 15088 1173 80','MTL0 15088 1173 80\nHost 682 0 3\nHost 682 0 3','MTL0 0 0 0\nHost 682 0 3','MTL0 15088 1173 80\nHost 682 0 3\nMTL1 1 1 1','MTL0 9999999999999999999 1173 80\nHost 682 0 3'])assert.throws(()=>parseNativeMemoryPlan(output,binding),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.throws(()=>parseNativeMemoryPlan('MTL0 15088 1173 80\nHost 682 0 3',{...binding,plannerDigest:'d'.repeat(64)}),{code:'MODEL_MEMORY_PLAN_INVALID'});
});

test('precision and flash attention bind profile identity and actual initialization evidence',()=>{
  const log=new NativeProfileLog();log.push('llama_context: flash_attn = enabled\nllama_kv_cache: K (f16): 1.00 MiB, V (');log.push('f16): 1.00 MiB\n');assert(log.matches(profile));assert(!log.matches({...profile,cacheTypeV:'q8_0'}));
  log.push('llama_kv_cache: K (q8_0): 1.00 MiB, V (q8_0): 1.00 MiB\n');assert(!log.matches(profile));
  const disabled=new NativeProfileLog();disabled.push('llama_context: flash_attn = enabled\nllama_kv_cache: K (f16): 1.00 MiB, V (f16): 1.00 MiB\nFlash Attention not supported, set to disabled\n');assert(!disabled.matches(profile));
  assert.notEqual(inferenceProfileSignature(profile,'automatic'),inferenceProfileSignature({...profile,cacheTypeK:'q8_0',cacheTypeV:'q8_0'},'automatic'));
});

test('pinned11429 INFO startup formats confirm Q8 while healthy slot messages alone prove no KV or FA setting',()=>{
  const q8={...profile,cacheTypeK:'q8_0' as const,cacheTypeV:'q8_0' as const};const logs=new NativeProfileLog();
  logs.push("0.02.718.034 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 16384, kv_unified = 'false'\n");assert.equal(logs.matches(q8),false);
  // Format strings from pinned src/llama-context.cpp338 and llama-kv-cache.cpp301.
  // This is a source-format fixture, not an assertion of real model inference.
  logs.push('0.02.700.001 I llama_context: flash_attn            = enabled\nllama_kv_cache: size =  544.00 MiB ( 16384 cells,  16 layers,  1/1 seqs), K (q8_0):  272.00 MiB, V (');
  logs.push('q8_0):  272.00 MiB\n');assert.equal(logs.matches(q8),true);assert.equal(logs.matches(profile),false);
});

test('partial native placement includes the skipped MTP slot and output position in mapped spans',()=>{
  const mixed:NativeMemoryProfile={...profile,cacheTypeK:'q8_0',cacheTypeV:'q8_0',nativePlacement:{gpuLayers:64,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true}};
  const tensors=[{name:'output.weight',dimensions:[8],offset:0,bytes:1024**2},{name:'output_norm.weight',dimensions:[8],offset:1024**2,bytes:32},{name:'token_embd.weight',dimensions:[8],offset:1024**2+32,bytes:1024**2},...Array.from({length:65},(_,i)=>({name:`blk.${i}.attn_norm.weight`,dimensions:[8],offset:2*1024**2+32+i*1024**2,bytes:1024**2}))];
  const metadata={architecture:'qwen35',blockCount:65,tensors} as GGUFMetadata;
  const placement=nativeMappedPlacement(metadata,mixed)!;
  assert.equal(placement.totalLayers,66);assert.equal(placement.gpuLayers,64);assert.equal(placement.hostMappedBytes,4*1024**2+32);assert.equal(placement.metalMappedBytes,62*1024**2);assert.equal(placement.metalTensorBytes,62*1024**2);
  const args=nativePlacementArguments(mixed);assert.deepEqual(args,['--n-gpu-layers','64','--no-repack','--threads','4','--threads-batch','4','--override-tensor','^output(?:_norm)?\\.weight$=CPU']);
  assert.throws(()=>nativePlacementArguments({...mixed,nativePlacement:{...mixed.nativePlacement!,cpuBlockIndices:Array.from({length:33},(_,i)=>i)}}),{code:'MODEL_PROFILE_MISMATCH'});
  assert.throws(()=>nativePlacementArguments({...mixed,nativePlacement:{...mixed.nativePlacement!,cpuBlockIndices:[1,1]}}),{code:'MODEL_PROFILE_MISMATCH'});
  for(const changed of [{gpuLayers:63},{outputOnCPU:false}])assert.throws(()=>nativeMappedPlacement(metadata,{...mixed,nativePlacement:{...mixed.nativePlacement!,...changed}}),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.notEqual(inferenceProfileSignature(mixed,'low-memory'),inferenceProfileSignature({...mixed,nativePlacement:{...mixed.nativePlacement!,gpuLayers:63}},'low-memory'));
  const planned=parseNativeMemoryPlan('MTL0 62 1 1\nHost 4 0 1',{...binding,artifactBytes:70*1024**2,profileSignature:inferenceProfileSignature(mixed,'low-memory'),mappedPlacement:placement});assert.equal(planned.mappedWeightsUpperBoundBytes,70*1024**2);assert.equal(planned.workingBytes,70*1024**2+planned.workspaceBytes);
  assert.throws(()=>parseNativeMemoryPlan('MTL0 60 1 1\nHost 4 0 1',{...binding,artifactBytes:70*1024**2,mappedPlacement:placement}),{code:'MODEL_MEMORY_PLAN_INVALID'});
});

test('partial placement readiness requires actual mapped spans and threads, not only reported offloaded layers',()=>{
  const mixed:NativeMemoryProfile={...profile,cacheTypeK:'q8_0',cacheTypeV:'q8_0',nativePlacement:{gpuLayers:64,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true}};
  const placement={gpuLayers:64,totalLayers:66,metalMappedBytes:62*1024**2,hostMappedBytes:4*1024**2,metalTensorBytes:62*1024**2,hostTensorBytes:4*1024**2};
  const evidence='system_info: n_threads = 4 (n_threads_batch = 4) / 10\nload_tensors: offloaded 64/66 layers to GPU\nload_tensors: MTL0_Mapped model buffer size = 62.00 MiB\nload_tensors: CPU_Mapped model buffer size = 4.00 MiB\nllama_context: flash_attn = enabled\nllama_kv_cache: K (q8_0): 1.00 MiB, V (q8_0): 1.00 MiB\n';
  const logs=new NativeProfileLog();logs.push(evidence.slice(0,143));logs.push(evidence.slice(143));assert(logs.matches(mixed,placement));assert(!logs.matches(mixed));
  for(const bad of [evidence.replace('62.00','64.00'),evidence.replace('CPU_Mapped','CPU_REPACK'),evidence.replace('n_threads = 4','n_threads = 8'),evidence.replace('64/66','63/66'),evidence+'load_tensors: CPU_REPACK model buffer size = 4.00 MiB\n']){const invalid=new NativeProfileLog();invalid.push(bad);assert.equal(invalid.matches(mixed,placement),false);}
});

test('Qwen Q3 CPU prefix excludes MTP, shrinks the Metal span and invalidates its historical placement',()=>{
  const mib=1024**2,tensors=[{name:'output.weight',dimensions:[8],offset:0,bytes:mib},{name:'output_norm.weight',dimensions:[8],offset:mib,bytes:32},{name:'token_embd.weight',dimensions:[8],offset:mib+32,bytes:mib},...Array.from({length:65},(_,i)=>({name:`blk.${i}.attn_norm.weight`,dimensions:[8],offset:2*mib+32+i*mib,bytes:mib}))];
  const metadata={architecture:'qwen35',blockCount:65,tensors} as GGUFMetadata;
  const p:NativeMemoryProfile={...profile,batchTokens:128,microBatchTokens:32,cacheTypeK:'q8_0',cacheTypeV:'q8_0',metalResidency:'disabled',generationPolicy:generationPolicyForModel('qwen3.8:27b-q3-k-m'),nativePlacement:{gpuLayers:42,decodeThreads:4,batchThreads:4,repack:false,outputOnCPU:true,outputNormOnCPU:true}};
  const placement=nativeMappedPlacement(metadata,p,'qwen3.8:27b-q3-k-m')!;
  assert.equal(placement.gpuLayers,42);assert.equal(placement.totalLayers,66);assert.equal(placement.metalMappedBytes,40*mib);assert.equal(placement.hostMappedBytes,26*mib+32);assert.equal(placement.metalTensorBytes,40*mib);assert.equal(placement.hostTensorBytes,26*mib+32);
  const historical={...p,batchTokens:64,microBatchTokens:16,nativePlacement:{...p.nativePlacement!,gpuLayers:64,outputNormOnCPU:undefined}};
  assert.notEqual(inferenceProfileSignature(p,'low-memory'),inferenceProfileSignature(historical,'low-memory'));
  assert.throws(()=>nativeMappedPlacement(metadata,historical,'qwen3.8:27b-q3-k-m'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.doesNotThrow(()=>nativeMappedPlacement(metadata,historical,'qwen3.8:27b'));
  assert.throws(()=>nativeMappedPlacement(metadata,p,'qwen3.8:27b'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  for(const bad of [{...p,batchTokens:64},{...p,nativePlacement:{...p.nativePlacement!,gpuLayers:41}},{...p,nativePlacement:{...p.nativePlacement!,outputNormOnCPU:false}}])assert.throws(()=>nativeMappedPlacement(metadata,bad,'qwen3.8:27b-q3-k-m'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  const args=nativePlacementArguments(p);assert.equal(args[1],'42');assert.equal(args.at(-1),'^output(?:_norm)?\\.weight$=CPU');
  assert.deepEqual(nativeEnvironmentOverrides(p),{GGML_METAL_NO_RESIDENCY:'1'});
  for(const bad of [{...p,generationPolicy:generationPolicyForModel('qwen3.8:27b')},{...p,microBatchTokens:16},{...p,nativePlacement:{...p.nativePlacement!,gpuLayers:64}},{...p,nativePlacement:{...p.nativePlacement!,outputNormOnCPU:false}}])assert.throws(()=>nativeEnvironmentOverrides(bad),{code:'MODEL_PROFILE_MISMATCH'});
  const planned=parseNativeMemoryPlan('MTL0 40 1 1\nHost 26 0 1',{...binding,model:'qwen3.8:27b-q3-k-m',artifactBytes:70*mib,profileSignature:inferenceProfileSignature(p,'low-memory'),mappedPlacement:placement,metalResidency:'disabled'});
  assert.equal(planned.workingBytes,70*mib+planned.workspaceBytes);
  assert.throws(()=>parseNativeMemoryPlan('MTL0 62 1 1\nHost 4 0 1',{...binding,model:'qwen3.8:27b-q3-k-m',artifactBytes:70*mib,profileSignature:inferenceProfileSignature(p,'low-memory'),mappedPlacement:placement,metalResidency:'disabled'}),{code:'MODEL_MEMORY_PLAN_INVALID'});
});

test('engine-local residency setting binds environment, plan identity and exact startup evidence',()=>{
  const disabled:NativeMemoryProfile={...profile,cacheTypeK:'q8_0',cacheTypeV:'q8_0',metalResidency:'disabled'};
  assert.deepEqual(nativeEnvironmentOverrides(profile),{});assert.deepEqual(nativeEnvironmentOverrides(disabled),{GGML_METAL_NO_RESIDENCY:'1'});
  assert.throws(()=>nativeEnvironmentOverrides({...disabled,backend:'cpu'}),{code:'MODEL_PROFILE_MISMATCH'});
  const signature=inferenceProfileSignature(disabled,'low-memory');assert.notEqual(signature,inferenceProfileSignature({...disabled,metalResidency:undefined},'low-memory'));
  const p=parseNativeMemoryPlan('MTL0 15088 693 80\nHost 682 0 4',{...binding,profileSignature:signature,metalResidency:'disabled'});assert.equal(p.metalResidency,'disabled');
  assert.throws(()=>parseNativeMemoryPlan('MTL0 15088 693 80\nHost 682 0 4',{...binding,profileSignature:signature}),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.throws(()=>parseNativeMemoryPlan('MTL0 15088 693 80\nHost 682 0 4',{...binding,metalResidency:'disabled'}),{code:'MODEL_MEMORY_PLAN_INVALID'});
  const native='llama_context: flash_attn = enabled\nllama_kv_cache: K (q8_0): 1.00 MiB, V (q8_0): 1.00 MiB\n';
  const confirmed=new NativeProfileLog();confirmed.push(native+'ggml_metal_device_init: use residency sets    = false\n');assert(confirmed.matches(disabled));
  for(const state of ['', 'ggml_metal_device_init: use residency sets = true\n','ggml_metal_device_init: use residency sets = false-ish\n','ggml_metal_device_init: use residency sets = false\nggml_metal_device_init: use residency sets = true\n']){const invalid=new NativeProfileLog();invalid.push(native+state);assert.equal(invalid.matches(disabled),false);}
});

test('Muse Q3 derives complete physical blocks and binds their exact indices without changing Q4 geometry',()=>{
  const first=[5,8,1,20,31,3,0,42,17,11,2,4,6,7,9,10,12,13,14,15],order=[...first,...Array.from({length:52},(_,i)=>i).filter(i=>!first.includes(i))];let offset=32;
  const tensors=[{name:'token_embd.weight',dimensions:[8],offset:0,bytes:32},...order.flatMap(index=>['attn_norm.weight','ffn_norm.weight'].map(suffix=>{const tensor={name:`blk.${index}.${suffix}`,dimensions:[8],offset,bytes:32};offset+=32;return tensor;})),{name:'output.weight',dimensions:[8],offset,bytes:32},{name:'output_norm.weight',dimensions:[8],offset:offset+32,bytes:32}];
  const metadata={architecture:'muse-glimmer',blockCount:52,tensors} as GGUFMetadata;assert.deepEqual(museQ3PhysicalCPUBlocks(metadata),first);
  const p:NativeMemoryProfile={...profile,batchTokens:128,microBatchTokens:32,generationPolicy:generationPolicyForModel('muse-glimmer:30b-q3-k-m'),cacheTypeK:'q8_0',cacheTypeV:'q8_0',metalResidency:'disabled',nativePlacement:{gpuLayers:999,decodeThreads:4,batchThreads:4,repack:false,...museQ3CPUPlacement(metadata)}};
  assert.deepEqual(nativeEnvironmentOverrides(p),{GGML_METAL_NO_RESIDENCY:'1'});assert.throws(()=>nativeEnvironmentOverrides({...p,nativePlacement:{...p.nativePlacement!,cpuBlockIndices:first.slice(0,10)}}),{code:'MODEL_PROFILE_MISMATCH'});const placement=nativeMappedPlacement(metadata,p,'muse-glimmer:30b-q3-k-m')!;assert.deepEqual(placement.cpuBlockIndices,first);assert.equal(placement.hostMappedBytes,32+20*64);assert.equal(placement.metalMappedBytes,32*64+64);assert(nativePlacementArguments(p).includes('^blk\\.(?:5|8|1|20|31|3|0|42|17|11|2|4|6|7|9|10|12|13|14|15)\\.=CPU'));
  const oldProfile={...p,nativePlacement:{...p.nativePlacement!,cpuBlockIndices:first.slice(0,10)}};
  assert.notEqual(inferenceProfileSignature(p,'low-memory'),inferenceProfileSignature(oldProfile,'low-memory'));
  assert.throws(()=>nativeMappedPlacement(metadata,oldProfile,'muse-glimmer:30b-q3-k-m'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.throws(()=>nativeMappedPlacement(metadata,p,'muse-glimmer:30b'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.throws(()=>nativeMappedPlacement(metadata,{...p,nativePlacement:{...p.nativePlacement!,cpuBlockIndices:[...first].reverse()}},'muse-glimmer:30b-q3-k-m'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  assert.throws(()=>nativeMappedPlacement(metadata,p,'qwen3.8:27b-q3-k-m'),{code:'MODEL_MEMORY_PLAN_INVALID'});
  const headFirst={...metadata,tensors:[{name:'output.weight',dimensions:[8],offset:0,bytes:32},...tensors.filter(t=>t.name!=='output.weight').map(t=>({...t,offset:t.offset+32}))]};
  const derivedHead=museQ3CPUPlacement(headFirst);assert.equal(derivedHead.outputOnCPU,true);assert.equal(derivedHead.outputNormOnCPU,false);
  const headProfile={...p,nativePlacement:{...p.nativePlacement!,...derivedHead}};assert(nativePlacementArguments(headProfile).includes('^output\\.weight$=CPU,^blk\\.(?:5|8|1|20|31|3|0|42|17|11|2|4|6|7|9|10|12|13|14|15)\\.=CPU'));
  const headPlacement=nativeMappedPlacement(headFirst,headProfile,'muse-glimmer:30b-q3-k-m')!;assert.equal(headPlacement.outputOnCPU,true);assert.equal(headPlacement.outputNormOnCPU,false);assert.equal(headPlacement.hostMappedBytes,32+32+20*64);
  for(const invalid of [{...metadata,blockCount:53},{...metadata,tensors:tensors.filter(t=>!t.name.startsWith('blk.51.'))}])assert.throws(()=>museQ3PhysicalCPUBlocks(invalid),{code:'MODEL_MEMORY_PLAN_INVALID'});
  const interleaved=tensors.map(t=>t.name==='blk.5.ffn_norm.weight'?{...t,offset:32+3*64}:t);assert.throws(()=>museQ3PhysicalCPUBlocks({...metadata,tensors:interleaved}),{code:'MODEL_MEMORY_PLAN_INVALID'});
});

test('Muse Q3 twenty-block startup rejects historical mapped spans and requires the exact batch shape',()=>{
  // Header-derived spans from the complete pinned Q3 artifact. INFO is a parser
  // fixture; native memory, speed and coding qualification remain separate.
  const p:NativeMemoryProfile={...profile,batchTokens:128,microBatchTokens:32,generationPolicy:generationPolicyForModel('muse-glimmer:30b-q3-k-m'),cacheTypeK:'q8_0',cacheTypeV:'q8_0',metalResidency:'disabled',nativePlacement:{gpuLayers:999,decodeThreads:4,batchThreads:4,repack:false,cpuBlockIndices:Array.from({length:20},(_,i)=>i),outputOnCPU:true,outputNormOnCPU:true}};
  const placement={gpuLayers:53,totalLayers:53,metalMappedBytes:7519076352,hostMappedBytes:6430328832,metalTensorBytes:7519076352,hostTensorBytes:6430328832};
  const scalar='llama_context: n_seq_max = 1\nllama_context: n_ctx = 16384\nllama_context: n_ctx_seq = 16384\nllama_context: n_batch = 128\nllama_context: n_ubatch = 32\n';
  const native='ggml_metal_device_init: use residency sets = false\nsystem_info: n_threads = 4 (n_threads_batch = 4) / 10\nload_tensors: offloaded 53/53 layers to GPU\nload_tensors: MTL0_Mapped model buffer size = 7170.75 MiB\nload_tensors: CPU_Mapped model buffer size = 6132.44 MiB\nllama_context: flash_attn = enabled\nllama_kv_cache: K (q8_0): 55.25 MiB, V (q8_0): 55.25 MiB\n';
  const current=new NativeProfileLog();current.push(scalar+native);assert.equal(current.matches(p,placement),true);
  for(const invalid of [native,scalar.replace('n_batch = 128','n_batch = 64')+native,scalar.replace('n_ubatch = 32','n_ubatch = 16')+native,scalar.replace('n_seq_max = 1','n_seq_max = 2')+native,scalar.replace('n_ctx_seq = 16384','n_ctx_seq = 8192')+native,scalar+native+'llama_context: n_batch = 64\n',scalar+native.replace('7170.75','9390.89').replace('6132.44','3912.30')]){const old=new NativeProfileLog();old.push(invalid);assert.equal(old.matches(p,placement),false);}
});

test('Muse Q3 tail embedding permits overlapping mmap views without moving a late head or counting weights twice',()=>{
  const mib=1024**2,names=[...Array.from({length:52},(_,i)=>[`blk.${i}.attn_norm.weight`,`blk.${i}.ffn_norm.weight`]).flat(),'output.weight','output_norm.weight','token_embd.weight'];
  const metadata={architecture:'muse-glimmer',blockCount:52,tensors:names.map((name,index)=>({name,dimensions:[262144],offset:index*mib,bytes:mib}))} as GGUFMetadata;
  const derived=museQ3CPUPlacement(metadata);assert.deepEqual(derived.cpuBlockIndices,Array.from({length:20},(_,i)=>i));assert.equal(derived.outputOnCPU,false);assert.equal(derived.outputNormOnCPU,false);
  const p:NativeMemoryProfile={...profile,batchTokens:128,microBatchTokens:32,generationPolicy:generationPolicyForModel('muse-glimmer:30b-q3-k-m'),cacheTypeK:'q8_0',cacheTypeV:'q8_0',metalResidency:'disabled',nativePlacement:{gpuLayers:999,decodeThreads:4,batchThreads:4,repack:false,...derived}};
  const placement=nativeMappedPlacement(metadata,p,'muse-glimmer:30b-q3-k-m')!;assert.equal(placement.hostMappedBytes,107*mib);assert.equal(placement.metalMappedBytes,66*mib);assert.equal(placement.hostTensorBytes,41*mib);assert.equal(placement.metalTensorBytes,66*mib);
  const planned=parseNativeMemoryPlan('MTL0 66 1 1\nHost 41 0 1',{...binding,model:'muse-glimmer:30b-q3-k-m',profileSignature:inferenceProfileSignature(p,'automatic'),artifactBytes:107*mib,mappedPlacement:placement,metalResidency:'disabled'});
  assert.equal(planned.mappedWeightsUpperBoundBytes,109*mib,'only the complete artifact/native unique tensor estimate bounds physical weights, with native row rounding');
  assert(planned.mappedWeightsUpperBoundBytes<placement.hostMappedBytes+placement.metalMappedBytes);assert.equal(planned.workingBytes,planned.mappedWeightsUpperBoundBytes+planned.workspaceBytes);
});

test('reclaimable cache counts active file-backed pages once and excludes occupied anonymous pages',()=>{
  const vm='Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages active: 9000.\nPages inactive: 8000.\nPages speculative: 100.\nPages purgeable: 50.\nFile-backed pages: 1000.';
  assert.equal(parseMacAvailableMemory(vm),1010*16384);assert.equal(parseMacAvailableMemory(vm.replace('Pages purgeable: 50.','Pages purgeable: 2000.')),2010*16384);
  assert.equal(parseMacAvailableMemory(vm.replace('\nFile-backed pages: 1000.','')),160*16384);
});

test('native telemetry rejects non-owned PIDs, stale or missing footprint and avoids RSS double counting',()=>{
  const s={schemaVersion:1,helperIdentity:'free-local-agent-resource-v1',pid:123,parentPid:456,rssBytes:100,physicalFootprintBytes:150,sampledAtMilliseconds:Date.now()};
  assert.equal(parseNativeResourceSample(JSON.stringify(s),123,456).residentBytes,150);
  for(const change of [{pid:124},{parentPid:457},{physicalFootprintBytes:0},{rssBytes:-1},{sampledAtMilliseconds:Date.now()-10000}])assert.throws(()=>parseNativeResourceSample(JSON.stringify({...s,...change}),123,456),{code:'RESOURCE_MONITOR_UNAVAILABLE'});
});

test('native sampler accepts only a same-UID direct child of its calling runtime', {skip:process.platform!=='darwin'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'agent-native-memory-'));t.after(()=>rm(directory,{recursive:true,force:true}));const executable=path.join(directory,'sample');
  await promisify(execFile)('/usr/bin/clang',['-O2','-std=c11','-Wall','-Wextra',fileURLToPath(new URL('../native/resource-sample.c',import.meta.url)),'-o',executable],{timeout:30000});
  const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>{owned.kill();});await new Promise<void>((resolve,reject)=>{owned.once('spawn',resolve);owned.once('error',reject);});
  const result=await promisify(execFile)(executable,['--pid',String(owned.pid)],{timeout:2000});const metrics=parseNativeResourceSample(result.stdout,owned.pid!,process.pid);assert(metrics.residentBytes>0);assert(metrics.physicalFootprintBytes!>0);
  for(const pid of ['0','-1','1x',String(process.pid)])await assert.rejects(promisify(execFile)(executable,['--pid',pid],{timeout:2000}));
});

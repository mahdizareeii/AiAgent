import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EngineMemoryLog,experimentalResidentBudget,validResourceMeasurements,validateSSDNumericalProof,PINNED_ENGINE_COMMIT,type SSDNumericalConfiguration} from '../memory.ts';
import {GIB,type HardwareInfo} from '../hardware.ts';

test('experimental residency budgets count unified RAM once and reserve current headroom',()=>{
  const hardware:HardwareInfo={platform:'darwin',architecture:'arm64',cpuModel:'M5',cpuCores:10,totalMemoryBytes:24*GIB,availableMemoryBytes:6*GIB,freeDiskBytes:null,gpus:[{name:'M5',backend:'metal',totalMemoryBytes:24*GIB,freeMemoryBytes:20*GIB,unifiedMemory:true}]};
  assert.equal(experimentalResidentBudget(hardware),5*GIB);
  assert.equal(experimentalResidentBudget({...hardware,availableMemoryBytes:24*GIB}),19.2*GIB);
  assert.equal(experimentalResidentBudget({...hardware,availableMemoryBytes:512*1024**2}),0);
});

test('engine measurements distinguish mapped buffers and architecture-marked lazy tensors across chunk boundaries',()=>{
  const metrics=new EngineMemoryLog();assert.deepEqual(metrics.values(),{mappedBytes:null,lazyEligibleBytes:null});
  metrics.push('load_tensors: CPU_Mapped model buffer size = 100.00 MiB\nload_tensors: CPU_Mapped model buffer size = 3.50 MiB\n');
  metrics.push('llama_model_loader: tensor per_layer_token_embd.weight (size = 16 MiB) lazy read en');
  metrics.push('abled\nllama_model_loader: tensor per_layer_token_embd.weight (size = 16 MiB) lazy read enabled\n');
  assert.deepEqual(metrics.values(true),{mappedBytes:103.5*1024**2,lazyEligibleBytes:16*1024**2});
  assert.deepEqual(new EngineMemoryLog().values(true),{mappedBytes:null,lazyEligibleBytes:0});
});

test('resource monitoring rejects missing, malformed and negative measurements',()=>{
  const sample={sampledAt:new Date().toISOString(),residentBytes:123,availableMemoryBytes:456,pressure:'normal' as const};
  assert(validResourceMeasurements(sample));assert(!validResourceMeasurements({...sample,residentBytes:-1}));assert(!validResourceMeasurements({...sample,availableMemoryBytes:NaN}));assert(!validResourceMeasurements({...sample,sampledAt:'unavailable'}));
});


test('numerical certificate scope and profile cannot be substituted by Chat results or another model',()=>{
  const configuration:SSDNumericalConfiguration={baseCommit:PINNED_ENGINE_COMMIT,modelSha256:'a'.repeat(64),templateSha256:'b'.repeat(64),architecture:'gemma4',backend:'cpu',cpuKernel:'standard',useExtraBufts:false,cpuRepackTensorCount:0,workerPatchSha256:'c'.repeat(64),report:'validation/gemma-cpu.json',reportSha256:'d'.repeat(64),scope:'representative-experts-and-two-swa-layers',profile:{contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,cacheSlotsPerLayer:24,cacheTypeK:'f16',cacheTypeV:'f16',swaFull:false,slots:1,ioWorkers:2,ioMode:'darwin-nocache',decodeThreads:4,batchThreads:4}};
  const report={...configuration,schemaVersion:1,passed:true};assert(validateSSDNumericalProof(report,configuration,configuration.workerPatchSha256));
  for(const change of [{passed:false},{modelSha256:'e'.repeat(64)},{templateSha256:'e'.repeat(64)},{workerPatchSha256:'e'.repeat(64)},{baseCommit:'e'.repeat(40)},{architecture:'qwen3next'},{backend:'metal'},{cpuKernel:'default'},{useExtraBufts:true},{cpuRepackTensorCount:1},{scope:'chat-and-tools-passed'},{profile:{...configuration.profile,batchThreads:8}},{profile:{...configuration.profile,cacheTypeK:'q8_0'}}])assert.equal(validateSSDNumericalProof({...report,...change},configuration,configuration.workerPatchSha256),false);
  assert.equal(validateSSDNumericalProof({...report,architecture:'qwen3next'}, {...configuration,architecture:'qwen3next'},configuration.workerPatchSha256),false,'A Gemma scoped certificate does not enable the Qwen worker.');
  assert.equal(validateSSDNumericalProof(report,{...configuration,report:'../outside.json'},configuration.workerPatchSha256),false);
});

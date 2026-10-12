import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EngineMemoryLog,experimentalResidentBudget,validResourceMeasurements} from '../memory.ts';
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

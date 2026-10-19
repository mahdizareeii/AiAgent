import { exactQwen80Source, isQwen80NumericalReport, QWEN80_SSD_COMPUTATION, type SSDNumericalNativeBinding } from './ssd-contract.ts';
import type { CuratedModel } from './catalog.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIB, operatingSystemReserve, parseMacAvailableMemory, type HardwareInfo } from './hardware.ts';
import type {FixedProbeDiagnostic} from './probes.ts';
import { RuntimeError } from './errors.ts';
import {modelGenerationOptions,type ModelGenerationPolicy} from './generation.ts';
import type {GGUFMetadata} from './gguf.ts';
import { probePlatformMemory } from './platform-memory.ts';

export type MemoryMode = 'automatic' | 'low-memory' | 'experimental-disk' | 'ssd-experts';
export interface ResourceMeasurements {
  sampledAt: string;
  residentBytes: number;
  /** Physical footprint and RSS overlap. Never sum them. */
  physicalFootprintBytes?: number | null;
  rssBytes?: number;
  availableMemoryBytes: number;
  pressure: 'normal' | 'warning' | 'critical';
  /** Platform-specific diagnostics. Commit/swap are never physical footprint. */
  privateCommitBytes?: number;
  swapBytes?: number;
  monitor?: { platform:'linux'|'win32';source:string;pressureSource:string;pid:number|null;parentPid:number|null; };
}
export interface ExperimentalTrial {
  probes?:{chat?:FixedProbeDiagnostic;tools?:FixedProbeDiagnostic};
  progress?:{stage:'verifying'|'planning'|'loading'|'probing';message?:string;completedBytes?:number;totalBytes?:number};
  id: string;
  mode?:MemoryMode;
  backendValidation?:'cpu-baseline'|'validated'|'qa-unvalidated';
  /** Integrity-covered numerical certificate, distinct from local Chat/tool/task checks. */
  parityReportDigest?:string;
  model: string;
  digest: string | null;
  state: 'loading' | 'calibrating' | 'passed' | 'failed' | 'cancelled' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  profileSignature: string;
  probePassed: boolean;
  toolProbePassed: boolean;
  error: { code: string; message: string } | null;
  resourceBudgetBytes: number | null;
  /** Rounded engine-reported mmap buffer size, never resident memory. Null means unmeasured. */
  mappedBytes: number | null;
  /** Rounded sizes of architecture-marked tensors the engine actually enabled for lazy reads. */
  lazyEligibleBytes: number | null;
  measurements: ResourceMeasurements | null;
  artifactSetDigest?:string; templateDigest?:string;engineDigest?:string;patchDigest?:string;
  allocationBudgetBytes?:number;streaming?:SSDStreamingStatus|null;memoryPlan?:SSDResourcePlan|null;
}
export const PINNED_ENGINE_COMMIT = 'd81235049384534c167caea52b85a694f6103d14';
export const PORTABLE_CPU_ARGUMENTS = Object.freeze(['--device', 'none', '--n-gpu-layers', '0', '--no-op-offload', '--no-repack', '--threads', '4', '--threads-batch', '4'] as const);
export interface NativeWeightPlacement {gpuLayers:number;decodeThreads:4;batchThreads:4;repack:false;outputOnCPU:boolean;outputNormOnCPU?:boolean;cpuBlockIndices?:readonly number[];}
export interface NativeMappedPlacement {gpuLayers:number;totalLayers:number;metalMappedBytes:number;hostMappedBytes:number;metalTensorBytes:number;hostTensorBytes:number;cpuBlockIndices?:readonly number[];outputOnCPU?:boolean;outputNormOnCPU?:boolean;}
/** One host checkpoint for the pinned Qwen Q3 recurrent layout. The reserve
 * covers two serialized copies without adding GPU rollback planes. */
export const QWEN_Q3_CHECKPOINT_POLICY=Object.freeze({maxCheckpoints:1,minimumStepTokens:8192,serializedStateUpperBoundBytes:156894364,maximumSerializedBuffers:2,hostReserveBytes:320*1024**2,recurrentPayloadBytes:156893184,recurrentRBytes:5898240,recurrentSBytes:150994944,cells:1,layers:64,sequences:1,rollbackSequences:0} as const);
export type NativeCheckpointPolicy=typeof QWEN_Q3_CHECKPOINT_POLICY;
export interface NativeMemoryProfile {backend:string;contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number;cacheTypeK?:'f16'|'q8_0';cacheTypeV?:'f16'|'q8_0';flashAttention?:'on';generationPolicy?:ModelGenerationPolicy;nativePlacement?:NativeWeightPlacement;metalResidency?:'disabled';recurrentCheckpoint?:NativeCheckpointPolicy;portableCPUArguments?:readonly string[];}
export function assertNativeCheckpointProfile(profile:NativeMemoryProfile,modelId?:string):void{
  const c=profile.recurrentCheckpoint;if(c===undefined)return;const p=profile.nativePlacement;
  if(!c||JSON.stringify(c)!==JSON.stringify(QWEN_Q3_CHECKPOINT_POLICY)||modelId!==undefined&&modelId!=='qwen3.8:27b-q3-k-m'||profile.backend!=='metal'||profile.contextTokens!==16384||profile.outputTokens!==4096||profile.batchTokens!==128||profile.microBatchTokens!==32||profile.cacheTypeK!=='q8_0'||profile.cacheTypeV!=='q8_0'||profile.flashAttention!=='on'||profile.metalResidency!=='disabled'||profile.generationPolicy?.kind!=='qwen38'||profile.generationPolicy.codingPromptCache!==true||!p||p.gpuLayers!==42||p.decodeThreads!==4||p.batchThreads!==4||p.repack!==false||p.outputOnCPU!==true||p.outputNormOnCPU!==true||p.cpuBlockIndices!==undefined||c.maximumSerializedBuffers*c.serializedStateUpperBoundBytes>c.hostReserveBytes)throw new RuntimeError('MODEL_PROFILE_MISMATCH','The recurrent checkpoint requires the exact bounded Qwen Q3 CPU24 profile and its two-buffer host reserve.');
}
export function inferenceProfileSignature(profile:NativeMemoryProfile,memoryMode:MemoryMode):string{
  assertNativeCheckpointProfile(profile);
  if(profile.portableCPUArguments!==undefined&&(JSON.stringify(profile.portableCPUArguments)!==JSON.stringify(PORTABLE_CPU_ARGUMENTS)||profile.backend!=='cpu'||profile.contextTokens!==4096||profile.outputTokens!==1024||profile.batchTokens!==64||profile.microBatchTokens!==32||profile.cacheTypeK!=='f16'||profile.cacheTypeV!=='f16'||profile.nativePlacement||profile.metalResidency||profile.recurrentCheckpoint||profile.flashAttention))throw new RuntimeError('MODEL_PROFILE_MISMATCH','The portable CPU identity requires exact4K/F16 geometry, noGPU/no-repack and four decode/batch threads.');
  return JSON.stringify({engineCommit:PINNED_ENGINE_COMMIT,memoryMode,backend:profile.backend,contextTokens:profile.contextTokens,outputTokens:profile.outputTokens,batchTokens:profile.batchTokens,microBatchTokens:profile.microBatchTokens,slots:1,...(profile.cacheTypeK?{cacheTypeK:profile.cacheTypeK,cacheTypeV:profile.cacheTypeV,flashAttention:profile.flashAttention}:{}),...(profile.nativePlacement?{nativePlacement:profile.nativePlacement}:{}),...(profile.metalResidency?{metalResidency:profile.metalResidency}:{}),...(profile.recurrentCheckpoint?{recurrentCheckpoint:profile.recurrentCheckpoint}:{}),...(profile.portableCPUArguments?{portableCPUArguments:profile.portableCPUArguments}:{}),...(profile.generationPolicy?{generationPolicy:profile.generationPolicy,codingSettings:modelGenerationOptions(profile.generationPolicy,'coding'),carefulSettings:modelGenerationOptions(profile.generationPolicy,'coding','careful'),helperSettings:modelGenerationOptions(profile.generationPolicy,'helper')}: {})});
}
/** Explicit profile overrides are applied after the normal ambient-variable
 * allowlist. Never forward arbitrary inherited GGML variables. */
export function nativeEnvironmentOverrides(profile:NativeMemoryProfile):NodeJS.ProcessEnv{
  assertNativeCheckpointProfile(profile);
  if(profile.metalResidency===undefined)return {};
  const placement=profile.nativePlacement,policy=profile.generationPolicy;
  const qwenQ3=policy?.kind==='qwen38'&&placement?.gpuLayers===42&&placement.outputOnCPU&&placement.outputNormOnCPU===true&&!placement.cpuBlockIndices;
  const museQ3=policy?.kind==='muse-glimmer'&&placement?.gpuLayers===999&&placement.cpuBlockIndices?.length===20;
  const q3Batch=profile.batchTokens===128&&profile.microBatchTokens===32&&policy?.codingPromptCache===true&&placement?.decodeThreads===4&&placement.batchThreads===4&&placement.repack===false&&(qwenQ3||museQ3);
  if(profile.metalResidency!=='disabled'||profile.backend!=='metal'||profile.contextTokens!==16384||profile.outputTokens!==4096||profile.cacheTypeK!=='q8_0'||profile.cacheTypeV!=='q8_0'||!(profile.batchTokens===64&&profile.microBatchTokens===16||q3Batch))throw new RuntimeError('MODEL_PROFILE_MISMATCH','The engine-local Metal residency override is not a supported bounded profile.');
  if(q3Batch)nativePlacementArguments(profile);
  return {GGML_METAL_NO_RESIDENCY:'1'};
}
/** Shared by the official no-allocation utility and real server. No repack means
 * CPU weights keep their original GGUF precision without packed weight copies. */
export function nativePlacementArguments(profile:NativeMemoryProfile):string[]{
  const p=profile.nativePlacement;if(!p)return ['--n-gpu-layers','999'];
  if(profile.backend!=='metal'||profile.contextTokens!==16384||profile.cacheTypeK!=='q8_0'||profile.cacheTypeV!=='q8_0'||!Number.isSafeInteger(p.gpuLayers)||p.gpuLayers<1||p.decodeThreads!==4||p.batchThreads!==4||p.repack!==false||typeof p.outputOnCPU!=='boolean'||p.outputNormOnCPU!==undefined&&typeof p.outputNormOnCPU!=='boolean')throw new RuntimeError('MODEL_PROFILE_MISMATCH','The mixed coding placement is not a supported bounded native profile.');
  if(p.cpuBlockIndices&&(!p.cpuBlockIndices.length||p.cpuBlockIndices.length>32||p.cpuBlockIndices.some(n=>!Number.isSafeInteger(n)||n<0||n>128)||new Set(p.cpuBlockIndices).size!==p.cpuBlockIndices.length))throw new RuntimeError('MODEL_PROFILE_MISMATCH','CPU tensor override indices are not a supported native placement.');
  const normOnCPU=p.outputNormOnCPU??p.outputOnCPU;
  const headOverride=p.outputOnCPU&&normOnCPU?'^output(?:_norm)?\\.weight$=CPU':p.outputOnCPU?'^output\\.weight$=CPU':normOnCPU?'^output_norm\\.weight$=CPU':null;
  const overrides=[...(headOverride?[headOverride]:[]),...(p.cpuBlockIndices?[`^blk\\.(?:${p.cpuBlockIndices.join('|')})\\.=CPU`]:[])];
  return ['--n-gpu-layers',String(p.gpuLayers),'--no-repack','--threads','4','--threads-batch','4',...(overrides.length?['--override-tensor',overrides.join(',')]:[])];
}
/** Only the pinned Muse Q3 variant uses a derived tensor override. Require all
 * 52 dense blocks and keep complete groups together. Output weights anchoring
 * its CPU prefix move with it; no other GPU tensor may cut through the prefix.
 * File offsets, not block numbers, decide its twenty physically first blocks. */
export function museQ3CPUPlacement(metadata:GGUFMetadata):Pick<NativeWeightPlacement,'cpuBlockIndices'|'outputOnCPU'|'outputNormOnCPU'>{
  if(metadata.architecture!=='muse-glimmer'||metadata.blockCount!==52||(metadata.expertCount??0)!==0||(metadata.expertUsedCount??0)!==0)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Muse Q3 placement requires its complete supported dense 52-block header.');
  const groups=new Map<number,{first:number;end:number}>();
  for(const tensor of metadata.tensors){const match=tensor.name.match(/^blk\.(\d+)\./);if(!match)continue;const index=Number(match[1]);if(!Number.isInteger(index)||index<0||index>=52||String(index)!==match[1])throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The Muse Q3 header contains an unsupported block index.');const group=groups.get(index);groups.set(index,{first:Math.min(group?.first??tensor.offset,tensor.offset),end:Math.max(group?.end??0,tensor.offset+tensor.bytes)});}
  if(groups.size!==52)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The Muse Q3 header is missing complete decoder block groups.');
  const physical=[...groups].sort((a,b)=>a[1].first-b[1].first);
  for(let i=0;i<physical.length;i++){if(i&&physical[i-1][1].end>physical[i][1].first)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Interleaved Muse Q3 block tensors cannot form a complete CPU prefix.');}
  const indices=physical.slice(0,20).map(([index])=>index),input=metadata.tensors.filter(t=>t.name==='token_embd.weight'),heads=metadata.tensors.filter(t=>t.name==='output.weight'),norms=metadata.tensors.filter(t=>t.name==='output_norm.weight');if(input.length!==1||heads.length!==1||norms.length!==1)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The Muse Q3 prefix requires unique input and output weights.');
  const prefix=metadata.tensors.filter(t=>indices.includes(Number(t.name.match(/^blk\.(\d+)\./)?.[1]))),cutoff=physical[20][1].first;
  // The input is always CPU, but its file position does not determine the block
  // cutoff. A tail embedding makes the CPU mmap view overlap GPU pages; the
  // pinned loader supports that and unified weight pages still count once.
  const outputOnCPU=heads[0].offset<cutoff,outputNormOnCPU=norms[0].offset<cutoff;
  const cpu=metadata.tensors.filter(t=>t.name==='token_embd.weight'||prefix.includes(t)||outputOnCPU&&t.name==='output.weight'||outputNormOnCPU&&t.name==='output_norm.weight'),gpu=metadata.tensors.filter(t=>!cpu.includes(t)),originalGPU=metadata.tensors.filter(t=>t.name!=='token_embd.weight');
  const gpuFirst=Math.min(...gpu.map(t=>t.offset)),originalGPUFirst=Math.min(...originalGPU.map(t=>t.offset)),gpuEnd=Math.max(...gpu.map(t=>t.offset+t.bytes)),originalGPUEnd=Math.max(...originalGPU.map(t=>t.offset+t.bytes));
  if(!gpu.length||gpuFirst<cutoff||gpuFirst<=originalGPUFirst||gpuEnd-gpuFirst>=originalGPUEnd-originalGPUFirst)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The complete Muse Q3 CPU block prefix does not reduce the actual Metal mmap span.');
  return {cpuBlockIndices:indices,outputOnCPU,outputNormOnCPU};
}
export function museQ3PhysicalCPUBlocks(metadata:GGUFMetadata):number[]{return [...museQ3CPUPlacement(metadata).cpuBlockIndices!];}
/** The pinned loader creates one mmap buffer per backend from min offset to max
 * end, not the sum of tensor bytes. Header positions, including gaps and skipped
 * Qwen MTP, are therefore part of placement evidence. Unified pages still count
 * once; overlapping CPU and Metal mappings are never added as physical RAM. */
export function nativeMappedPlacement(metadata:GGUFMetadata,profile:NativeMemoryProfile,modelId?:string):NativeMappedPlacement|undefined{
  assertNativeCheckpointProfile(profile,modelId);
  const p=profile.nativePlacement;if(!p)return;nativePlacementArguments(profile);
  const qwen=metadata.architecture==='qwen35',muse=metadata.architecture==='muse-glimmer';
  const museQ3=modelId==='muse-glimmer:30b-q3-k-m',qwenQ3=modelId==='qwen3.8:27b-q3-k-m';
  if(modelId!==undefined&&!['qwen3.8:27b','muse-glimmer:30b','qwen3.8:27b-q3-k-m','muse-glimmer:30b-q3-k-m'].includes(modelId)||museQ3&&!muse||qwenQ3&&!qwen)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The mixed placement is not an approved coding model identity.');
  const derived=museQ3?museQ3CPUPlacement(metadata):undefined,expectedCPU=derived?.cpuBlockIndices??(qwen?[]:[0,1,10,11,12,13]);
  if(!qwen&&!muse||metadata.blockCount!==(qwen?65:52)||p.gpuLayers!==(qwen?(qwenQ3?42:64):999)||p.outputOnCPU!==(derived?.outputOnCPU??qwen)||p.outputNormOnCPU!==(qwenQ3?true:derived?.outputNormOnCPU)||JSON.stringify(p.cpuBlockIndices??[])!==JSON.stringify(expectedCPU))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The verified GGUF does not match the explicit mixed placement.');
  if((qwenQ3||museQ3)&&(profile.batchTokens!==128||profile.microBatchTokens!==32))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The Q3 placement requires its exact bounded batch and microbatch profile.');
  const firstGPU=Math.max(metadata.blockCount+1-p.gpuLayers,0),mainBlocks=qwen?64:52;
  const host:typeof metadata.tensors=[],metal:typeof metadata.tensors=[];
  for(const tensor of metadata.tensors){
    const block=tensor.name.match(/^blk\.(\d+)\./);
    if(block){const index=Number(block[1]);if(index>=mainBlocks){if(qwen&&index===64)continue;throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Unexpected decoder block in the mixed placement.');}(index<firstGPU||p.cpuBlockIndices?.includes(index)?host:metal).push(tensor);}
    else if(tensor.name==='token_embd.weight')host.push(tensor);
    else if(tensor.name==='output.weight')(p.outputOnCPU?host:metal).push(tensor);
    else if(tensor.name==='output_norm.weight')((p.outputNormOnCPU??p.outputOnCPU)?host:metal).push(tensor);
    else throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Unexpected tensor in the pinned mixed placement.');
  }
  if(!host.length||!metal.length||!metadata.tensors.some(t=>t.name==='output.weight')||!metadata.tensors.some(t=>t.name==='output_norm.weight')||!Array.from({length:mainBlocks},(_,i)=>metadata.tensors.some(t=>t.name.startsWith(`blk.${i}.`))).every(Boolean))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The mixed placement is missing required weight groups.');
  const span=(tensors:typeof metadata.tensors)=>Math.max(...tensors.map(t=>t.offset+t.bytes))-Math.min(...tensors.map(t=>t.offset));
  const sum=(tensors:typeof metadata.tensors)=>tensors.reduce((n,t)=>n+t.bytes,0);
  // Native offloaded-layer INFO reflects the requested chooser, not tensor
  // overrides. Only mapped span evidence can confirm the actual placement.
  return {gpuLayers:Math.min(p.gpuLayers,metadata.blockCount+1),totalLayers:metadata.blockCount+1,metalMappedBytes:span(metal),hostMappedBytes:span(host),metalTensorBytes:sum(metal),hostTensorBytes:sum(host),...(museQ3?{cpuBlockIndices:[...expectedCPU],outputOnCPU:p.outputOnCPU,outputNormOnCPU:p.outputNormOnCPU}:{})};
}
export const PINNED_NATIVE_PLANNER_SHA256='d28f5116bfc500b9a40a0d764cfb0a274a7d17c0ae5ae5d18bd313225ffdae29';
export const NATIVE_RESOURCE_SOURCE_SHA256='aa0d0e8417dcb97af0beea648f14ba7b344669ce7f9a364b56371144fdbd4775';
export interface NativeMemoryRow {device:'MTL0'|'Host';modelBytes:number;contextBytes:number;computeBytes:number;}
export interface NativeMemoryPlan {
  schemaVersion:1;noAlloc:true;modelPayloadAllocatedBytes:0;engineCommit:string;engineDigest:string;plannerDigest:string;
  model:string;modelDigest:string;templateDigest:string;profileSignature:string;artifactBytes:number;rows:NativeMemoryRow[];
  mappedPlacement?:NativeMappedPlacement;
  metalResidency?:'disabled';
  recurrentCheckpoint?:NativeCheckpointPolicy;
  checkpointHostReserveBytes?:number;
  /** Conservative whole-artifact mmap span, including gaps and skipped tensors. */
  mappedWeightsUpperBoundBytes:number;gpuAllocationUpperBoundBytes:number;workspaceBytes:number;workingBytes:number;processHeadroomBytes:number;
}
/** b11429 fit-print is metadata-only. Its integer MiB rows round down; round up
 * each component before budgeting. A complete artifact bounds mmap gaps that
 * the native no-alloc tensor-size sum omits. Unified weight pages count once. */
export function parseNativeMemoryPlan(text:string,binding:{model:string;engineDigest:string;plannerDigest:string;modelDigest:string;templateDigest:string;profileSignature:string;artifactBytes:number;mappedPlacement?:NativeMappedPlacement;metalResidency?:'disabled'}):NativeMemoryPlan {
  if(binding.plannerDigest!==PINNED_NATIVE_PLANNER_SHA256||!['engineDigest','plannerDigest','modelDigest','templateDigest'].every(k=>/^[a-f0-9]{64}$/.test(binding[k as 'engineDigest']))||!Number.isSafeInteger(binding.artifactBytes)||binding.artifactBytes<24)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native planner or model identity is not pinned.');
  let signature:NativeMemoryProfile&{slots?:number;engineCommit?:string};try{signature=JSON.parse(binding.profileSignature);}catch{throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native memory profile identity is invalid.');}
  if(!signature||binding.metalResidency!==undefined&&binding.metalResidency!=='disabled'||signature.metalResidency!==binding.metalResidency)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native plan does not bind the explicit Metal residency setting.');
  if(signature.recurrentCheckpoint!==undefined){try{assertNativeCheckpointProfile(signature,binding.model);if(signature.slots!==1||signature.engineCommit!==PINNED_ENGINE_COMMIT||!binding.mappedPlacement||binding.mappedPlacement.gpuLayers!==42||binding.mappedPlacement.totalLayers!==66)throw new Error('checkpoint binding');}catch(error){throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native plan does not bind the exact Qwen Q3 recurrent checkpoint profile.',{cause:error});}}
  const rows:NativeMemoryRow[]=[];
  for(const line of text.split('\n')){
    const match=line.match(/^\s*(MTL0|Host)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);if(!match){if(/^\s*\S+\s+\d+\s+\d+\s+\d+\s*$/.test(line))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native memory plan contains an unexpected device.');continue;}
    if(rows.some(r=>r.device===match[1]))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native memory plan contains duplicate devices.');
    const values=match.slice(2).map(v=>Number(v));if(values.some(v=>!Number.isSafeInteger(v)||v<0||v>128*1024))throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The native memory plan contains unsupported sizes.');
    const [modelBytes,contextBytes,computeBytes]=values.map(v=>(v+1)*1024**2);rows.push({device:match[1] as NativeMemoryRow['device'],modelBytes,contextBytes,computeBytes});
  }
  const gpu=rows.find(r=>r.device==='MTL0'),host=rows.find(r=>r.device==='Host');
  if(rows.length!==2||!gpu||!host||gpu.modelBytes<=1024**2||gpu.contextBytes<=1024**2)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','The pinned planner did not return a complete Metal and host allocation plan.');
  if(binding.mappedPlacement){const p=binding.mappedPlacement;for(const [row,tensorBytes,mappedBytes] of [[gpu,p.metalTensorBytes,p.metalMappedBytes],[host,p.hostTensorBytes,p.hostMappedBytes]] as const){if(!Number.isSafeInteger(tensorBytes)||!Number.isSafeInteger(mappedBytes)||tensorBytes<=0||mappedBytes<tensorBytes||mappedBytes>binding.artifactBytes||row.modelBytes<tensorBytes||row.modelBytes-tensorBytes>1024**2+65536)throw new RuntimeError('MODEL_MEMORY_PLAN_INVALID','Native tensor allocations do not match the verified header placement.');}}
  const mappedWeightsUpperBoundBytes=Math.max(binding.artifactBytes,gpu.modelBytes+host.modelBytes);
  const checkpointHostReserveBytes=signature.recurrentCheckpoint?.hostReserveBytes??0;
  const processHeadroomBytes=GIB,workspaceBytes=rows.reduce((n,r)=>n+r.contextBytes+r.computeBytes,0)+processHeadroomBytes+checkpointHostReserveBytes;
  return {schemaVersion:1,noAlloc:true,modelPayloadAllocatedBytes:0,engineCommit:PINNED_ENGINE_COMMIT,...binding,...(signature.recurrentCheckpoint?{recurrentCheckpoint:{...signature.recurrentCheckpoint},checkpointHostReserveBytes}:{}),rows,mappedWeightsUpperBoundBytes,gpuAllocationUpperBoundBytes:mappedWeightsUpperBoundBytes+gpu.contextBytes+gpu.computeBytes+256*1024**2,workspaceBytes,workingBytes:mappedWeightsUpperBoundBytes+workspaceBytes,processHeadroomBytes};
}
export function assertNativeMemoryAdmission(plan:NativeMemoryPlan,hardware:HardwareInfo,sample:ResourceMeasurements):void {
  const metal=hardware.gpus.find(g=>g.backend==='metal'&&g.unifiedMemory),reserve=operatingSystemReserve(hardware.totalMemoryBytes);
  if(!metal||plan.gpuAllocationUpperBoundBytes>metal.freeMemoryBytes||plan.workingBytes>hardware.totalMemoryBytes-reserve)throw new RuntimeError('INSUFFICIENT_MEMORY','The native allocation plan exceeds the Metal recommendation or total RAM capacity after the OS reserve.');
  if(sample.pressure!=='normal'||sample.availableMemoryBytes<plan.workspaceBytes+reserve)throw new RuntimeError('INSUFFICIENT_MEMORY','The measured mmap calibration requires normal pressure and enough reclaimable memory for workspace plus the OS reserve. Active anonymous application memory is not counted as free.');
}
export function parseNativeResourceSample(text:string,pid:number,parentPid:number):Pick<ResourceMeasurements,'residentBytes'|'physicalFootprintBytes'|'rssBytes'|'sampledAt'>{
  let s:{schemaVersion?:number;helperIdentity?:string;pid?:number;parentPid?:number;rssBytes?:number;physicalFootprintBytes?:number;sampledAtMilliseconds?:number};try{s=JSON.parse(text);}catch{throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The owned process sampler returned invalid telemetry.');}
  if(s.schemaVersion!==1||s.helperIdentity!=='free-local-agent-resource-v1'||s.pid!==pid||s.parentPid!==parentPid||![s.rssBytes,s.physicalFootprintBytes,s.sampledAtMilliseconds].every(n=>Number.isSafeInteger(n)&&n!>0)||Math.abs(Date.now()-s.sampledAtMilliseconds!)>2000)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Fresh physical footprint and RSS for the app-owned child are required.');
  return {residentBytes:Math.max(s.rssBytes!,s.physicalFootprintBytes!),physicalFootprintBytes:s.physicalFootprintBytes!,rssBytes:s.rssBytes!,sampledAt:new Date(s.sampledAtMilliseconds!).toISOString()};
}
/** Retain bounded structured initialization evidence; never retain user text. */
export class NativeProfileLog {
  private partial='';private keys=new Set<string>();private values=new Set<string>();private flash:string|null=null;private buffers=new Map<string,number>();private placementInvalid=false;private offloaded:string|null=null;private threads:string|null=null;private residency=new Set<string>();private residencyMalformed=false;private contextSettings=new Map<string,number>();private contextSettingsInvalid=false;
  private checkpointSettings:string|null=null;private checkpointInvalid=false;private recurrentLayout:string|null=null;private createdCheckpoints=0;private restoredCheckpoints=0;
  private retainedCheckpoint:{posMin:number;posMax:number;nTokens:number}|null=null;
  private roundedMiB(text:string,expectedBytes:number):boolean{
    const match=text.match(/^\d+\.(\d{2,3})$/);if(!match)return false;
    // The native decimal is a rounded interval, not an exact allocation size.
    const observed=Number(text)*1024**2,tolerance=(0.5*10**-match[1].length+1e-8)*1024**2;
    return Number.isFinite(observed)&&Math.abs(observed-expectedBytes)<=tolerance;
  }
  private checkpointLine(line:string):void{
    if(/slot\s+\S+:\s*id\s+0\s*\|.*clearing prompt with \d+ tokens\s*$/.test(line))this.retainedCheckpoint=null;
    const superseded=line.match(/superseding context checkpoint at n_tokens = (\d+)\s*$/);if(superseded&&this.retainedCheckpoint?.nTokens===Number(superseded[1]))this.retainedCheckpoint=null;
    if(/context checkpoints (?:enabled|disabled)/.test(line)){
      const enabled=line.match(/context checkpoints enabled, max = (\d+), min spacing = (\d+)\s*$/),next=enabled?`${enabled[1]}/${enabled[2]}`:/context checkpoints disabled\s*$/.test(line)?'disabled':null;
      if(next===null||this.checkpointSettings!==null)this.checkpointInvalid=true;else this.checkpointSettings=next;
    }
    if(/llama_memory_recurrent:\s*size\s*=/.test(line)){
      const layout=line.match(/llama_memory_recurrent:\s*size\s*=\s*([\d.]+) MiB\s*\(\s*(\d+) cells,\s*(\d+) layers,\s*(\d+) seqs\s+(\d+) rs_seq\),\s*R \(([^)]+)\):\s*([\d.]+) MiB,\s*S \(([^)]+)\):\s*([\d.]+) MiB,\s*P \(([^)]+)\):\s*([\d.]+) MiB\s*$/);
      const c=QWEN_Q3_CHECKPOINT_POLICY;
      if(!layout||layout[2]!=='1'||layout[3]!=='64'||layout[4]!=='1'||layout[5]!=='0'||layout[6]!=='f32'||layout[8]!=='f32'||layout[10]!=='f32'||!this.roundedMiB(layout[11],0)||!this.roundedMiB(layout[1],c.recurrentPayloadBytes)||!this.roundedMiB(layout[7],c.recurrentRBytes)||!this.roundedMiB(layout[9],c.recurrentSBytes))this.checkpointInvalid=true;
      else{const next=layout.slice(1).join('/');if(this.recurrentLayout!==null)this.checkpointInvalid=true;this.recurrentLayout=next;}
    }
    if(/(?:erasing old|erasing|erased invalidated) context checkpoint/.test(line)){
      const tokens=line.match(/n_tokens = (\d+)/);if(tokens&&this.retainedCheckpoint?.nTokens===Number(tokens[1]))this.retainedCheckpoint=null;
    }
    if(!/(?:created|restored) context checkpoint/.test(line))return;
    // Native slot/task identities prevent unrelated diagnostic text from
    // substituting for an owned slot's actual state allocation/restore.
    const identity=line.match(/slot\s+\S+:\s*id\s+(\d+)\s*\|\s*task\s+(-?\d+)\s*\|/);
    const created=line.match(/created context checkpoint (\d+) of (\d+) \(pos_min = (\d+), pos_max = (\d+), n_tokens = (\d+), size = ([\d.]+) MiB\)\s*$/);
    const restored=line.match(/restored context checkpoint \(pos_min = (\d+), pos_max = (\d+), n_tokens = (\d+), n_past = (\d+), size = ([\d.]+) MiB\)\s*$/);
    const posMin=Number(created?.[3]??restored?.[1]),posMax=Number(created?.[4]??restored?.[2]),nTokens=Number(created?.[5]??restored?.[3]),size=Number(created?.[6]??restored?.[5])*1024**2;
    const c=QWEN_Q3_CHECKPOINT_POLICY;
    if(!identity||identity[1]!=='0'||!Number.isSafeInteger(Number(identity[2]))||Number(identity[2])<0||(!created&&!restored)||created&&(created[1]!=='1'||created[2]!=='1')||![posMin,posMax,nTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||posMin!==posMax||posMax!==nTokens-1||nTokens>16384||!Number.isFinite(size)||!this.roundedMiB(created?.[6]??restored?.[5]??'',c.serializedStateUpperBoundBytes)||restored&&(this.retainedCheckpoint===null||this.retainedCheckpoint.posMin!==posMin||this.retainedCheckpoint.posMax!==posMax||this.retainedCheckpoint.nTokens!==nTokens||!Number.isSafeInteger(Number(restored[4]))||Number(restored[4])<=0||Number(restored[4])>nTokens))this.checkpointInvalid=true;
    else if(created){this.createdCheckpoints++;this.retainedCheckpoint={posMin,posMax,nTokens};}else this.restoredCheckpoints++;
  }
  /** This checks only bounded native scalar evidence; no prompt content is kept. */
  checkpointBoundsValid(profile:NativeMemoryProfile,requireCreation=false):boolean{
    if(!profile.recurrentCheckpoint)return true;
    try{assertNativeCheckpointProfile(profile);}catch{return false;}
    const expected={n_seq_max:1,n_ctx:16384,n_ctx_seq:16384,n_batch:128,n_ubatch:32,n_rs_seq:0};
    return !this.checkpointInvalid&&!this.contextSettingsInvalid&&(this.checkpointSettings===null||this.checkpointSettings==='1/8192')&&Object.entries(expected).every(([key,n])=>!this.contextSettings.has(key)||this.contextSettings.get(key)===n)&&(!requireCreation||this.createdCheckpoints>0);
  }
  push(text:string):void{const lines=(this.partial+text).split('\n');this.partial=(lines.pop()??'').slice(-8192);for(const line of lines){this.checkpointLine(line);const setting=line.match(/llama_context:\s*(n_seq_max|n_ctx|n_ctx_seq|n_batch|n_ubatch|n_rs_seq)\s*=\s*(\d+)\s*$/);if(setting){const number=Number(setting[2]),previous=this.contextSettings.get(setting[1]);if(!Number.isSafeInteger(number)||previous!==undefined&&previous!==number)this.contextSettingsInvalid=true;this.contextSettings.set(setting[1],number);}else if(/llama_context:\s*(?:n_seq_max|n_ctx|n_ctx_seq|n_batch|n_ubatch|n_rs_seq)\s*=/.test(line))this.contextSettingsInvalid=true;if(/use residency sets\s*=/.test(line)){const state=line.match(/ggml_metal_device_init:\s*use residency sets\s*=\s*(true|false)\s*$/);if(state)this.residency.add(state[1]);else this.residencyMalformed=true;}const flash=line.match(/flash_attn\s*=\s*(\w+)/);if(flash)this.flash=flash[1];const kv=line.match(/K \(([^)]+)\):.*V \(([^)]+)\):/);if(kv){this.keys.add(kv[1]);this.values.add(kv[2]);}if(/flash.*(?:disabled|not supported|forcing off)/i.test(line))this.flash='disabled';const buffer=line.match(/load_tensors:\s+(\S+)\s+model buffer size\s*=\s*([\d.]+)\s*MiB/);if(buffer){if(this.buffers.has(buffer[1])||this.buffers.size>=8)this.placementInvalid=true;else this.buffers.set(buffer[1],Math.round(Number(buffer[2])*1024**2));}const offloaded=line.match(/offloaded (\d+)\/(\d+) layers to GPU/);if(offloaded){const next=`${offloaded[1]}/${offloaded[2]}`;if(this.offloaded&&this.offloaded!==next)this.placementInvalid=true;this.offloaded=next;}const threads=line.match(/system_info: n_threads\s*=\s*(\d+)\s*\(n_threads_batch\s*=\s*(\d+)\)/);if(threads){const next=`${threads[1]}/${threads[2]}`;if(this.threads&&this.threads!==next)this.placementInvalid=true;this.threads=next;}}}
  matches(profile:NativeMemoryProfile,placement?:NativeMappedPlacement):boolean{
    const precision=this.flash==='enabled'&&this.keys.size===1&&this.values.size===1&&this.keys.has(profile.cacheTypeK??'f16')&&this.values.has(profile.cacheTypeV??'f16');if(!precision||profile.metalResidency==='disabled'&&(this.residencyMalformed||this.residency.size!==1||!this.residency.has('false')))return false;if(profile.recurrentCheckpoint&&(!this.checkpointBoundsValid(profile)||this.checkpointSettings!=='1/8192'||this.recurrentLayout===null||this.contextSettings.get('n_rs_seq')!==0))return false;if(!profile.nativePlacement)return precision;
    if(profile.batchTokens===128&&profile.microBatchTokens===32&&(this.contextSettingsInvalid||this.contextSettings.get('n_seq_max')!==1||this.contextSettings.get('n_ctx')!==profile.contextTokens||this.contextSettings.get('n_ctx_seq')!==profile.contextTokens||this.contextSettings.get('n_batch')!==profile.batchTokens||this.contextSettings.get('n_ubatch')!==profile.microBatchTokens))return false;
    if(!placement||this.placementInvalid||this.offloaded!==`${placement.gpuLayers}/${placement.totalLayers}`||this.threads!==`${profile.nativePlacement.decodeThreads}/${profile.nativePlacement.batchThreads}`||this.buffers.size!==2)return false;
    // b11429 prints two decimals of MiB: allow rounding only, not unexplained
    // copies, a retained output prefix or a silently altered placement.
    const metal=this.buffers.get('MTL0_Mapped'),host=this.buffers.get('CPU_Mapped'),tolerance=0.0051*1024**2;
    return metal!==undefined&&host!==undefined&&Math.abs(metal-placement.metalMappedBytes)<=tolerance&&Math.abs(host-placement.hostMappedBytes)<=tolerance;
  }
}
export const EXPERIMENTAL_PROFILE_SIGNATURE = inferenceProfileSignature({backend:'cpu',contextTokens:4096,outputTokens:1024,batchTokens:128,microBatchTokens:32},'experimental-disk');
export function experimentalResidentBudget(hardware: HardwareInfo): number {
  return Math.max(0, Math.min(hardware.totalMemoryBytes - operatingSystemReserve(hardware.totalMemoryBytes), hardware.availableMemoryBytes - GIB));
}
export function validResourceMeasurements(sample: ResourceMeasurements): boolean {
  return Boolean(sample && Number.isFinite(Date.parse(sample.sampledAt)) && Number.isSafeInteger(sample.residentBytes) && sample.residentBytes >= 0 && Number.isSafeInteger(sample.availableMemoryBytes) && sample.availableMemoryBytes >= 0 && ['normal', 'warning', 'critical'].includes(sample.pressure));
}
/** Exact Qwen SSD route only. Native plan/ledger validation remains independent. */
export function assertQwen80SSDMemory(spec:CuratedModel,sample:ResourceMeasurements,bounds?:{
  hardware:HardwareInfo;residentLimitBytes:number;allocationBudgetBytes:number;plan:SSDResourcePlan|null|undefined;
}):void{
  if(!exactQwen80Source(spec))return;
  if(!validResourceMeasurements(sample)||Math.abs(Date.now()-Date.parse(sample.sampledAt))>10000)
    throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Qwen80 SSD requires current available-memory and pressure measurements.');
  const guards:string[]=[];
  if(sample.pressure!=='normal')guards.push('normal-pressure');
  if(sample.availableMemoryBytes<GIB)guards.push('available-headroom');
  if(bounds){
    const {hardware,plan,residentLimitBytes,allocationBudgetBytes}=bounds;
    if(!Number.isSafeInteger(hardware.totalMemoryBytes)||hardware.totalMemoryBytes<=0||
      !Number.isSafeInteger(residentLimitBytes)||residentLimitBytes<=0||!Number.isSafeInteger(allocationBudgetBytes)||allocationBudgetBytes<=0||allocationBudgetBytes>residentLimitBytes)
      throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Qwen80 SSD requires current hardware and exact positive resource budgets.');
    if(!plan||!Number.isSafeInteger(plan.ledger?.totalBytes)||plan.ledger.totalBytes<=0||plan.ledger.totalBytes>allocationBudgetBytes||
      plan.loadingPeakBytes!==undefined&&(!Number.isSafeInteger(plan.loadingPeakBytes)||plan.loadingPeakBytes<0||plan.loadingPeakBytes>allocationBudgetBytes))
      throw new RuntimeError('SSD_ALLOCATION_BUDGET','Qwen80 SSD requires its measured native plan to fit the admitted allocation budget.');
    if(!Number.isSafeInteger(sample.rssBytes)||sample.rssBytes!<=0||!Number.isSafeInteger(sample.physicalFootprintBytes)||sample.physicalFootprintBytes!<=0||
      sample.residentBytes!==Math.max(sample.rssBytes!,sample.physicalFootprintBytes!))
      throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','Qwen80 SSD requires current native RSS and physical-footprint measurements; overlapping measurements are never added.');
    const limit=Math.min(residentLimitBytes,hardware.totalMemoryBytes-operatingSystemReserve(hardware.totalMemoryBytes));
    if(sample.residentBytes>=limit)guards.push('owned-residency');
  }
  if(guards.length)throw new RuntimeError('SSD_MEMORY_GUARD_FAILED',`Qwen80 SSD stopped: guards=${guards.join(',')}; pressure=${sample.pressure}; available=${sample.availableMemoryBytes} bytes (minimum ${GIB}); RSS=${sample.rssBytes??'unavailable'}; physical footprint=${sample.physicalFootprintBytes??'unavailable'}. Completed actions are preserved.`);
}
/** Only reads host statistics and the app-owned process; it never changes paging or other processes. */
export async function probeResourceMeasurements(pid: number | null, platform: NodeJS.Platform = process.platform): Promise<ResourceMeasurements> {
  if (platform === 'linux' || platform === 'win32') return probePlatformMemory(pid, platform);
  if (platform !== 'darwin') throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'Owned-process memory monitoring is unavailable on this platform.');
  if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'The app-owned model process has no valid process identity.');
  const execute = promisify(execFile);
  const options = { timeout: 1500, maxBuffer: 65536, env: { LANG: 'C' } };
  const [memory, pressure, resident] = await Promise.all([
    execute('/usr/bin/vm_stat', [], options),
    execute('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], options),
    pid === null ? Promise.resolve({ stdout: '0' }) : execute('/bin/ps', ['-o', 'rss=', '-p', String(pid)], options),
  ]);
  const available = parseMacAvailableMemory(memory.stdout), level = Number(pressure.stdout.trim()), rss = Number(resident.stdout.trim());
  if (available === null || ![1, 2, 4].includes(level) || !resident.stdout.trim() || !Number.isSafeInteger(rss) || rss < 0) throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE', 'Reliable memory-pressure, available-memory, and model-residency measurements are required for Experimental disk mode.');
  return { sampledAt: new Date().toISOString(), residentBytes: rss * 1024, availableMemoryBytes: available, pressure: level === 4 ? 'critical' : level === 2 ? 'warning' : 'normal' };
}

/** Parses actual pinned-engine logs rather than treating all mmap weights as lazily eligible. */
export class EngineMemoryLog {
  private partial = '';
  private mapped: number[] = [];
  private lazy = new Map<string, number>();
  push(text: string): void {
    const lines = (this.partial + text).split('\n'); this.partial = (lines.pop() ?? '').slice(-8192);
    for (const line of lines) {
      const mapped = line.match(/(\S*Mapped)\s+(?:model\s+)?buffer size\s*=\s*([\d.]+)\s*MiB/);
      if (mapped) this.mapped.push(Math.round(Number(mapped[2]) * 1024 ** 2));
      const lazy = line.match(/tensor\s+(\S+)\s+\(size\s*=\s*(\d+)\s*MiB\)\s+lazy read enabled/);
      if (lazy) this.lazy.set(lazy[1], Number(lazy[2]) * 1024 ** 2);
    }
  }
  values(loaded = false): { mappedBytes: number | null; lazyEligibleBytes: number | null } {
    return { mappedBytes: this.mapped.length ? this.mapped.reduce((a, b) => a + b, 0) : null, lazyEligibleBytes: this.lazy.size ? [...this.lazy.values()].reduce((a, b) => a + b, 0) : loaded ? 0 : null };
  }
}

export interface SSDAllocationLedger {denseBytes:number;expertCacheBytes:number;stagingBytes:number;contextBytes:number;recurrentBytes:number;scratchBytes:number;uploadBytes:number;reservedBytes:number;totalBytes:number;}
export interface SSDStreamingStatus {
  pid?:number;
  workerIdentity:string;baseCommit:string;patchSha256:string;expectedGroups:number;streamedGroups:number;
  ioMode:string;cacheSlotsPerLayer:number;expertCacheBytes:number;ledger:SSDAllocationLedger;allocationBudgetBytes:number;residentLimitBytes:number;stage?:string;stopped?:boolean;stopReason?:string;reads?:number;hits?:number;deadlineArmed?:boolean;
  sampledAt:string;physicalFootprintBytes:number;rssBytes:number;lastProgress?:string;
  bytesRead?:number;cacheHits?:number;cacheMisses?:number;waves?:number;
  cpuKernel?:'unknown'|'standard'|'default';useExtraBufts?:boolean|null;cpuRepackTensorCount?:number|null;decodeThreads?:number|null;batchThreads?:number|null;
}
export const SSD_DEFAULT_PROFILE={backend:'cpu',contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,index:0} as const;
export const SSD_CPU_ARGUMENTS=['--no-repack','--threads','4','--threads-batch','4'] as const;
export interface SSDCPUProfileBinding {backend:string;backendArguments:string[];cpuKernel:'standard'|'default';useExtraBufts:boolean;decodeThreads:number;batchThreads:number;parityReportDigest:string|null;localOnly?:boolean;}
export function ssdProfileSignature(profile:typeof SSD_DEFAULT_PROFILE|{backend:string;contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number},binding:{engineDigest:string;patchDigest:string;artifactSetDigest:string;templateDigest:string;allocationBudgetBytes:number;cacheBytes:number;backend?:string;backendArguments?:string[];cpuKernel?:string;useExtraBufts?:boolean;decodeThreads?:number;batchThreads?:number;parityReportDigest?:string|null;localOnly?:boolean}):string{
  return JSON.stringify({engineCommit:PINNED_ENGINE_COMMIT,memoryMode:'ssd-experts',...profile,...binding,slots:1,ioMode:'darwin-nocache',workers:2,cacheTypeK:'f16',cacheTypeV:'f16'});
}
export function validateSSDStreamingStatus(value:unknown,expected:{patchDigest:string;minimumSlotsPerLayer:number;expectedGroups:number;allocationBudgetBytes:number;residentLimitBytes?:number;cacheBytes?:number;backend?:string;cpuKernel?:string;useExtraBufts?:boolean;decodeThreads?:number;batchThreads?:number}):SSDStreamingStatus{
  const s=value as SSDStreamingStatus;
  if(!s||s.baseCommit!==PINNED_ENGINE_COMMIT||s.patchSha256!==expected.patchDigest||s.workerIdentity!=='free-local-agent-ssd-v1'||s.expectedGroups!==expected.expectedGroups||s.streamedGroups!==s.expectedGroups||s.expectedGroups<1||s.ioMode!=='darwin-nocache'||!Number.isSafeInteger(s.cacheSlotsPerLayer)||s.cacheSlotsPerLayer<expected.minimumSlotsPerLayer)throw new RuntimeError('SSD_STREAMING_NOT_CONFIRMED','The worker did not confirm all expected expert groups, the required slot floor, and descriptor-local SSD reads. Ordinary full-model loading is not accepted.');
  if(expected.backend==='cpu'&&(s.cpuKernel!=='standard'||s.useExtraBufts!==false||s.cpuRepackTensorCount!==0||s.decodeThreads!==4||s.batchThreads!==4))throw new RuntimeError('SSD_PARITY_UNVERIFIED','The SSD worker did not confirm the validated standard CPU kernel, disabled repacking and four inference threads.');
  const l=s.ledger,fields=['denseBytes','expertCacheBytes','stagingBytes','contextBytes','recurrentBytes','scratchBytes','uploadBytes','reservedBytes'] as const;
  if(s.allocationBudgetBytes!==expected.allocationBudgetBytes||expected.residentLimitBytes!==undefined&&s.residentLimitBytes!==expected.residentLimitBytes||expected.cacheBytes!==undefined&&s.expertCacheBytes>expected.cacheBytes)throw new RuntimeError('SSD_ALLOCATION_BUDGET','The worker did not confirm the exact requested cache, allocation and resident limits.');
  if(!l||fields.some(k=>!Number.isSafeInteger(l[k])||l[k]<0)||!Number.isSafeInteger(l.totalBytes)||fields.reduce((n,k)=>n+l[k],0)!==l.totalBytes||l.totalBytes>expected.allocationBudgetBytes||!Number.isSafeInteger(s.expertCacheBytes)||s.expertCacheBytes!==l.expertCacheBytes)throw new RuntimeError('SSD_ALLOCATION_BUDGET','The SSD worker allocation ledger is incomplete or exceeds its bounded budget.');
  if(!Number.isSafeInteger(s.physicalFootprintBytes)||s.physicalFootprintBytes<0||!Number.isSafeInteger(s.rssBytes)||s.rssBytes<0||!Number.isFinite(Date.parse(s.sampledAt))||Math.abs(Date.now()-Date.parse(s.sampledAt))>10000)throw new RuntimeError('RESOURCE_MONITOR_UNAVAILABLE','The SSD worker physical-footprint measurement is missing or stale.');
  return s;
}

export interface SSDResourcePlan {
  schemaVersion:number;baseCommit:string;patchSha256:string;plannerSourceSha256:string;workerIdentity:string;architecture:string;
  noAlloc:boolean;modelPayloadAllocatedBytes:number;mappedColdBytes:number;allocationBudgetBytes:number;residentLimitBytes:number;cacheBudgetBytes:number;expectedGroups:number;minimumSlotsPerLayer:number;cacheSlotsPerLayer:number;
  profile:{backend:string;contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number;kvUnified?:boolean;nRsSeq?:number;checkpoints?:number;cacheTypeK:string;cacheTypeV:string;swaFull:boolean;slots:number;ioWorkers:number;cpuKernel?:string;useExtraBufts?:boolean;cpuRepackTensorCount?:number;decodeThreads?:number;batchThreads?:number};
  loadingDenseStagingBytes?:number;loadingPeakBytes?:number;
  ledger:{denseBytes:number;expertCacheBytes:number;contextBytes:number;recurrentBytes:number;scratchBytes:number;stagingBytes:number;outputBytes:number;reservedBytes:number;cpuWorkspaceBytes:number;totalBytes:number};
}
export function validateSSDResourcePlan(value:unknown,expected:{architecture:string;backend:string;patchDigest:string;sourceDigest:string;expectedGroups:number;minimumSlotsPerLayer:number;rawDenseBytes:number;cacheBytes:number;minimumCacheBytes:number;allocationBudgetBytes:number;residentLimitBytes:number;profile?:{contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number}}):SSDResourcePlan{
  const p=value as SSDResourcePlan,q=p?.profile,profile=expected.profile??SSD_DEFAULT_PROFILE;
  const legacy=profile.contextTokens===4096&&profile.outputTokens===1024&&profile.batchTokens===64&&profile.microBatchTokens===16;
  const qwen=expected.architecture==='qwen3next'&&expected.backend==='cpu'&&expected.expectedGroups===48&&expected.minimumSlotsPerLayer===30
    &&profile.contextTokens===8192&&profile.outputTokens===2048&&profile.batchTokens===64&&profile.microBatchTokens===16;
  if(!legacy&&!qwen)throw new RuntimeError('SSD_PLAN_INVALID','The requested SSD computation shape has no bounded model contract.');
  if(!p||p.schemaVersion!==1||p.baseCommit!==PINNED_ENGINE_COMMIT||p.patchSha256!==expected.patchDigest||p.plannerSourceSha256!==expected.sourceDigest||p.workerIdentity!=='free-local-agent-ssd-v1'||p.architecture!==expected.architecture||p.allocationBudgetBytes!==expected.allocationBudgetBytes||p.residentLimitBytes!==expected.residentLimitBytes||p.cacheBudgetBytes!==expected.cacheBytes||p.noAlloc!==true||p.modelPayloadAllocatedBytes!==0||p.mappedColdBytes!==0||p.expectedGroups!==expected.expectedGroups||p.minimumSlotsPerLayer!==expected.minimumSlotsPerLayer||p.cacheSlotsPerLayer!==expected.minimumSlotsPerLayer||!q||q.backend!==expected.backend||q.contextTokens!==profile.contextTokens||q.outputTokens!==profile.outputTokens||q.batchTokens!==profile.batchTokens||q.microBatchTokens!==profile.microBatchTokens||q.cacheTypeK!=='f16'||q.cacheTypeV!=='f16'||q.swaFull!==false||q.slots!==1||q.ioWorkers!==2||qwen&&(q.kvUnified!==true||q.nRsSeq!==0||q.checkpoints!==0))throw new RuntimeError('SSD_PLAN_INVALID','The metadata-only planner did not confirm the exact model, worker source, streaming floor and fixed runtime profile.');
  if(expected.backend==='cpu'&&(q.cpuKernel!=='standard'||q.useExtraBufts!==false||q.cpuRepackTensorCount!==0||q.decodeThreads!==4||q.batchThreads!==4))throw new RuntimeError('SSD_PARITY_UNVERIFIED','The SSD planner did not confirm the validated standard CPU kernel and four inference threads.');
  const l=p.ledger,fields=['denseBytes','expertCacheBytes','contextBytes','recurrentBytes','scratchBytes','stagingBytes','outputBytes','reservedBytes','cpuWorkspaceBytes'] as const;
  if(!l||fields.some(k=>!Number.isSafeInteger(l[k])||l[k]<0)||!Number.isSafeInteger(l.totalBytes)||l.totalBytes!==fields.reduce((n,k)=>n+l[k],0)||l.denseBytes<expected.rawDenseBytes||l.expertCacheBytes>expected.cacheBytes||l.expertCacheBytes<expected.minimumCacheBytes||l.contextBytes<1||l.reservedBytes<256*1024**2)throw new RuntimeError('SSD_PLAN_INVALID','The native allocation plan is incomplete or does not include bounded weights, context and process headroom.');
  if(p.loadingPeakBytes!==undefined&&(!Number.isSafeInteger(p.loadingPeakBytes)||p.loadingPeakBytes<0)||p.loadingDenseStagingBytes!==undefined&&(!Number.isSafeInteger(p.loadingDenseStagingBytes)||p.loadingDenseStagingBytes<0||p.loadingDenseStagingBytes>(p.loadingPeakBytes??l.totalBytes)))throw new RuntimeError('SSD_PLAN_INVALID','The native loading peak or dense staging measurement is invalid.');
  if(p.loadingPeakBytes!==undefined&&p.loadingPeakBytes<l.denseBytes+(p.loadingDenseStagingBytes??0)+l.reservedBytes)throw new RuntimeError('SSD_PLAN_INVALID','The native loading peak omits resident dense weights, staging or process headroom.');
  return p;
}

export interface SSDNumericalConfiguration {
  modelSha256:string;templateSha256:string;architecture:string;backend:'cpu'|'metal';
  cpuKernel:string;useExtraBufts:boolean;cpuRepackTensorCount:number;
  baseCommit:string;workerPatchSha256:string;report:string;reportSha256:string;scope:string;
  profile:{contextTokens:number;outputTokens:number;batchTokens:number;microBatchTokens:number;kvUnified?:boolean;nRsSeq?:number;checkpoints?:number;cacheSlotsPerLayer:number;cacheTypeK:string;cacheTypeV:string;swaFull:boolean;slots:number;ioWorkers:number;ioMode:string;decodeThreads:number;batchThreads:number};
}
/** A scoped computation certificate does not assert successful Chat or completed tasks. */
export function validateSSDNumericalProof(value:unknown,configuration:SSDNumericalConfiguration,patchDigest:string,nativeBinding?:SSDNumericalNativeBinding|null):boolean{
  const report=value as Partial<SSDNumericalConfiguration>&{schemaVersion?:number;passed?:boolean;baseCommit?:string};
  const p=configuration?.profile;
  if(!report||report.schemaVersion!==1||report.passed!==true||report.baseCommit!==PINNED_ENGINE_COMMIT||configuration.baseCommit!==PINNED_ENGINE_COMMIT||configuration.workerPatchSha256!==patchDigest||report.workerPatchSha256!==patchDigest||configuration.backend!=='cpu'||configuration.cpuKernel!=='standard'||configuration.useExtraBufts!==false||configuration.cpuRepackTensorCount!==0||!(configuration.architecture==='gemma4'&&configuration.scope==='representative-experts-and-two-swa-layers'||isQwen80NumericalReport(report,configuration,patchDigest,nativeBinding))||!['modelSha256','templateSha256','reportSha256'].every(k=>/^[a-f0-9]{64}$/.test(configuration[k as 'modelSha256'|'templateSha256'|'reportSha256']))||!/^validation\/[a-zA-Z0-9._-]+\.json$/.test(configuration.report))return false;
  const qwen=configuration.architecture==='qwen3next';
  if(!p||p.contextTokens!==(qwen?QWEN80_SSD_COMPUTATION.contextTokens:4096)||p.outputTokens!==(qwen?QWEN80_SSD_COMPUTATION.outputTokens:1024)||p.batchTokens!==64||p.microBatchTokens!==16||p.cacheSlotsPerLayer!==(qwen?30:24)||p.cacheTypeK!=='f16'||p.cacheTypeV!=='f16'||p.swaFull!==false||p.slots!==1||p.ioWorkers!==2||p.ioMode!=='darwin-nocache'||p.decodeThreads!==4||p.batchThreads!==4)return false;
  const fields=['modelSha256','templateSha256','architecture','backend','cpuKernel','useExtraBufts','cpuRepackTensorCount','scope'] as const;
  return fields.every(k=>report[k]===configuration[k])&&Boolean(report.profile)&&Object.keys(p).every(k=>report.profile![k as keyof typeof p]===p[k as keyof typeof p]);
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from '../catalog.ts';
import { curatedArtifactSetDigest, exactQwen80Source, ssdProfileContract, QWEN80_SSD_ARTIFACT_SET, QWEN80_SSD_TEMPLATE,
  QWEN80_SSD_SCOPE, QWEN80_SSD_PROTOCOL, QWEN80_SSD_WORKER_PATCH, SSD_BASE_COMMIT, QWEN80_SSD_COMPUTATION, ssdNumericalNativeBinding, canonicalNativeJSON, qwen80SSDArguments, Qwen80NativeStartupLog } from '../ssd-contract.ts';
import { assertQwen80SSDMemory, validateSSDNumericalProof,validateSSDResourcePlan } from '../memory.ts';
import { GIB, operatingSystemReserve } from '../hardware.ts';
import { LocalInferenceRuntime } from '../index.ts';
import { generationPolicyForModel, isQualificationEligible, modelGenerationOptions,modelUsesLocalOnlyExecution } from '../generation.ts';

const spec=MODEL_CATALOG.find(x=>x.id==='qwen3-coder-next:80b')!;
function nativeManifest(){
  return {schemaVersion:1,baseCommit:SSD_BASE_COMMIT,patchSha256:QWEN80_SSD_WORKER_PATCH,target:'darwin-arm64',
    backends:[{id:'cpu',executable:'worker/llama-server-ssd',libraryDirectory:'worker',arguments:[]}],
    planner:{schemaVersion:1,executable:'worker/llama-plan-ssd',sourceSha256:'a'.repeat(64)},
    integrity:{schemaVersion:1,executable:'worker/llama-hash-ssd',sourceSha256:'b'.repeat(64)},
    files:['llama-server-ssd','llama-plan-ssd','llama-hash-ssd','libllama.0.dylib','libggml.0.dylib','libggml-base.0.dylib','libggml-cpu.0.dylib'].map((name,i)=>({path:'worker/'+name,size:1024+i,sha256:String(i+1).repeat(64)}))};
}
function syntheticMeasuredReport(){
  const measuredProof={protocol:QWEN80_SSD_PROTOCOL,sourceArtifactSetVerified:true,expertParityPassed:true,completeHybridEvidence:true,
    sourceFingerprintUnchanged:true,ownedProcessesStopped:true,selectedPairsContributeOnce:true,nodesCompared:1,elementsCompared:1,
    expertLayoutsSurveyed:2,representativeGroupsCompared:4,elementsOutsideTolerance:0,mismatchedIds:0,nonfinite:0,
    comparisonSha256:'a'.repeat(64),processReportSha256:'b'.repeat(64),expertParityLogSha256:'c'.repeat(64)};
  const configuration={baseCommit:SSD_BASE_COMMIT,modelSha256:QWEN80_SSD_ARTIFACT_SET,templateSha256:QWEN80_SSD_TEMPLATE,
    architecture:'qwen3next',backend:'cpu' as const,cpuKernel:'standard',useExtraBufts:false,cpuRepackTensorCount:0,
    workerPatchSha256:QWEN80_SSD_WORKER_PATCH,report:'validation/qwen-fixture.json',reportSha256:'d'.repeat(64),scope:QWEN80_SSD_SCOPE,
    profile:{...QWEN80_SSD_COMPUTATION}};
  const nativeBinding=ssdNumericalNativeBinding(nativeManifest())!;
  const resourceSummary={sampleCount:2,ownedChildSampleCount:1,minimumAvailableRamBytes:2*1024**3,maximumControllerRssBytes:1024,
    maximumControllerPhysicalFootprintBytes:2048,maximumOwnedChildRssBytes:4096,maximumOwnedChildPhysicalFootprintBytes:8192,allPressureNormal:true};
  return {configuration,nativeBinding,report:{...configuration,schemaVersion:1,passed:true,absoluteTolerance:1e-5,relativeTolerance:1e-5,measuredProof,
    nativeResourceIdentity:nativeBinding.identity,nativeResourceDigest:nativeBinding.digest,resolvedNativeLayout:{contextTokens:8192,contextPerSequence:8192,batchTokens:64,microBatchTokens:16,slots:1,kvUnified:true,nRsSeq:0,cacheTypeK:'f16',cacheTypeV:'f16'},measuredRun:{resourceSummary}}};
}
test('offline synthetic Qwen contract fixture has exact immutable aggregate identity',()=>{
  assert(exactQwen80Source(spec));assert.equal(curatedArtifactSetDigest(spec),QWEN80_SSD_ARTIFACT_SET);
  assert.notEqual(spec.sha256,QWEN80_SSD_ARTIFACT_SET);
  for(const change of [{revision:'0'.repeat(40)},{quantization:'Q3_K_M'},{artifacts:[...spec.artifacts!].reverse()},{artifacts:spec.artifacts!.slice(0,3)}])assert.equal(exactQwen80Source({...spec,...change}),false);
  assert.deepEqual(ssdProfileContract(spec).profile,{backend:'cpu',contextTokens:8192,outputTokens:2048,batchTokens:64,microBatchTokens:16,index:0,kvUnified:true,nRsSeq:0,checkpoints:0});
});
test('new Qwen report validator rejects old shape, shard1, stale proof and unsupported routes',()=>{
  const {configuration:c,report:r,nativeBinding:b}=syntheticMeasuredReport();assert(validateSSDNumericalProof(r,c,QWEN80_SSD_WORKER_PATCH,b));
  for(const change of [{modelSha256:spec.sha256},{templateSha256:'f'.repeat(64)},{architecture:'gemma4'},{scope:'representative-experts-and-two-swa-layers'},
    {backend:'metal'},{workerPatchSha256:'f'.repeat(64)},{profile:{...c.profile,contextTokens:4096,outputTokens:1024}},
    {profile:{...c.profile,cacheSlotsPerLayer:24}},{profile:{...c.profile,batchThreads:8}}])
    assert.equal(validateSSDNumericalProof({...r,...change},{...c,...change} as any,QWEN80_SSD_WORKER_PATCH,b),false);
  for(const tolerance of [{absoluteTolerance:0.5},{relativeTolerance:0.5},{absoluteTolerance:undefined}])assert.equal(validateSSDNumericalProof({...r,...tolerance},c,QWEN80_SSD_WORKER_PATCH,b),false);
  for(const change of [{protocol:'4k'},{ownedProcessesStopped:false},{nonfinite:1},{nodesCompared:0},{mismatchedIds:1},{comparisonSha256:'missing'}])
    assert.equal(validateSSDNumericalProof({...r,measuredProof:{...r.measuredProof,...change}},c,QWEN80_SSD_WORKER_PATCH,b),false);
  assert.equal(validateSSDNumericalProof({...r,measuredProof:undefined},c,QWEN80_SSD_WORKER_PATCH,b),false);
});
test('legacy Gemma certificate branch remains4K/24 slots without Qwen measured fields',()=>{
  const {configuration}=syntheticMeasuredReport();const {kvUnified,nRsSeq,checkpoints,...legacyProfile}=configuration.profile;const c={...configuration,modelSha256:'a'.repeat(64),templateSha256:'b'.repeat(64),architecture:'gemma4',
    scope:'representative-experts-and-two-swa-layers',workerPatchSha256:'c'.repeat(64),profile:{...legacyProfile,contextTokens:4096,outputTokens:1024,cacheSlotsPerLayer:24}};
  assert(validateSSDNumericalProof({...c,schemaVersion:1,passed:true},c,c.workerPatchSha256));
  assert.equal(validateSSDNumericalProof({...c,schemaVersion:1,passed:true,profile:{...c.profile,contextTokens:8192}},c,c.workerPatchSha256),false);
});
test('Qwen80 local-only policy preserves default no-thinking semantics and does not earn qualification',()=>{
  const policy=generationPolicyForModel(spec.id);assert.equal(modelUsesLocalOnlyExecution(policy),true);assert.equal(modelUsesLocalOnlyExecution(undefined),false);assert.equal(modelUsesLocalOnlyExecution(generationPolicyForModel('qwen3.5:4b')),false);assert.equal(policy.kind,'default');assert.equal(policy.localOnly,true);assert.equal(policy.preserveThinking,false);
  assert.equal(isQualificationEligible(spec.id),false);assert.equal(policy.codingPromptCache,undefined);
  assert.deepEqual(modelGenerationOptions(policy,'helper'),{chat_template_kwargs:{enable_thinking:false}});
  assert.equal(generationPolicyForModel('qwen3.5:4b').localOnly,undefined);
});

test('native no-alloc plan validator accepts only the selected exact bounded Qwen shape',()=>{
  const reserve=256*1024**2,ledger={denseBytes:8,expertCacheBytes:16,contextBytes:4,recurrentBytes:2,scratchBytes:2,stagingBytes:2,outputBytes:2,reservedBytes:reserve,cpuWorkspaceBytes:2,totalBytes:reserve+38};
  const profile={backend:'cpu',contextTokens:8192,outputTokens:2048,batchTokens:64,microBatchTokens:16,cacheTypeK:'f16',cacheTypeV:'f16',swaFull:false,slots:1,ioWorkers:2,cpuKernel:'standard',useExtraBufts:false,cpuRepackTensorCount:0,decodeThreads:4,batchThreads:4,kvUnified:true,nRsSeq:0,checkpoints:0};
  const expected={architecture:'qwen3next',backend:'cpu',patchDigest:QWEN80_SSD_WORKER_PATCH,sourceDigest:'a'.repeat(64),expectedGroups:48,minimumSlotsPerLayer:30,rawDenseBytes:8,cacheBytes:32,minimumCacheBytes:16,allocationBudgetBytes:reserve+100,residentLimitBytes:reserve+200,profile};
  const plan={schemaVersion:1,baseCommit:SSD_BASE_COMMIT,patchSha256:expected.patchDigest,plannerSourceSha256:expected.sourceDigest,workerIdentity:'free-local-agent-ssd-v1',architecture:'qwen3next',noAlloc:true,modelPayloadAllocatedBytes:0,mappedColdBytes:0,allocationBudgetBytes:expected.allocationBudgetBytes,residentLimitBytes:expected.residentLimitBytes,cacheBudgetBytes:32,expectedGroups:48,minimumSlotsPerLayer:30,cacheSlotsPerLayer:30,profile,ledger};
  assert.doesNotThrow(()=>validateSSDResourcePlan(plan,expected));
  for(const change of [{architecture:'gemma4'},{backend:'metal'},{expectedGroups:47},{minimumSlotsPerLayer:24}, {profile:{...profile,outputTokens:1024}}])assert.throws(()=>validateSSDResourcePlan(plan,{...expected,...change}));
  assert.throws(()=>validateSSDResourcePlan({...plan,modelPayloadAllocatedBytes:1},expected));
  assert.throws(()=>validateSSDResourcePlan({...plan,ledger:{...ledger,totalBytes:ledger.totalBytes-1}},expected));
});


test('same-patch rebuilt native computation cannot reuse an old Qwen report',()=>{
  const {configuration:c,report:r,nativeBinding:b}=syntheticMeasuredReport();
  assert.equal(validateSSDNumericalProof(r,c,QWEN80_SSD_WORKER_PATCH),false);
  for(const name of ['llama-server-ssd','llama-plan-ssd','llama-hash-ssd','libllama.0.dylib','libggml-cpu.0.dylib']){
    const m=nativeManifest();m.files=m.files.map(row=>row.path==='worker/'+name?{...row,sha256:'f'.repeat(64)}:row);
    const changed=ssdNumericalNativeBinding(m)!;assert.notEqual(changed.digest,b.digest);
    assert.equal(validateSSDNumericalProof(r,c,QWEN80_SSD_WORKER_PATCH,changed),false);
  }
  const m=nativeManifest();m.planner.sourceSha256='f'.repeat(64);assert.equal(validateSSDNumericalProof(r,c,QWEN80_SSD_WORKER_PATCH,ssdNumericalNativeBinding(m)),false);
  assert.equal(validateSSDNumericalProof({...r,nativeResourceIdentity:{...r.nativeResourceIdentity,nativeFiles:[]}},c,QWEN80_SSD_WORKER_PATCH,b),false);
});
test('native identity excludes reports, binds ordered backend configuration, and rejects malformed inventory',()=>{
  const m=nativeManifest(),b=ssdNumericalNativeBinding(m)!;
  const refreshed={...m,validatedConfigurations:[{report:'new.json'}],files:[...m.files,{path:'validation/new.json',size:999,sha256:'f'.repeat(64)}]};
  assert.deepEqual(ssdNumericalNativeBinding(refreshed),b);assert.deepEqual(ssdNumericalNativeBinding({...m,files:[...m.files].reverse()}),b);
  for(const files of [[...m.files,m.files[0]],[...m.files,{path:'worker/../evil',size:1,sha256:'f'.repeat(64)}],m.files.filter(row=>row.path!=='worker/libggml-cpu.0.dylib'),
    m.files.map((row,i)=>i===0?{...row,size:0}:row),m.files.map((row,i)=>i===0?{...row,sha256:'wrong'}:row)])assert.equal(ssdNumericalNativeBinding({...m,files}),null);
  assert.equal(ssdNumericalNativeBinding({...m,backends:[...m.backends,...m.backends]}),null);
  assert.notEqual(ssdNumericalNativeBinding({...m,backends:m.backends.map(row=>({...row,arguments:['--threads','8']}))})!.digest,b.digest);
  assert.equal(canonicalNativeJSON({z:[{b:2,a:1}],a:0}),'{"a":0,"z":[{"a":1,"b":2}]}');
});
test('bounded resource summary is required and raw sampler arrays are not shipped in Qwen reports',()=>{
  const {configuration:c,report:r,nativeBinding:b}=syntheticMeasuredReport();
  const summary=r.measuredRun.resourceSummary;
  for(const change of [{sampleCount:0},{ownedChildSampleCount:0},{allPressureNormal:false},{minimumAvailableRamBytes:1024},
    {maximumControllerRssBytes:257*1024**2},{maximumOwnedChildPhysicalFootprintBytes:4*1024**3},{ownedChildSampleCount:3}])
    assert.equal(validateSSDNumericalProof({...r,measuredRun:{resourceSummary:{...summary,...change}}},c,QWEN80_SSD_WORKER_PATCH,b),false);
  assert.equal(validateSSDNumericalProof({...r,measuredRun:{resourceSummary:summary,resourceSamples:[]}},c,QWEN80_SSD_WORKER_PATCH,b),false);
});

test('TypeScript, proof controller and passive converter agree on exact native identity encoding',()=>{
  const manifest=nativeManifest(),expected=ssdNumericalNativeBinding(manifest)!;
  const directory=fileURLToPath(new URL('../../../scripts/ssd-inference/validation/',import.meta.url));
  const script=`import importlib.util,json,pathlib,sys
def load(name):
 p=pathlib.Path(sys.argv[1])/name
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
manifest=json.load(sys.stdin);proof=load('run-qwen80-proof.py');convert=load('convert-qwen80-certificate.py')
identity=convert.native_identity(manifest)
print(json.dumps({'proof':proof.native_binding(manifest),'converter':{'identity':identity,'digest':convert.native_digest(identity)}}))`;
  const child=spawnSync('python3',['-c',script,directory],{input:JSON.stringify(manifest),encoding:'utf8',timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(child.status,0,child.stderr);const actual=JSON.parse(child.stdout);
  assert.deepEqual(actual.proof,expected);assert.deepEqual(actual.converter,expected);
});


test('Qwen-only invocation requests unified KV and preserves Gemma invocation',()=>{
  assert.deepEqual(qwen80SSDArguments(spec,true),['--kv-unified','--log-verbosity','4']);
  assert.deepEqual(qwen80SSDArguments(spec,false),[]);
  assert.deepEqual(qwen80SSDArguments(MODEL_CATALOG.find(x=>x.id==='gemma4:26b')!,true),[]);
  const {configuration:c,report:r,nativeBinding:b}=syntheticMeasuredReport();
  for(const change of [{kvUnified:false},{nRsSeq:1},{checkpoints:1}])assert.equal(validateSSDNumericalProof({...r,profile:{...r.profile,...change}},{...c,profile:{...c.profile,...change}},QWEN80_SSD_WORKER_PATCH,b),false);
  assert.equal(validateSSDNumericalProof({...r,resolvedNativeLayout:{...r.resolvedNativeLayout,kvUnified:false}},c,QWEN80_SSD_WORKER_PATCH,b),false);
});
test('current native Qwen startup requires actual context/cache/checkpoint evidence plus current props',()=>{
  const props={total_slots:1,default_generation_settings:{n_ctx:8192}};
  const lines=['llama_context: n_seq_max = 1','llama_context: n_ctx = 8192','llama_context: n_ctx_seq = 8192',
    'llama_context: n_batch = 64','llama_context: n_ubatch = 16','llama_context: kv_unified = true','llama_context: n_rs_seq = 0',
    'llama_kv_cache: size = 96.0 MiB, K (f16): 48.0 MiB, V (f16): 48.0 MiB','srv   load_model: context checkpoints disabled'];
  const text=lines.join('\n')+'\n',complete=new Qwen80NativeStartupLog();
  for(let i=0;i<text.length;i+=7)complete.append(text.slice(i,i+7));assert(complete.confirmed(props));
  for(let i=0;i<lines.length;i++){const missing=new Qwen80NativeStartupLog();missing.append(lines.filter((_,j)=>j!==i).join('\n')+'\n');assert.equal(missing.confirmed(props),false);}
  for(const change of ['llama_context: kv_unified = false','llama_context: n_rs_seq = 1','srv load_model: context checkpoints enabled, max = 1','llama_kv_cache: K (q8_0): 1.0 MiB, V (f16): 1.0 MiB']){
    const changed=new Qwen80NativeStartupLog();changed.append(text+change+'\n');assert.equal(changed.confirmed(props),false);
  }
  assert.equal(complete.confirmed({total_slots:2,default_generation_settings:{n_ctx:8192}}),false);
  assert.equal(complete.confirmed({total_slots:1,default_generation_settings:{n_ctx:4096}}),false);
  const requestedOnly=new Qwen80NativeStartupLog();requestedOnly.append('--kv-unified --ctx-checkpoints 0\n');assert.equal(requestedOnly.confirmed(props),false);
});

// Synthetic bounded telemetry only; no native process, weights or resource probes.
function memorySample(change:Record<string,unknown>={}){
  return {sampledAt:new Date().toISOString(),pressure:'normal' as const,availableMemoryBytes:GIB,
    rssBytes:2*GIB,physicalFootprintBytes:3*GIB,residentBytes:3*GIB,...change};
}
function memoryBounds(change:Record<string,unknown>={}){
  return {hardware:{totalMemoryBytes:24*GIB} as any,residentLimitBytes:10*GIB,allocationBudgetBytes:9*GIB,
    plan:{ledger:{totalBytes:8*GIB},loadingPeakBytes:7*GIB} as any,...change};
}
test('Qwen SSD admission rejects a single warning or below1GiB sample and accepts exact boundary',()=>{
  assert.doesNotThrow(()=>assertQwen80SSDMemory(spec,memorySample()));
  for(const change of [{pressure:'warning'},{pressure:'critical'},{availableMemoryBytes:GIB-1},{pressure:'warning',availableMemoryBytes:8*GIB}]){
    assert.throws(()=>assertQwen80SSDMemory(spec,memorySample(change) as any),(e:any)=>e.code==='SSD_MEMORY_GUARD_FAILED');
  }
  assert.throws(()=>assertQwen80SSDMemory(spec,memorySample({sampledAt:new Date(Date.now()-10001).toISOString()})),(e:any)=>e.code==='RESOURCE_MONITOR_UNAVAILABLE');
  assert.throws(()=>assertQwen80SSDMemory(spec,memorySample({availableMemoryBytes:NaN})),(e:any)=>e.code==='RESOURCE_MONITOR_UNAVAILABLE');
});
test('Qwen SSD worker guard preserves exact native plan, overlapping RSS/footprint and OS reserve',()=>{
  const bounds=memoryBounds();assert.doesNotThrow(()=>assertQwen80SSDMemory(spec,memorySample(),bounds));
  // Both overlap:6+8 exceeds10, but max6/8 fits. Adding them would incorrectly reject.
  assert.doesNotThrow(()=>assertQwen80SSDMemory(spec,memorySample({rssBytes:6*GIB,physicalFootprintBytes:8*GIB,residentBytes:8*GIB}),bounds));
  for(const change of [{rssBytes:10*GIB,residentBytes:10*GIB},{physicalFootprintBytes:10*GIB,residentBytes:10*GIB}])
    assert.throws(()=>assertQwen80SSDMemory(spec,memorySample(change),bounds),(e:any)=>e.code==='SSD_MEMORY_GUARD_FAILED');
  const systemLimit=Math.ceil(bounds.hardware.totalMemoryBytes-operatingSystemReserve(bounds.hardware.totalMemoryBytes));
  assert.throws(()=>assertQwen80SSDMemory(spec,memorySample({rssBytes:systemLimit,residentBytes:systemLimit}),memoryBounds({residentLimitBytes:24*GIB})),(e:any)=>e.code==='SSD_MEMORY_GUARD_FAILED');
  for(const change of [{rssBytes:undefined},{physicalFootprintBytes:null},{rssBytes:0},{residentBytes:5*GIB}])
    assert.throws(()=>assertQwen80SSDMemory(spec,memorySample(change) as any,bounds),(e:any)=>e.code==='RESOURCE_MONITOR_UNAVAILABLE');
  for(const change of [{plan:null},{plan:{ledger:{totalBytes:10*GIB}}},{plan:{ledger:{totalBytes:8*GIB},loadingPeakBytes:10*GIB}}])
    assert.throws(()=>assertQwen80SSDMemory(spec,memorySample(),memoryBounds(change)),(e:any)=>e.code==='SSD_ALLOCATION_BUDGET');
  assert.throws(()=>assertQwen80SSDMemory(spec,memorySample(),memoryBounds({allocationBudgetBytes:11*GIB})),(e:any)=>e.code==='RESOURCE_MONITOR_UNAVAILABLE');
});
test('stricter Qwen memory guard does not alter Gemma or other model admission semantics',()=>{
  const gemma=MODEL_CATALOG.find(x=>x.id==='gemma4:26b')!;
  assert.doesNotThrow(()=>assertQwen80SSDMemory(gemma,memorySample({pressure:'warning',availableMemoryBytes:0}) as any,memoryBounds({plan:null})));
  assert.doesNotThrow(()=>assertQwen80SSDMemory({...spec,revision:'0'.repeat(40)},memorySample({pressure:'critical'}) as any));
});

/** Actual runtime guard/stop methods with in-memory ownership and sample stubs. */
function offlineGuardHarness(sample=memorySample({pressure:'warning'}) as any){
  const runtime:any=Object.create(LocalInferenceRuntime.prototype),child={pid:101},events:any[]=[],killed:number[]=[];
  runtime.child=child;runtime.resourceBusy=false;runtime.stoppedTrials=new Set();runtime.prepared={sourceModel:spec.id};
  runtime.status={memoryMode:'ssd-experts',hardware:memoryBounds().hardware,loadedModel:spec.id,
    experimentalTrial:{id:'owned-trial',model:spec.id,mode:'ssd-experts',state:'passed',probePassed:true,toolProbePassed:true}};
  runtime.spec=()=>spec;runtime.resourceSample=async()=>sample;runtime.trialController=new AbortController();
  runtime.emit=(type:string,value:unknown)=>{events.push({type,value});};
  runtime.update=(change:unknown)=>{runtime.status={...runtime.status,...change as any};};
  runtime.terminateChild=async()=>{killed.push(runtime.child.pid);runtime.child=null;};
  return {runtime,child,events,killed};
}
test('Qwen worker uses current owned native telemetry and rejects another PID, missing plan or incomplete streaming',()=>{
  const {runtime}=offlineGuardHarness(memorySample()),bounds=memoryBounds();
  Object.assign(runtime.status.experimentalTrial,{resourceBudgetBytes:bounds.residentLimitBytes,allocationBudgetBytes:bounds.allocationBudgetBytes,memoryPlan:bounds.plan});
  runtime.ssdBinding={patchDigest:QWEN80_SSD_WORKER_PATCH,minimumSlotsPerLayer:30,expectedGroups:48,
    allocationBudgetBytes:bounds.allocationBudgetBytes,residentLimitBytes:bounds.residentLimitBytes,backend:'cpu'};
  const ledger={denseBytes:7*GIB,expertCacheBytes:GIB,stagingBytes:0,contextBytes:0,recurrentBytes:0,scratchBytes:0,uploadBytes:0,reservedBytes:0,totalBytes:8*GIB};
  const native={pid:101,workerIdentity:'free-local-agent-ssd-v1',baseCommit:SSD_BASE_COMMIT,patchSha256:QWEN80_SSD_WORKER_PATCH,
    expectedGroups:48,streamedGroups:48,cacheSlotsPerLayer:30,expertCacheBytes:GIB,allocationBudgetBytes:9*GIB,residentLimitBytes:10*GIB,
    ledger,ioMode:'darwin-nocache',sampledAt:new Date().toISOString(),rssBytes:2*GIB,physicalFootprintBytes:3*GIB,
    cpuKernel:'standard',useExtraBufts:false,cpuRepackTensorCount:0,decodeThreads:4,batchThreads:4};
  runtime.ssdStatus=native;
  // Generic probe RSS is not accepted as the worker RSS or added to its footprint.
  assert.equal(runtime.qwen80SSDWorkerSample(spec,memorySample({rssBytes:200*GIB,residentBytes:200*GIB})).residentBytes,3*GIB);
  for(const change of [{pid:202},{pid:undefined},{physicalFootprintBytes:0},{sampledAt:new Date(Date.now()-10001).toISOString()},
    {streamedGroups:47},{ledger:{...ledger,totalBytes:9*GIB+1}}]){
    runtime.ssdStatus={...native,...change};assert.throws(()=>runtime.qwen80SSDWorkerSample(spec,memorySample()));
  }
  runtime.ssdStatus=native;runtime.status.experimentalTrial.memoryPlan=null;
  assert.throws(()=>runtime.qwen80SSDWorkerSample(spec,memorySample()),(e:any)=>e.code==='SSD_ALLOCATION_BUDGET');
});
test('first Qwen watchdog warning stops only its owned worker and cancels pending turn once',async()=>{
  const {runtime,child,events,killed}=offlineGuardHarness();
  await runtime.watchResources(child);
  assert.deepEqual(killed,[101]);assert.equal(runtime.trialController.signal.aborted,true);
  assert.equal(runtime.status.experimentalTrial.state,'failed');assert.equal(runtime.prepared,null);
  assert.equal(runtime.status.experimentalTrial.error.code,'SSD_MEMORY_GUARD_FAILED');
  assert.deepEqual(events.map(x=>x.value.trialId),['owned-trial']);
  await runtime.watchResources(child);assert.deepEqual(killed,[101]);assert.equal(events.length,1);
});
test('Qwen pre-request guard fails before generation and ignores an obsolete measured request',async()=>{
  const a=offlineGuardHarness(memorySample({availableMemoryBytes:GIB-1}));
  a.runtime.resourceBusy=true; // A busy periodic watcher cannot skip the request/ready guard.
  await assert.rejects(a.runtime.checkQwen80SSDRequestResources(a.child,'owned-trial',spec),(e:any)=>e.code==='SSD_MEMORY_GUARD_FAILED');
  assert.deepEqual(a.killed,[101]);
  const b=offlineGuardHarness();b.runtime.resourceSample=async()=>{
    b.runtime.child={pid:202};b.runtime.status.experimentalTrial={id:'new-trial',model:spec.id,state:'passed'};
    return memorySample({pressure:'warning'});
  };
  await assert.rejects(b.runtime.checkQwen80SSDRequestResources(b.child,'owned-trial',spec));
  assert.deepEqual(b.killed,[]);assert.deepEqual(b.events,[]);assert.equal(b.runtime.child.pid,202);
});
test('stale Qwen watchdog samples cannot fail or stop a later trial',async()=>{
  const {runtime,child,events,killed}=offlineGuardHarness();
  runtime.resourceSample=async()=>{runtime.child={pid:202};runtime.status.experimentalTrial={id:'new-trial',model:spec.id,state:'passed'};return memorySample({pressure:'warning'});};
  await runtime.watchResources(child);assert.deepEqual(events,[]);assert.deepEqual(killed,[]);
  assert.equal(runtime.status.experimentalTrial.state,'passed');assert.equal(runtime.child.pid,202);
});
test('synchronous stop notification, failed update or cancellation replacement is never terminated',async()=>{
  for(const phase of ['notification','failed-update','abort']){
    const {runtime,child,killed}=offlineGuardHarness(),replacement={pid:202};
    const newController=new AbortController();
    const replace=()=>{runtime.child=replacement;runtime.status.experimentalTrial={id:'new-trial',model:spec.id,state:'passed'};runtime.prepared={sourceModel:spec.id,new:true};runtime.trialController=newController;};
    if(phase==='notification')runtime.emit=replace;
    else if(phase==='failed-update')runtime.update=(change:any)=>{runtime.status={...runtime.status,...change};if(change.experimentalTrial?.state==='failed')replace();};
    else runtime.trialController.signal.addEventListener('abort',replace,{once:true});
    await runtime.watchResources(child);assert.deepEqual(killed,[]);assert.equal(runtime.child,replacement);
    assert.equal(runtime.status.experimentalTrial.state,'passed');assert.equal(runtime.prepared.new,true);assert.equal(newController.signal.aborted,false);
  }
});
test('Qwen SSD queued telemetry cannot populate a replacement or continue after synchronous ownership change',()=>{
  const {runtime,child}=offlineGuardHarness(),replacement={pid:202};
  runtime.ssdManifest={patchSha256:QWEN80_SSD_WORKER_PATCH};runtime.ssdPartialLog='';runtime.ssdStatus=null;
  const line=(marker:number)=>'SSD_STATUS '+JSON.stringify({baseCommit:SSD_BASE_COMMIT,patchSha256:QWEN80_SSD_WORKER_PATCH,marker})+'\n';
  assert.equal(runtime.captureOwnedQwen80SSDStatus(replacement,'owned-trial',line(1)),false);assert.equal(runtime.ssdStatus,null);
  assert.equal(runtime.captureOwnedQwen80SSDStatus(child,'stale-trial',line(2)),false);assert.equal(runtime.ssdStatus,null);
  assert.equal(runtime.captureOwnedQwen80SSDStatus(child,'owned-trial',line(3)),true);assert.equal(runtime.ssdStatus.marker,3);
  runtime.update=(change:any)=>{runtime.status={...runtime.status,...change};runtime.child=replacement;runtime.status.experimentalTrial={id:'new-trial',model:spec.id,state:'loading'};runtime.ssdStatus=null;};
  assert.equal(runtime.captureOwnedQwen80SSDStatus(child,'owned-trial',line(4)+line(5)),false);
  assert.equal(runtime.ssdStatus,null);assert.equal(runtime.status.experimentalTrial.streaming,undefined);
});
test('new trial installed while owned shutdown settles retains its status and prepared model',async()=>{
  const {runtime,child,killed}=offlineGuardHarness(),replacement={pid:202};
  runtime.terminateChild=async()=>{killed.push(child.pid);runtime.child=replacement;runtime.status.experimentalTrial={id:'new-trial',model:spec.id,state:'passed'};runtime.prepared={new:true};};
  await runtime.watchResources(child);assert.deepEqual(killed,[101]);assert.equal(runtime.child,replacement);
  assert.equal(runtime.status.experimentalTrial.state,'passed');assert.equal(runtime.prepared.new,true);
});

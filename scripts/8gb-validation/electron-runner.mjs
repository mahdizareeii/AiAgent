/** Fresh serial driver for the real built Electron app. The8GB suite requires
 * an actual8GB OS; explicit physical24GiB context diagnostics remain separate
 * and ineligible for8GB support. No adapter replaces production inference. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile, appendFile, open, unlink, readlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import { actualEightGBHost, actualHostContextDiagnostic, fixturePermission, quoteCommand, scoreEightGBCase, profileFromPortablePlan, hostDiagnosticStatusPlan, builtMainDigest } from './driver-support.ts';
import { eightGBAssets } from './assets.ts';
import { verifyEightGBFixture, localOnlyOracleExecutor } from './oracles.ts';
import { EIGHT_GB_PROTOCOL, EIGHT_GB_FIXTURES, EIGHT_GB_SUITE_DIGEST, EIGHT_GB_ACCEPTANCE_PROMPT, inspectEightGBEvidence, evaluateEightGBComparison, rankEightGBCandidates } from './protocol.ts';
import { MODEL_CATALOG } from '../../local-agent/runtime/catalog.ts';
import { PORTABLE_CPU_PROFILE } from '../../local-agent/runtime/portable-admission.ts';
import { probeResourceMeasurements } from '../../local-agent/runtime/memory.ts';
import { LOCAL_ONLY_COMMAND_PROFILE } from '../../local-agent/desktop/actions.ts';
import { installDriverInterruption } from './driver-signals.ts';
import { createGuestWorkRoot, captureProfileEvidence, exportRunEvidence } from './local-storage.ts';
import driverModes from './driver-mode.cjs';
const { CONTEXT_DIAGNOSTIC, HOST_CONTEXT_DIAGNOSTIC, DIAGNOSTIC_MODEL_IDS, HOST_DIAGNOSTIC_MODEL_IDS,
  selectDriverFixtures, markDriverReport, diagnosticComparison, validateHostHardwareEvidence, observedNativeSamples } = driverModes;

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const executeFile = promisify(execFile);
const interruption=installDriverInterruption(),pipeline={out:null,launches:[],reports:[]};
async function json(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function hashFile(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function boundedJSON(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 ** 2) throw new Error('Evidence JSON must be a bounded ordinary file.'); return JSON.parse(await readFile(file, 'utf8')); }
async function inventory(roots, toolRoot=null) {
  const rows = [];
  async function visit(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) { const relative=toolRoot?path.relative(toolRoot,file):'..';if(!toolRoot||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error(`A frozen app/source inventory path is a symlink: ${file}`);const target=await realpath(file),targetRelative=path.relative(toolRoot,target);if(targetRelative==='..'||targetRelative.startsWith('..'+path.sep)||path.isAbsolute(targetRelative))throw new Error('A standalone tool symlink escapes its frozen dedicated root.');rows.push({path:file,kind:'internal-tool-symlink',target:await readlink(file),resolvedTarget:target});return; }
    if (info.isDirectory()) { for (const name of (await readdir(file)).sort()) { if (name==='.git' || !toolRoot && ['.venv','__pycache__','node_modules'].includes(name)) continue; await visit(path.join(file,name)); } }
    else if (info.isFile()) { if (/\.gguf(?:\.|$)/i.test(file)) throw new Error('Weight payloads do not belong in the source/resource inventory.'); if (rows.length >= 30_000) throw new Error('Frozen inventory exceeded its file bound.'); rows.push({ path:file,bytes:info.size,sha256:await hashFile(file) }); }
    else throw new Error(`Nonordinary inventory path: ${file}`);
  }
  for (const file of [...new Set(roots)].sort()) await visit(file);
  return { digest:digest(JSON.stringify(rows)), files:rows };
}
function argumentsMap(argv) {
  const result = new Map();
  for (let i=0;i<argv.length;i++) { const key=argv[i]; if (!key.startsWith('--') || result.has(key)) throw new Error('Use unique named driver arguments.'); if (['--execute','--preflight-only','--context-diagnostic','--host-context-diagnostic'].includes(key)) result.set(key,true); else { if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Missing ${key} value.`); result.set(key,argv[++i]); } }
  const allowed = ['--execute','--preflight-only','--context-diagnostic','--host-context-diagnostic','--environment','--hardware-evidence','--models-dir','--app','--electron','--python','--tools-root','--out'];
  if ([...result.keys()].some(key=>!allowed.includes(key))) throw new Error('Unknown driver argument; no memory/profile/timeout overrides are accepted.');
  if(result.has('--context-diagnostic')&&result.has('--host-context-diagnostic'))throw new Error('Context diagnostic modes are mutually exclusive.');
  return result;
}
async function preflight(args) {
  const runMode=args.has('--host-context-diagnostic')?HOST_CONTEXT_DIAGNOSTIC:args.has('--context-diagnostic')?CONTEXT_DIAGNOSTIC:undefined;
  const host=runMode===HOST_CONTEXT_DIAGNOSTIC?await actualHostContextDiagnostic():actualEightGBHost();let networkPolicy={checked:false,reason:'Actual whole-OS capacity/target gate did not admit a local policy probe.'};
  if(host.available)try{const probe=await localOnlyOracleExecutor.execute([process.execPath,'-e','process.stdout.write("EIGHT_GB_LOCAL_POLICY_READY")'],root);if(probe.code!==0||probe.signal!==null||probe.output!=='EIGHT_GB_LOCAL_POLICY_READY')throw new Error('The actual local policy probe failed.');networkPolicy={checked:true,code:probe.code,signal:probe.signal,output:probe.output};}catch(error){host.available=false;host.networkIsolationAvailable=false;host.reason=String(error);networkPolicy={checked:true,error:String(error)};}
  const result={schemaVersion:1,observedAt:iso(),protocolId:runMode===HOST_CONTEXT_DIAGNOSTIC?HOST_CONTEXT_DIAGNOSTIC:EIGHT_GB_PROTOCOL.id,suiteDigest:EIGHT_GB_SUITE_DIGEST,...(runMode?{runMode}:{}),host,networkPolicy,available:host.available,appLoaded:false,modelLoaded:false,inferenceStarted:false,qualified:false,supportClaimEstablished:false};
  if (args.has('--preflight-only')) { process.stdout.write(JSON.stringify(result,null,2)+'\n'); return null; }
  if (!args.has('--execute')) throw new Error('Use --preflight-only, or explicit --execute after source/package freeze.');
  if (!host.available) { process.stdout.write(JSON.stringify(result,null,2)+'\n'); throw new Error(host.reason); }
  for (const key of ['--environment','--hardware-evidence','--models-dir','--app','--electron','--python','--tools-root','--out']) if (!args.has(key)) throw new Error(`Required ${key}.`);
  const environment=args.get('--environment'); if (!['physical','whole-os-vm'].includes(environment)) throw new Error('Declare actual physical or whole-OS VM evidence; process-limited execution is excluded.');
  const evidencePath=await realpath(args.get('--hardware-evidence')), evidence=await boundedJSON(evidencePath);
  if (evidence.environment!==environment || evidence.memoryScope!=='whole-os' || typeof evidence.description!=='string' || !evidence.description.trim()) throw new Error('The retained hardware declaration must identify the physical/whole-OS VM and memory scope. Actual OS capacity remains authoritative.');
  if(runMode===HOST_CONTEXT_DIAGNOSTIC)validateHostHardwareEvidence(evidence,host);
  const out=path.resolve(args.get('--out')); await mkdir(out,{mode:0o700});
  await json(path.join(out,'preflight.json'),{...result,environment,evidencePath,evidenceSha256:await hashFile(evidencePath)});
  return {host,environment,evidencePath,out:await realpath(out),...(runMode?{runMode}:{}),toolsDirectory:await realpath(args.get('--tools-root')),modelsDirectory:await realpath(args.get('--models-dir')),appPath:await realpath(args.get('--app')),electron:await realpath(args.get('--electron')),python:await realpath(args.get('--python'))};
}
async function binding(config) {
  const source=await inventory([path.join(root,'local-agent/desktop'),path.join(root,'local-agent/runtime'),path.join(root,'local-agent/research/local_agent_research'),here,path.join(root,'package.json'),path.join(root,'package-lock.json')]);
  const resources=await inventory(config.appPath.endsWith('.asar') ? [path.dirname(config.appPath),config.toolsDirectory] : [config.toolsDirectory,path.join(config.appPath,'dist'),path.join(config.appPath,'resources/inference'),path.join(config.appPath,'resources/goose'),path.join(config.appPath,'local-agent/research/dist/local-agent-research')],config.toolsDirectory);
  const electronRelative=path.relative(config.toolsDirectory,config.electronBundle),electronAlreadyBound=electronRelative!== '..'&&!electronRelative.startsWith('..'+path.sep)&&!path.isAbsolute(electronRelative);
  const electronRuntime=electronAlreadyBound?{includedInToolsBinding:true,root:config.electronBundle}:await inventory([config.electronBundle],config.electronBundle);
  return {source,resources:{digest:digest(JSON.stringify([resources.digest,electronRuntime])),appAndTools:resources,electronRuntime},mainSha256:await builtMainDigest(config.appPath)};
}
const controlAsset = {id:'live-browse-control',files:{},protectedFiles:[],commands:[],oracle:{language:'node',source:"const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');assert.equal(fs.readFileSync(path.join(process.argv[2],'undo-a.txt'),'utf8'),'Owned conversation A.\\n');console.log('EIGHT_GB_INDEPENDENT_PASS');\n"}};

const stopControlAsset={id:'live-stop-control',files:{},protectedFiles:[],commands:[],oracle:{language:'node',source:"const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');assert.equal(fs.existsSync(path.join(process.argv[2],'should-not-exist.txt')),false);console.log('EIGHT_GB_INDEPENDENT_PASS');\n"}};

async function modelRun(config, bound, model) {
  interruption.throwIfInterrupted();
  const runId=randomUUID(), sharedRunDirectory=path.join(config.out,model.id.replaceAll(':','-')), nonce=randomUUID(); await mkdir(sharedRunDirectory,{mode:0o700});let runDirectory=sharedRunDirectory;
  const modelFile=path.join(config.modelsDirectory,model.filename);
  try{const fileInfo=await lstat(modelFile);if(!fileInfo.isFile()||fileInfo.isSymbolicLink()||fileInfo.size!==model.estimatedDownloadBytes)throw new Error('The local artifact is not an ordinary complete pinned-size file.');}
  catch(error){const report=markDriverReport({schemaVersion:1,protocolId:EIGHT_GB_PROTOCOL.id,suiteDigest:EIGHT_GB_SUITE_DIGEST,runId,modelId:model.id,classification:'not-admitted-before-app-start',complete:false,errors:[String(error)],completedAt:iso(),appLoaded:false,modelLoaded:false,inferenceStarted:false,ownedProcessesStopped:true,qualified:false,supportClaimEstablished:false},config.runMode);await json(path.join(runDirectory,'report.json'),report);return report;}
  const fixtures=selectDriverFixtures(eightGBAssets(process.execPath,config.python).map(asset=>({...asset,request:EIGHT_GB_FIXTURES.find(f=>f.id===asset.id).request,commands:asset.commands.map(command=>({...command,text:quoteCommand(command.argv)}))})),config.runMode);
  const initial=await probeResourceMeasurements(null,'darwin');
  const coldStartedAt=iso(),workRoot=await createGuestWorkRoot(runId);runDirectory=workRoot.runDirectory;await json(path.join(sharedRunDirectory,'guest-work-root.json'),workRoot);
  const plan={schemaVersion:1,nonce,environment:config.environment,runId,runDirectory,workRoot,sharedRunDirectory,appPath:config.appPath,mainSha256:bound.mainSha256,resourceProbe:path.join(config.appPath.endsWith('.asar')?path.dirname(config.appPath):path.join(config.appPath,'resources'),'inference/metal/agent-memory-sample'),profileDirectory:workRoot.profileDirectory,model:{id:model.id,file:modelFile,sha256:model.sha256},coldStartedAt,limitMs:EIGHT_GB_PROTOCOL.maximumAcceptanceLatencyMs,acceptancePrompt:EIGHT_GB_ACCEPTANCE_PROMPT,fixtures,allowedWorkspaces:[],stopControl:{...stopControlAsset,request:'Create should-not-exist.txt with exactly the text Stop must prevent this change. Use file tools only.'},control:{...controlAsset,request:'Create undo-a.txt containing exactly "Owned conversation A.\\n" including one actual final LF, then read it and report the actual verified result. Use file tools only.'}};
  if(config.runMode)plan.runMode=config.runMode;
  if(config.runMode===HOST_CONTEXT_DIAGNOSTIC)plan.hostContextHardware=config.host;
  const planFile=path.join(runDirectory,'plan.json'); await json(planFile,plan);
  const eventsPath=path.join(runDirectory,'raw-events.jsonl'),sharedEventsPath=path.join(sharedRunDirectory,'raw-events.jsonl');await writeFile(eventsPath,'',{flag:'wx',mode:0o600});await writeFile(sharedEventsPath,'',{flag:'wx',mode:0o600});
  let logBytes=0, logChain=Promise.resolve(), eventFailure=null;
  function record(type,value) { const line=JSON.stringify({observedAt:iso(),type,value})+'\n'; if (Buffer.byteLength(line)>512*1024 || (logBytes+=Buffer.byteLength(line))>128*1024**2) { if(!eventFailure){eventFailure='Bounded raw event retention exceeded; this incomplete attempt must stop.';queueMicrotask(()=>stopOwned('raw retention cap exceeded'));}return; } logChain=logChain.then(async()=>{await appendFile(eventsPath,line);await appendFile(sharedEventsPath,line);}).catch(error=>{if(!eventFailure){eventFailure=String(error);queueMicrotask(()=>stopOwned('raw retention write failed'));}}); }
  const nativeSamples=new Map();
  function nativeSample(pid) { const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{nativeSamples.delete(id);reject(new Error('Actual owned native sample timed out.'));},2000);nativeSamples.set(id,{resolve,reject,timer});child.send({type:'sample-owned',nonce,id,pid});}); }
  const contexts=new Map(), cases=[], latencies=[], samples=[], statuses=[], modelChildren=[], tracked=new Map(), sandboxedCommands=[];
  const runAbort=new AbortController();let controllerExited=false;
  let forcedDrainTimer=null;
  let child, current=null, readyPlan=null, finalStatus=null, finished=false, runError=null, drain=null, lastNative=null, sampling=false, memoryError=null, caseTimer=null, controls=null, modelStoppedAt=null;
  function stopOwned(reason) {
    runAbort.abort(new Error(reason));record('stop-request',{reason,controllerPid:child?.pid});if(controllerExited)return;if(child?.connected)child.send({type:'stop',nonce});
    if(forcedDrainTimer||!child?.pid)return;
    forcedDrainTimer=setTimeout(()=>void(async()=>{
      runError??='Actual app did not finish its bounded owned drain.';
      // PIDs are acted on only after a fresh complete-argv and direct-parent check.
      for(const owned of [...tracked.values()].reverse())try{const result=await executeFile('/bin/ps',['-o','ppid=','-o','command=','-p',String(owned.pid)],{timeout:1000,maxBuffer:16384});const match=result.stdout.trim().match(/^(\d+)\s+([\s\S]*)$/);if(match&&Number(match[1])===child.pid&&match[2]===[owned.executable,...owned.arguments].join(' ')){record('forced-owned-stop',{pid:owned.pid,proof:match[0]});process.kill(owned.pid,'SIGKILL');}}catch{}
      try{const result=await executeFile('/bin/ps',['-o','ppid=','-o','command=','-p',String(child.pid)],{timeout:1000,maxBuffer:16384});const match=result.stdout.trim().match(/^(\d+)\s+([\s\S]*)$/);if(match&&Number(match[1])===process.pid&&match[2].includes(planFile)&&match[2].includes('electron-runner.cjs')){record('forced-controller-stop',{pid:child.pid,proof:match[0]});process.kill(child.pid,'SIGKILL');}}catch{}
    })(),25_000);
  }
  async function sample() {
    if (sampling) {if(samples.length&&Date.now()-Date.parse(samples.at(-1).sampledAt)>EIGHT_GB_PROTOCOL.maximumSampleGapMs){memoryError??='Actual continuous memory sample freshness exceeded its frozen bound.';stopOwned('stale resource sample');}return;}sampling=true;
    try {
      const owned=modelChildren.find(row=>!row.completedAt), pid=owned?.pid??null;
      const raw=await probeResourceMeasurements(pid,'darwin');
      if (pid) { const identity=await executeFile('/bin/ps',['-o','ppid=','-p',String(pid)],{timeout:1000,maxBuffer:1024}); if (Number(identity.stdout.trim())!==child.pid) throw new Error('Current model parent identity no longer matches the owned Electron process.'); }
      const actualNative=pid?await nativeSample(pid):null;
      if(pid&&(!actualNative||actualNative.pid!==pid||actualNative.parentPid!==child.pid||!Number.isSafeInteger(actualNative.rssBytes)||actualNative.rssBytes<=0||!Number.isSafeInteger(actualNative.physicalFootprintBytes)||actualNative.physicalFootprintBytes<=0||Math.abs(Date.now()-actualNative.sampledAtMilliseconds)>2000))throw new Error('A fresh actual owned RSS/physical-footprint sample is required.');
      const foot=actualNative?.physicalFootprintBytes;
      const rssBytes=actualNative?.rssBytes??0;
      const row={sampledAt:actualNative?new Date(actualNative.sampledAtMilliseconds).toISOString():raw.sampledAt,pid,parentPid:pid?child.pid:null,rssBytes,...(Number.isSafeInteger(foot)&&foot>0?{physicalFootprintBytes:foot}:{}),residentBytes:Math.max(rssBytes,foot??0),availableMemoryBytes:raw.availableMemoryBytes,pressure:raw.pressure};
      samples.push(row);record('memory',{...row,hostSource:'vm_stat+memorystatus+ps',nativeFootprint:actualNative,hostSampledAt:raw.sampledAt});
      if (samples.length>50_000 || raw.pressure!=='normal' || raw.availableMemoryBytes<EIGHT_GB_PROTOCOL.minimumAvailableBytes || readyPlan&&row.residentBytes>readyPlan.workingBytes) throw new Error('Actual resource monitoring exceeded its frozen bound.');
    } catch(error) { memoryError??=String(error); record('monitor-error',memoryError); stopOwned('resource monitor failure'); }
    finally { sampling=false; }
  }
  // Initial actual host sample precedes all preparation and the cold clock.
  // coldStartedAt precedes local APFS allocation/attestation and plan persistence;
  // all of that preparation is included in the inclusive acceptance latency.
  samples.push({...initial,pid:null,parentPid:null,rssBytes:0,residentBytes:0}); record('memory',samples[0]);
  interruption.throwIfInterrupted();
  child=spawn(config.electron,[path.join(here,'electron-runner.cjs'),`--eightgb-plan=${planFile}`,`--user-data-dir=${plan.profileDirectory}`,...(config.runMode===HOST_CONTEXT_DIAGNOSTIC?['--host-context-diagnostic']:[])],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],detached:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const controllerPid=child.pid; if (!controllerPid) throw new Error('Real Electron did not start.');
  pipeline.launches.push({modelId:model.id,pid:controllerPid,startedAt:iso()});
  const releaseSignalOwner=interruption.bindStop(value=>{record('parent-interruption',value);stopOwned(`Parent interrupted by ${value.signal}.`);});
  record('electron-start',{pid:controllerPid,parentPid:process.pid,executable:config.electron,args:child.spawnargs,planFile});
  for (const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]]) stream.on('data',chunk=>record('electron-output',{stream:name,text:chunk.toString('utf8')}));
  const monitor=setInterval(()=>void sample(),1000);
  const wholeTimer=setTimeout(()=>{runError??='Whole fresh serial run exceeded its exact aggregate deadline.';stopOwned('driver failure or deadline');},(40*EIGHT_GB_PROTOCOL.caseBudgetMs)+(38*30_000)+120_000);
  async function handle(message) {
    if (message?.nonce!==nonce || typeof message.type!=='string') return;
    const value=message.value;record(message.type,value);
    if (message.type==='case-begin') { if(current)throw new Error('Overlapping actual case contexts.'); current={...value,events:[],permissions:[],sandboxedCommands:[]};contexts.set(value.key,current);clearTimeout(caseTimer);const remaining=EIGHT_GB_PROTOCOL.caseBudgetMs-(Date.now()-Date.parse(value.startedAt));caseTimer=setTimeout(()=>{current.timedOut=true;stopOwned('driver failure or deadline');},Math.max(0,remaining)+100); }
    else if (message.type==='host-event') { const ctx=contexts.get(value.key);if(ctx){if(ctx.events.length>=4000)throw new Error('Case raw-event join bound exceeded.');ctx.events.push(value.event);} }
    else if (message.type==='child-start') { if(value.pid)tracked.set(value.pid,value);if(value.role==='model'){if(modelChildren.length)throw new Error('Duplicate/restarted owned model process.');modelChildren.push(value);}if(value.executable==='/usr/bin/sandbox-exec'&&value.arguments?.[0]==='-p'&&value.arguments[1]===LOCAL_ONLY_COMMAND_PROFILE&&value.arguments[2]==='/bin/sh'&&value.arguments[3]==='-c'){sandboxedCommands.push(value.arguments[4]);if(current)current.sandboxedCommands.push(value.arguments[4]);} }
    else if (message.type==='child-exit') { tracked.delete(value.pid);const owned=modelChildren.find(row=>row.pid===value.pid);if(owned){Object.assign(owned,value);modelStoppedAt=value.completedAt;if(!value.deliberateFinalStop){runError??='Owned model exited before deliberate final drain; no restart permitted.';stopOwned('driver failure or deadline');}} }
    else if (message.type==='native-memory')lastNative=value;
    else if (message.type==='status-sample') { const previous=statuses.at(-1);if(!previous||JSON.stringify([previous.status.runtime.state,previous.status.runtime.loadedModel,previous.status.runtime.errorCode])!==JSON.stringify([value.status.runtime.state,value.status.runtime.loadedModel,value.status.runtime.errorCode])||value.status.runtime.portableMemoryPlan){if(statuses.length>=128)throw new Error('Status transition retention bound exceeded.');statuses.push(value);}if(config.runMode===HOST_CONTEXT_DIAGNOSTIC&&value.status.runtime.ready&&value.status.runtime.loadedModel){hostDiagnosticStatusPlan(value.status.runtime,model.id,readyPlan??undefined);}if(readyPlan&&value.status.runtime.portableMemoryPlanDigest&&value.status.runtime.portableMemoryPlanDigest!==digest(JSON.stringify(readyPlan)))throw new Error('Actual allocation plan digest changed.');if(value.status.runtime.portableMemoryPlan){const actual=value.status.runtime.portableMemoryPlan;if(readyPlan&&JSON.stringify(readyPlan)!==JSON.stringify(actual))throw new Error('Actual portable allocation binding changed within one run.');readyPlan=actual;} }
    else if (message.type==='permission') { const ctx=contexts.get(value.key);if(!ctx)throw new Error('Approval has no actual current case.');const asset=ctx.fixtureId==='live-browse-control'?controlAsset:ctx.fixtureId==='live-stop-control'?stopControlAsset:fixtures.find(row=>row.id===ctx.fixtureId);const decision=await fixturePermission({asset,workspace:ctx.workspace,sessionId:ctx.sessionId,request:value.request});child.send({type:'response',id:message.id,nonce,value:decision}); }
    else if (message.type==='permission-response') { const ctx=contexts.get(value.key);if(ctx){if(ctx.permissions.length>=128)throw new Error('Approval join bound exceeded.');ctx.permissions.push(value);} }
    else if (message.type==='case-end') {
      clearTimeout(caseTimer);caseTimer=null;const ctx=contexts.get(value.key);if(!ctx||current!==ctx)throw new Error('Terminal case does not match its real owner.');
      await json(path.join(runDirectory,`${value.key}-actual.json`),value);
      const observedPlan=value.result?.status?.runtime?.portableMemoryPlan;if(observedPlan){if(readyPlan&&JSON.stringify(readyPlan)!==JSON.stringify(observedPlan))throw new Error('Actual terminal portable plan changed.');readyPlan=observedPlan;}
      if(value.kind==='acceptance') { const outcome=[...(value.result.loaded.messages??[])].reverse().find(row=>row.role==='assistant'&&row.outcome)?.outcome;latencies.push({phase:value.phase,prompt:EIGHT_GB_ACCEPTANCE_PROMPT,requestedAt:value.requestedAt,verificationStartedAt:value.verificationStartedAt,verifiedAt:value.verifiedAt,preparedAt:value.preparedAt,completedAt:value.completedAt,answer:value.answer,normalizedAnswer:typeof value.answer==='string'?value.answer.trim():null,normalization:EIGHT_GB_PROTOCOL.acceptanceAnswerNormalization,preparedAtSource:value.preparedAtSource});if(outcome?.status!=='completed'||outcome.finishReason!=='end_turn'||value.result.timedOut||value.result.error||typeof value.answer!=='string'||value.answer.trim()!=='42')throw new Error('Actual short-answer acceptance failed its normal outcome/exact answer/deadline.');child.send({type:'response',id:message.id,nonce,value:{retained:true}}); }
      else { const asset=ctx.fixtureId==='live-browse-control'?controlAsset:ctx.fixtureId==='live-stop-control'?stopControlAsset:fixtures.find(row=>row.id===ctx.fixtureId);const oracle=await verifyEightGBFixture({fixture:asset,workspace:value.workspace,hiddenDirectory:path.join(runDirectory,`${value.key}-independent`),nodeExecutable:process.execPath,pythonExecutable:config.python,executor:localOnlyOracleExecutor,signal:runAbort.signal});
        const postimages=[];for(const relative of ctx.fixtureId==='bounded-retrieval'?['config.json']:ctx.fixtureId==='unicode-edit'?['greeting.txt']:[]){try{const file=path.join(value.workspace,relative),info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink()&&info.size<=2*1024**2)postimages.push({path:file,sha256:await hashFile(file),bytes:info.size});}catch{}}
        if(value.kind!=='control'){const row=scoreEightGBCase({fixtureId:ctx.fixtureId,repeat:ctx.repeat,startedAt:ctx.startedAt,completedAt:value.result.completedAt,request:ctx.request,loaded:value.result.loaded,events:ctx.events,permissions:ctx.permissions,oracle,commands:ctx.commands,timedOut:!!value.result.timedOut||!!ctx.timedOut,sandboxedCommands:ctx.sandboxedCommands,postimages});cases.push(row);await json(path.join(runDirectory,`${value.key}-score.json`),row);}else controls={...controls,[ctx.fixtureId==='live-stop-control'?'stop':'browse']:{actual:value.liveBrowse??value.liveStop,oracle}};
        child.send({type:'response',id:message.id,nonce,value:{oraclePassed:oracle.passed}});
      }
      contexts.delete(value.key);current=null;
    }
    else if(message.type==='live-controls-result')controls={...controls,browse:{...controls?.browse,result:value}};
    else if(message.type==='live-stop-result')controls={...controls,stop:{...controls?.stop,result:value}};
    else if(message.type==='run-finished'){finished=true;finalStatus=value.status;}
    else if(message.type==='owned-final-drain')drain=value;
    else if(['run-error','bootstrap-error','driver-error'].includes(message.type)){runError??=typeof value==='string'?value:JSON.stringify(value);stopOwned('driver failure or deadline');}
  }
  let handling=Promise.resolve();child.on('message',message=>{if(message?.nonce!==nonce)return;if(message.type==='sample-response'){record(message.type,message.value);const request=nativeSamples.get(message.value?.id);if(request){nativeSamples.delete(message.value.id);clearTimeout(request.timer);message.value.error?request.reject(new Error(message.value.error)):request.resolve(message.value.value);}return;}if(['child-start','child-exit','native-memory','owned-final-drain'].includes(message.type)){void handle(message).catch(error=>{runError??=String(error);record('parent-driver-error',runError);stopOwned('driver failure or deadline');});return;}handling=handling.then(()=>handle(message)).catch(error=>{runError??=String(error);record('parent-driver-error',runError);stopOwned('driver failure or deadline');});});
  const exit=await new Promise(resolve=>{child.once('error',error=>{runError??=String(error);});child.once('close',(code,signal)=>{controllerExited=true;resolve({code,signal,completedAt:iso()});});});
  clearInterval(monitor);clearTimeout(wholeTimer);clearTimeout(caseTimer);clearTimeout(forcedDrainTimer);await handling;while(sampling)await sleep(20);await sample();await logChain;
  await json(path.join(runDirectory,'actual-status-transitions.json'),statuses);await json(path.join(runDirectory,'actual-memory.json'),samples);await json(path.join(runDirectory,'actual-children.json'),{controllerPid,modelChildren,remaining:[...tracked.values()],drain,exit});await json(path.join(runDirectory,'live-controls.json'),controls);
  const allocationPath=path.join(runDirectory,'actual-portable-allocation.json');await json(allocationPath,readyPlan);
  let storageCapture=null,storageError=null;try{storageCapture=await captureProfileEvidence(workRoot,!!drain&&!drain.remainingChildren.length&&!tracked.size);}catch(error){storageError=String(error);await json(path.join(runDirectory,'guest-capture-error.json'),{error:storageError,workRoot,originalsRetainedLocally:true});}
  const browseControls=controls?.browse?.result,stopControls=controls?.stop?.result;
  const requiredControls=browseControls&&stopControls&&['actual','actualRendererStop','approvalsCancelled','ownerDrained','workspaceBUntouched','actualOraclePassed','actualCancelledOutcome'].every(key=>stopControls[key]===true)&&['actualOraclePassedBeforeUndo','workspaceBUntouched','undoBDidNotTouchA','undoAChangedOnlyOwnFile','rejectedSend','rejectedUndoA','rejectedUndoB','runningModelUnchanged','actualRendererNavigation','rendererPermissionVisible'].every(key=>browseControls[key]===true);
  const errors=[runError,memoryError,eventFailure,storageError,...(interruption.first?[`Parent interrupted by ${interruption.first.signal}.`]:[]),...(!finished?['Actual serial model run did not finish.']:[]),...(exit.code!==0||exit.signal?['Actual Electron exit was not0.']:[]),...(!drain||drain.remainingChildren.length||tracked.size?['Actual owned final drain is incomplete.']:[]),...(!config.runMode&&!requiredControls?['Actual live background/undo control evidence is incomplete.']:[])].filter(Boolean);
  const owned=modelChildren[0],profile=readyPlan?profileFromPortablePlan(readyPlan):null;
  const evidence={complete:errors.length===0,errors,driver:{id:'real-electron-v1',controllerExit:{code:exit.code,signal:exit.signal},controlsPassed:!!requiredControls,rawEventsPath:eventsPath,liveControlsPath:path.join(runDirectory,'live-controls.json')},schemaVersion:1,protocolId:EIGHT_GB_PROTOCOL.id,suiteDigest:EIGHT_GB_SUITE_DIGEST,runId,modelId:model.id,completedAt:iso(),publicNetwork:false,syntheticProvider:false,ownedProcessesStopped:!!drain&&!drain.remainingChildren.length&&!tracked.size,lateFatal:!!runError||!!memoryError,sourceBinding:bound.source.digest,resourceBinding:bound.resources.digest,modelDigest:readyPlan?.modelDigest,engineDigest:readyPlan?.engineDigest,templateDigest:readyPlan?.templateDigest,profile,hardware:{target:config.host.target,memoryScope:'whole-os',environment:config.environment,installedMemoryBytes:config.host.totalMemoryBytes,totalMemoryBytes:config.host.totalMemoryBytes,osRelease:config.host.osRelease,evidencePath:config.evidencePath},latencies,monitoring:{startedAt:samples[0].sampledAt,completedAt:samples.at(-1).sampledAt,modelSpawnedAt:owned?.startedAt,modelStoppedAt,childPid:owned?.pid,controllerPid,allocationWorkingBytes:readyPlan?.workingBytes,allocationEvidencePath:allocationPath,samples},cases};
  if(!config.runMode)try{inspectEightGBEvidence(evidence);}catch(error){errors.push(String(error));}
  const report=markDriverReport({...evidence,sharedRawEventsPath:sharedEventsPath,storageExport:{complete:!!storageCapture&&!storageError,postDrainManifest:path.join(sharedRunDirectory,'post-drain-export.json'),localWorkRoot:workRoot,error:storageError,originalsRetainedLocally:true},classification:interruption.first?'interrupted':modelChildren.length?'attempted': 'not-admitted-before-model-spawn',interruption:interruption.first,complete:errors.length===0,errors,rawEventsPath:eventsPath,rawLimitBytes:128*1024**2,actualFinalStatus:finalStatus,...(config.runMode?{diagnosticScheduleFinished:finished}:{}),...(config.runMode===HOST_CONTEXT_DIAGNOSTIC?{hostContextObservations:{actualHardware:config.host,nativeSamples:observedNativeSamples(samples,owned?.pid,controllerPid),nativeCountsSource:'Retained raw native-output and actual task outcomes/errors; no inferred token counts.',eightGBSupport:false,qualityClaim:false}}:{}),qualified:false,supportClaimEstablished:false,requiresIndependentRawReview:true},config.runMode);await json(path.join(runDirectory,'report.json'),report);try{await exportRunEvidence(workRoot,sharedRunDirectory,!!drain&&!drain.remainingChildren.length&&!tracked.size);}catch(error){await json(path.join(sharedRunDirectory,'guest-export-error.json'),{error:String(error),workRoot,originalsRetainedLocally:true});throw error;}pipeline.reports.push(path.join(sharedRunDirectory,'report.json'));releaseSignalOwner();return report;
}
async function main() {
  const args=argumentsMap(process.argv.slice(2)),config=await preflight(args);if(!config)return;
  pipeline.out=config.out;interruption.throwIfInterrupted();
  await access(config.electron);await access(config.python);
  config.electronBundle=path.resolve(path.dirname(config.electron),'../..');
  if(!config.electronBundle.endsWith('.app'))throw new Error('Use the standalone Electron.app shell, not the packaged application executable.');
  await access(path.join(config.electronBundle,'Contents/Resources/default_app.asar'));
  try{await access(path.join(config.electronBundle,'Contents/Resources/app.asar'));throw new Error('Packaged executables cannot load this external main bootstrap. Use the standalone Electron shell.');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const executable of [await realpath(process.execPath),config.python]){const relative=path.relative(config.toolsDirectory,executable);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Actual standalone Node and Python must both be inside the frozen dedicated tools root.');}
  const lockFile=path.join(tmpdir(),'free-local-agent-eightgb-validation.lock'),lockNonce=randomUUID(),lock=await open(lockFile,'wx',0o600);await lock.writeFile(JSON.stringify({nonce:lockNonce,pid:process.pid,executable:process.execPath,arguments:process.argv,out:config.out}));await lock.close();
  try {
  const bound=await binding(config);await json(path.join(config.out,'frozen-binding.json'),bound);
  const models=config.runMode?(config.runMode===HOST_CONTEXT_DIAGNOSTIC?HOST_DIAGNOSTIC_MODEL_IDS:DIAGNOSTIC_MODEL_IDS).map(id=>{const model=MODEL_CATALOG.find(row=>row.id===id);if(!model)throw new Error('A fixed diagnostic model is missing from the pinned catalog.');return model;}):[MODEL_CATALOG.find(row=>row.id===EIGHT_GB_PROTOCOL.referenceModel),...MODEL_CATALOG.filter(row=>row.lowRamCandidate)];
  const reports=[];
  for(const model of models){interruption.throwIfInterrupted();const report=await modelRun(config,bound,model);reports.push(report);interruption.throwIfInterrupted();const after=await binding(config);interruption.throwIfInterrupted();if(after.source.digest!==bound.source.digest||after.resources.digest!==bound.resources.digest||after.mainSha256!==bound.mainSha256)throw new Error('Frozen source/resource/app binding changed; no further model loads.');if(!report.ownedProcessesStopped)throw new Error('Owned cleanup failed; no next model is permitted.');if(report.storageExport&&!report.storageExport.complete)throw new Error('Guest-local evidence capture is incomplete; no next model is permitted.');}
  const comparisons=config.runMode?diagnosticComparison(reports,config.runMode).comparisons:reports.slice(1).map(candidate=>{try{return evaluateEightGBComparison(reports[0],candidate);}catch(error){return{modelId:candidate.modelId,eligibleForIndependentSupportReview:false,error:String(error),qualified:false,supportClaimEstablished:false};}});
  await json(path.join(config.out,'comparison.json'),{protocolId:config.runMode===HOST_CONTEXT_DIAGNOSTIC?HOST_CONTEXT_DIAGNOSTIC:EIGHT_GB_PROTOCOL.id,suiteDigest:EIGHT_GB_SUITE_DIGEST,...(config.runMode?{runMode:config.runMode}:{}),comparisons,selection:config.runMode?diagnosticComparison(reports,config.runMode).selection:rankEightGBCandidates(reports[0],reports.slice(1)),qualified:false,supportClaimEstablished:false});
  } finally {const actual=await boundedJSON(lockFile);if(actual.nonce===lockNonce&&actual.pid===process.pid)await unlink(lockFile);}
}
try{await main();}
catch(error){process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
finally{
  if(interruption.first){
    try{if(pipeline.out)await json(path.join(pipeline.out,'parent-interruption.json'),{schemaVersion:1,interruption:interruption.first,recordedAt:iso(),startedControllers:pipeline.launches,retainedModelReports:pipeline.reports,noFurtherControllersAfterCaughtSignal:pipeline.launches.every(row=>Date.parse(row.startedAt)<=Date.parse(interruption.first.caughtAt)),complete:false,qualified:false,supportClaimEstablished:false});}
    catch(error){process.stderr.write(`Interruption evidence could not be persisted: ${error}\n`);}
    process.exitCode=interruption.first.exitCode;
  }
  interruption.dispose();
}

const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if(args.includes('--file')&&args.includes('--resident-limit-bytes')){
 if(process.env.FAKE_HASH_FS_UNSUPPORTED==='1'){console.error('SSD_HASH_ERROR '+JSON.stringify({code:'SSD_HASH_FILESYSTEM_UNSUPPORTED'}));process.exit(73);}
 const emit=()=>{const file=option('--file'),s=fs.statSync(file,{bigint:true}),hash=require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');const proof={schemaVersion:1,helperIdentity:'free-local-agent-ssd-hash-v1',baseCommit:'d81235049384534c167caea52b85a694f6103d14',patchSha256:'d'.repeat(64),helperSourceSha256:'e'.repeat(64),sha256:hash,sizeBytes:Number(s.size),bytesRead:Number(s.size),bufferBytes:1048576,ioMode:'darwin-nocache',fingerprint:{device:Number(s.dev),inode:Number(s.ino),sizeBytes:Number(s.size),mtimeSeconds:Number(s.mtimeNs/1000000000n),mtimeNanoseconds:Number(s.mtimeNs%1000000000n),ctimeSeconds:Number(s.ctimeNs/1000000000n),ctimeNanoseconds:Number(s.ctimeNs%1000000000n)},rssBytes:10*1024**2,physicalFootprintBytes:9*1024**2,availableRamBytes:20*1024**3,memoryPressure:'normal'};
 if(process.env.FAKE_HASH_BAD_PROOF==='1')proof.bytesRead--;if(process.env.FAKE_HASH_WRONG_SHA==='1')proof.sha256='0'.repeat(64);console.log('SSD_HASH '+JSON.stringify(proof));};
 if(process.env.FAKE_HASH_DELAY==='1')setTimeout(()=>{emit();process.exit(0);},500);else{emit();process.exit(0);}return;
}
if (args.includes('--version')) { console.error('version: 0.6.0-dev (build 11429, commit d81235049)'); process.exit(0); }
if (args.includes('--list-devices')) { console.log('Metal0: Apple Test (24000 MiB, 24000 MiB free)\nBLAS: Accelerate (24000 MiB, 24000 MiB free)'); process.exit(0); }
if(args.includes('--cache-slots')&&args.includes('--output-tokens')){
 const cacheBytes=Number(option('--cache-bytes')),slots=Number(option('--cache-slots'));
 const ledger={denseBytes:32,expertCacheBytes:slots*32*3,contextBytes:128*1024**2,recurrentBytes:0,scratchBytes:64*1024**2,stagingBytes:65536,outputBytes:65536,reservedBytes:256*1024**2,cpuWorkspaceBytes:8*1024**2};ledger.totalBytes=Object.values(ledger).reduce((n,v)=>n+v,0);
 const plan={schemaVersion:1,workerIdentity:'free-local-agent-ssd-v1',baseCommit:'d81235049384534c167caea52b85a694f6103d14',patchSha256:'d'.repeat(64),plannerSourceSha256:'f'.repeat(64),architecture:'gemma4',noAlloc:true,modelPayloadAllocatedBytes:process.env.FAKE_PLAN_PAYLOAD==='1'?32:0,mappedColdBytes:0,allocationBudgetBytes:Number(option('--ssd-budget-bytes')),residentLimitBytes:Number(option('--ssd-resident-limit-bytes')),cacheBudgetBytes:cacheBytes,expectedGroups:1,minimumSlotsPerLayer:slots,cacheSlotsPerLayer:slots,profile:{backend:option('--backend'),contextTokens:4096,outputTokens:1024,batchTokens:64,microBatchTokens:16,cacheTypeK:'f16',cacheTypeV:'f16',swaFull:false,slots:1,ioWorkers:2,cpuKernel:process.env.FAKE_PLAN_BAD_KERNEL==='1'?'default':'standard',useExtraBufts:false,cpuRepackTensorCount:0,decodeThreads:4,batchThreads:4},ledger};
 if(process.env.FAKE_PLAN_LOADING_PEAK==='1'){plan.loadingDenseStagingBytes=512*1024**2;plan.loadingPeakBytes=1024**3;}
 console.log('SSD_PLAN '+JSON.stringify(plan));process.exit(0);
}
const batch = Number(option('--batch-size'));
if (process.env.FAKE_ALLOCATE === 'all' || process.env.FAKE_ALLOCATE === 'large' && batch === 512) { console.error('failed to allocate Metal buffer: out of memory'); process.exit(1); }
if (process.env.FAKE_BAD_MODEL === '1') { console.error('unsupported model architecture'); process.exit(1); }
const key = fs.readFileSync(option('--api-key-file'), 'utf8');
if(args.includes('--lazy-mode'))console.error('load_tensors: CPU_Mapped model buffer size = 128.00 MiB\nllama_model_loader: tensor per_layer_token_embd.weight (size = 16 MiB) lazy read enabled');
const ssd=args.includes('--ssd-require-streaming');
function ssdStatus(){
 const expertCacheBytes=Number(option('--ssd-expert-cache-bytes'));
 const ledger={denseBytes:32,expertCacheBytes,stagingBytes:64*1024**2,contextBytes:768*1024**2,recurrentBytes:0,scratchBytes:1024**3,uploadBytes:0,reservedBytes:64*1024**2};ledger.totalBytes=Object.values(ledger).reduce((n,v)=>n+v,0);
 if(process.env.FAKE_SSD_SMALL_LEDGER==='1'){ledger.contextBytes=128*1024**2;ledger.scratchBytes=72*1024**2+65536;ledger.stagingBytes=65536;ledger.reservedBytes=256*1024**2;ledger.totalBytes=Object.entries(ledger).filter(([k])=>k!=='totalBytes').reduce((n,[,v])=>n+v,0);}
 if(process.env.FAKE_SSD_LEDGER==='1')ledger.totalBytes++;
 return {workerIdentity:'free-local-agent-ssd-v1',baseCommit:'d81235049384534c167caea52b85a694f6103d14',patchSha256:'d'.repeat(64),expectedGroups:1,streamedGroups:process.env.FAKE_SSD_FALLBACK==='1'?0:1,ioMode:process.env.FAKE_SSD_BAD_IO==='1'?'buffered':'darwin-nocache',cacheSlotsPerLayer:24,expertCacheBytes,ledger,allocationBudgetBytes:Number(option('--ssd-budget-bytes')),residentLimitBytes:Number(option('--ssd-resident-limit-bytes')),sampledAt:new Date(process.env.FAKE_SSD_STALE==='1'?Date.now()-20000:Date.now()).toISOString(),physicalFootprintBytes:process.env.FAKE_SSD_OVER==='1'?Number(option('--ssd-resident-limit-bytes'))+1:100*1024**2,rssBytes:90*1024**2,bytesRead:4096,cacheHits:1,cacheMisses:1,waves:1,cpuKernel:process.env.FAKE_SSD_BAD_KERNEL==='1'?'default':'standard',useExtraBufts:process.env.FAKE_SSD_REPACK==='1',cpuRepackTensorCount:process.env.FAKE_SSD_REPACK==='1'?1:0,decodeThreads:process.env.FAKE_SSD_BAD_THREADS==='1'?3:Number(option('--threads')),batchThreads:Number(option('--threads-batch'))};
}
let ssdTimer;if(ssd){console.error('SSD_STATUS '+JSON.stringify(ssdStatus()));ssdTimer=setInterval(()=>console.error('SSD_STATUS '+JSON.stringify(ssdStatus())),100);}
let calibrationThinking,idleCalls=0,inferenceCalls=0;
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { res.writeHead(400).end(); return; }
  let value;
  if(req.url==='/v1/chat/completions'&&++inferenceCalls>2&&process.env.FAKE_HEADER_DELAY_AFTER_PROBES==='1')await new Promise(resolve=>setTimeout(resolve,500));
  if(req.url==='/ssd/control'&&body.idle===true&&++idleCalls>2&&process.env.FAKE_IDLE_FAIL_AFTER_PROBES==='1'){res.writeHead(500).end(JSON.stringify({error:'Failed to settle deadline.'}));return;}
  if(req.url==='/v1/chat/completions'&&body.tools)calibrationThinking=body.chat_template_kwargs?.enable_thinking;
  if(req.url==='/v1/chat/completions'&&process.env.FAKE_CALIBRATION_DELAY==='1'){console.error('CALIBRATION_STARTED');await new Promise(resolve=>setTimeout(resolve,500));}
  if (req.url === '/health') { if(process.env.FAKE_HEALTH_DELAY === '1') { res.writeHead(503).end(); return; } value = {status:'ok'}; }
  else if(req.url==='/ssd/status'&&ssd)value=ssdStatus();
  else if(req.url==='/ssd/control'&&ssd)value={status:'ok'};
  else if (req.url === '/props') value = {total_slots:1,default_generation_settings:{n_ctx:ssd&&process.env.FAKE_SSD_SMALL_CONTEXT==='1'?2048:Number(option('--ctx-size'))},build_info:'0.6.0-dev d81235049',ui:false,cors_proxy_enabled:false,chat_template_caps:{supports_tool_calls:process.env.FAKE_CHAT_ONLY !== '1'}};
  else if (req.url === '/v1/chat/completions/input_tokens') value = {input_tokens:JSON.stringify(body).length + (body.tools ? 100 : 0)};
  else if (req.url === '/v1/chat/completions') value = process.env.FAKE_CALIBRATE_FAIL === '1'||!body.tools ? {choices:[{message:{content:!body.tools&&process.env.FAKE_CHAT_PROBE_FAIL!=='1'&&['Reply with OK.','Reply with exactly the two letters OK. Do not include punctuation, formatting, or any other text.'].includes(body.messages?.at(-1)?.content)?'OK':'Hello'}}],timings:{predicted_per_second:42}} : {choices:[{message:{tool_calls:[{function:{name:'local_probe',arguments:'{"word":"OK"}'}}]}}],timings:{predicted_per_second:42}};
  else if (req.url === '/env') value = {secret:process.env.OPENAI_API_KEY,tools:process.env.LLAMA_ARG_TOOLS,rpc:process.env.LLAMA_ARG_RPC,flags:args,pid:process.pid,calibrationThinking};
  else { res.writeHead(404).end(); return; }
  if(req.url==='/v1/chat/completions'){
    if(!body.tools&&process.env.FAKE_CHAT_LENGTH==='1')value={choices:[{finish_reason:'length',message:{content:'',reasoning_content:'The requested answer is still being considered.'}}],usage:{completion_tokens:16,completion_tokens_details:{reasoning_tokens:16}},timings:{predicted_per_second:42,predicted_n:16}};
    else if(!body.tools&&process.env.FAKE_CHAT_WRONG_REPLY==='1')value={choices:[{finish_reason:'stop',message:{content:'OK.'}}],usage:{completion_tokens:3},timings:{predicted_per_second:42,predicted_n:3}};
  }
  res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(value));
});
server.listen(Number(option('--port')), '127.0.0.1');
process.on('SIGTERM', () => {if(ssdTimer)clearInterval(ssdTimer);server.close(() => process.exit(0));});

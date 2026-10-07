const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args.includes('--version')) { console.error('version: 0.6.0-dev (build 11429, commit d81235049)'); process.exit(0); }
if (args.includes('--list-devices')) { console.log('Metal0: Apple Test (24000 MiB, 24000 MiB free)\nBLAS: Accelerate (24000 MiB, 24000 MiB free)'); process.exit(0); }
const batch = Number(option('--batch-size'));
if (process.env.FAKE_ALLOCATE === 'all' || process.env.FAKE_ALLOCATE === 'large' && batch === 512) { console.error('failed to allocate Metal buffer: out of memory'); process.exit(1); }
if (process.env.FAKE_BAD_MODEL === '1') { console.error('unsupported model architecture'); process.exit(1); }
const key = fs.readFileSync(option('--api-key-file'), 'utf8');
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { res.writeHead(400).end(); return; }
  let value;
  if(req.url==='/v1/chat/completions'&&process.env.FAKE_CALIBRATION_DELAY==='1'){console.error('CALIBRATION_STARTED');await new Promise(resolve=>setTimeout(resolve,500));}
  if (req.url === '/health') { if(process.env.FAKE_HEALTH_DELAY === '1') { res.writeHead(503).end(); return; } value = {status:'ok'}; }
  else if (req.url === '/props') value = {total_slots:1,default_generation_settings:{n_ctx:Number(option('--ctx-size'))},build_info:'0.6.0-dev d81235049',ui:false,cors_proxy_enabled:false,chat_template_caps:{supports_tool_calls:process.env.FAKE_CHAT_ONLY !== '1'}};
  else if (req.url === '/v1/chat/completions/input_tokens') value = {input_tokens:JSON.stringify(body).length + (body.tools ? 100 : 0)};
  else if (req.url === '/v1/chat/completions') value = process.env.FAKE_CALIBRATE_FAIL === '1'||!body.tools ? {choices:[{message:{content:'Hello'}}],timings:{predicted_per_second:42}} : {choices:[{message:{tool_calls:[{function:{name:'local_probe',arguments:'{"word":"OK"}'}}]}}],timings:{predicted_per_second:42}};
  else if (req.url === '/env') value = {secret:process.env.OPENAI_API_KEY,tools:process.env.LLAMA_ARG_TOOLS,rpc:process.env.LLAMA_ARG_RPC,flags:args,pid:process.pid};
  else { res.writeHead(404).end(); return; }
  res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(value));
});
server.listen(Number(option('--port')), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));

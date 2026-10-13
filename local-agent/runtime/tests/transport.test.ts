import assert from 'node:assert/strict';
import {createServer,type RequestListener} from 'node:http';
import {test,type TestContext} from 'node:test';
import {loopbackFetch} from '../transport.ts';

async function server(t:TestContext,handle:RequestListener){
  const instance=createServer(handle);await new Promise<void>(resolve=>instance.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{instance.closeAllConnections();instance.close(()=>resolve());}));const address=instance.address();assert(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;
}

test('local transport waits for delayed headers and body under the explicit inference deadline',async t=>{
  const url=await server(t,(_request,response)=>{setTimeout(()=>{response.writeHead(200,{'Content-Type':'application/json'});response.write('{"answer":');setTimeout(()=>response.end('42}'),70);},70);});
  const result=await loopbackFetch(url,{signal:AbortSignal.timeout(1000)});assert.deepEqual(await result.json(),{answer:42});
});

test('local transport cancels a stalled prefill before response headers',async t=>{
  const url=await server(t,()=>{});await assert.rejects(loopbackFetch(url,{signal:AbortSignal.timeout(50)}),{name:'TimeoutError'});
});

test('local transport cancels a stalled response body after headers',async t=>{
  const url=await server(t,(_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.write('{"answer":');});const response=await loopbackFetch(url,{signal:AbortSignal.timeout(100)});await assert.rejects(response.json(),{name:'TimeoutError'});
});

test('local transport keeps bearer authentication and does not follow redirects off loopback',async t=>{
  const url=await server(t,(request,response)=>{assert.equal(request.headers.authorization,'Bearer local-test');response.writeHead(302,{Location:'https://example.com/'}).end();});const response=await loopbackFetch(url,{headers:{Authorization:'Bearer local-test'}});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://example.com/');
  await assert.rejects(loopbackFetch('https://example.com/'),{code:'INVALID_INFERENCE_HOST'});await assert.rejects(loopbackFetch('http://localhost:1234/'),{code:'INVALID_INFERENCE_HOST'});
});

test('local transport streams chunks without buffering the complete inference response',async t=>{
  let finish:(()=>void)|undefined;const url=await server(t,(_request,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: first\n\n');finish=()=>response.end('data: second\n\n');});const response=await loopbackFetch(url,{signal:AbortSignal.timeout(1000)});const reader=response.body!.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/first/);finish!();let remaining='';for(;;){const chunk=await reader.read();if(chunk.done)break;remaining+=new TextDecoder().decode(chunk.value);}assert.match(remaining,/second/);
});

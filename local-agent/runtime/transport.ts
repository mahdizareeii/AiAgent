import {Agent,request as httpRequest,type IncomingMessage} from 'node:http';
import {Readable} from 'node:stream';
import {RuntimeError,throwIfAborted} from './errors.ts';

// Node's global fetch uses Undici's own header/body limits independently of
// AbortSignal. Slow local inference needs a transport whose only timeout is
// the reviewed active execution/probe deadline. No remote endpoint uses this.
const localAgent=new Agent({keepAlive:false,timeout:0,maxSockets:16});
export async function loopbackFetch(input:string|URL,init:RequestInit={}):Promise<Response>{
  const target=new URL(String(input));
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.username||target.password)throw new RuntimeError('INVALID_INFERENCE_HOST','The inference transport accepts only the app-owned IPv4 loopback endpoint.');
  const signal=init.signal??undefined;throwIfAborted(signal);
  if(init.body!==undefined&&init.body!==null&&typeof init.body!=='string')throw new RuntimeError('INVALID_INFERENCE_BODY','The app-owned inference transport requires a JSON text body.');
  const headers=Object.fromEntries(new Headers(init.headers).entries());
  return new Promise<Response>((resolve,reject)=>{
    let incoming:IncomingMessage|undefined;
    const cleanup=()=>signal?.removeEventListener('abort',cancel);
    const request=httpRequest(target,{method:init.method??'GET',headers,agent:localAgent,timeout:0},response=>{
      incoming=response;const responseHeaders=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)responseHeaders.append(response.rawHeaders[i],response.rawHeaders[i+1]);
      response.once('end',cleanup);response.once('close',cleanup);response.once('error',cleanup);
      const status=response.statusCode??500;
      resolve(new Response([204,205,304].includes(status)||init.method==='HEAD'?null:Readable.toWeb(response) as ReadableStream<Uint8Array>,{status,statusText:response.statusMessage??'',headers:responseHeaders}));
      if([204,205,304].includes(status)||init.method==='HEAD')response.resume();
    });
    const cancel=()=>{const reason=signal?.reason instanceof Error?signal.reason:new DOMException('The operation was aborted.','AbortError');incoming?.destroy(reason);request.destroy(reason);};
    request.once('error',error=>{if(!incoming)cleanup();reject(error);});
    signal?.addEventListener('abort',cancel,{once:true});
    // A signal may abort between the initial check and listener installation.
    if(signal?.aborted){cancel();return;}
    request.end(typeof init.body==='string'?init.body:undefined);
  });
}

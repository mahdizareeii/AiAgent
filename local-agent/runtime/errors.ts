export class RuntimeError extends Error {code:string;constructor(code:string,message:string,options?:ErrorOptions){super(message,options);this.name='RuntimeError';this.code=code;}}
export const abortError=()=>new DOMException('The operation was cancelled.','AbortError');
export function throwIfAborted(signal?:AbortSignal):void {if(signal?.aborted)throw abortError();}
/** Only allocation failures justify automatic profile retries; transport/model/template errors do not. */
export function isAllocationFailure(value:unknown):boolean {const text=value instanceof Error?value.message:String(value);return /out of memory|insufficient (?:memory|vram)|failed to allocate|cannot allocate memory|allocation failed|alloc(?:ate|ation)?.*failed|not enough (?:memory|vram)/i.test(text);}

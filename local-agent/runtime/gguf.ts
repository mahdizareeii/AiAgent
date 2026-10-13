import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { RuntimeError, throwIfAborted } from './errors.ts';
export interface GGUFTensor {name:string;dimensions:number[];bytes:number;offset:number;}
export interface GGUFMetadata {architecture:string;name:string;chatTemplate:string;contextLength:number|null;tensorCount:number;tensors:GGUFTensor[];splitNo:number|null;splitCount:number|null;splitTensorCount:number|null;expertCount:number|null;expertUsedCount:number|null;blockCount:number|null;}
// ggml_type enum and type_traits/block static_asserts at the pinned engine commit:
// https://github.com/ggml-org/llama.cpp/tree/d81235049384534c167caea52b85a694f6103d14/ggml
// Each entry is [elements per block, bytes per block]. Removed gguf types have
// no entry; a new engine type must be reviewed before imports can use it.
const tensorStorage:Readonly<Record<number,readonly [number,number]>>=Object.freeze({
  0:[1,4],1:[1,2],2:[32,18],3:[32,20],6:[32,22],7:[32,24],8:[32,34],9:[32,36],
  10:[256,84],11:[256,110],12:[256,144],13:[256,176],14:[256,210],15:[256,292],
  16:[256,66],17:[256,74],18:[256,98],19:[256,50],20:[32,18],21:[256,110],
  22:[256,82],23:[256,136],24:[1,1],25:[1,2],26:[1,4],27:[1,8],28:[1,8],
  29:[256,56],30:[1,2],34:[256,54],35:[256,66],39:[32,17],40:[64,36],
  41:[128,18],42:[64,18],
});
export async function sha256File(file:string,signal?:AbortSignal):Promise<string>{
  throwIfAborted(signal);const hash=createHash('sha256');const stream=createReadStream(file,{signal});
  for await(const chunk of stream){throwIfAborted(signal);hash.update(chunk);}return hash.digest('hex');
}
/** Validate bounded metadata/tensor descriptors and data ranges without loading weights. */
export async function readGGUFMetadata(file:string,signal?:AbortSignal,options:{split?:{index:number;count:number}}={}):Promise<GGUFMetadata>{
  throwIfAborted(signal);
  const handle=await open(file,'r');let position=0;const limit=64*1024**2;
  let fileSize=0;
  let window=Buffer.alloc(0),windowStart=0;
  const check=(bytes:number)=>{
    throwIfAborted(signal);
    if(!Number.isSafeInteger(bytes)||bytes<0||position+bytes>limit)throw new RuntimeError('INVALID_GGUF','The GGUF metadata exceeds the supported limit.');
    if(position+bytes>fileSize)throw new RuntimeError('INVALID_GGUF','The GGUF header is truncated.');
  };
  const skip=(bytes:number)=>{check(bytes);position+=bytes;};
  const read=async(bytes:number)=>{
    check(bytes);
    if(position<windowStart||position+bytes>windowStart+window.length){
      const buffer=Buffer.alloc(Math.min(Math.max(bytes,64*1024),fileSize-position));const result=await handle.read(buffer,0,buffer.length,position);
      throwIfAborted(signal);
      window=buffer.subarray(0,result.bytesRead);windowStart=position;
    }
    if(position+bytes>windowStart+window.length)throw new RuntimeError('INVALID_GGUF','The GGUF header is truncated.');
    const result=window.subarray(position-windowStart,position-windowStart+bytes);position+=bytes;return result;
  };
  const uint=async()=> (await read(4)).readUInt32LE();
  // Tensor dimensions/offsets are not metadata lengths: valid models commonly
  // have offsets beyond 64 MiB. Keep them exact, independently of the read cap.
  const safeUInt64=async()=>{const n=(await read(8)).readBigUInt64LE();if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new RuntimeError('INVALID_GGUF','A GGUF tensor dimension or offset exceeds the safe integer range.');return Number(n);};
  const length=async()=>{const n=(await read(8)).readBigUInt64LE();if(n>BigInt(limit))throw new RuntimeError('INVALID_GGUF','The GGUF metadata has an invalid length.');return Number(n);};
  const string=async(keep:boolean,maxBytes=limit)=>{const n=await length();if(keep){if(n>maxBytes)throw new RuntimeError('INVALID_GGUF','A retained GGUF metadata string exceeds its supported limit.');return (await read(n)).toString('utf8');}skip(n);return '';};
  const sizes:Record<number,number>={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
  const value=async(type:number,keep:boolean,depth=0,maxStringBytes=limit):Promise<string|number|boolean|null>=>{
    throwIfAborted(signal);
    if(depth>2)throw new RuntimeError('INVALID_GGUF','Nested GGUF metadata arrays are unsupported.');
    if(type===8)return string(keep,maxStringBytes);
    if(type===9){
      if(depth>=2)throw new RuntimeError('INVALID_GGUF','Nested GGUF metadata arrays are unsupported.');
      const element=await uint(),n=await length();
      const fixedSize=sizes[element];
      if(fixedSize){skip(n*fixedSize);return null;}
      if(element!==8&&element!==9)throw new RuntimeError('INVALID_GGUF','Unknown GGUF metadata array type.');
      // Every string has an eight-byte length; an array has a type and length.
      // Reject impossible counts before entering a variable-length loop.
      check(n*(element===8?8:12));
      for(let i=0;i<n;i++){
        if(i>0&&i%256===0){await new Promise<void>(resolve=>setImmediate(resolve));throwIfAborted(signal);}
        await value(element,false,depth+1);
      }
      return null;
    }
    const size=sizes[type];if(!size)throw new RuntimeError('INVALID_GGUF','Unknown GGUF metadata type.');
    if(!keep){skip(size);return null;}
    const b=await read(size);switch(type){case 0:return b.readUInt8();case 1:return b.readInt8();case 2:return b.readUInt16LE();case 3:return b.readInt16LE();case 4:return b.readUInt32LE();case 5:return b.readInt32LE();case 6:return b.readFloatLE();case 7:return b[0]!==0;case 10:return Number(b.readBigUInt64LE());case 11:return Number(b.readBigInt64LE());case 12:return b.readDoubleLE();default:return null;}
  };
  try{
    fileSize=(await handle.stat()).size;throwIfAborted(signal);
    if(!Number.isSafeInteger(fileSize)||fileSize<24)throw new RuntimeError('INVALID_GGUF','The GGUF file size is outside the supported safe integer range.');
    if((await read(4)).toString()!=='GGUF')throw new RuntimeError('INVALID_GGUF','Choose a GGUF model file.');const version=await uint();if(version!==2&&version!==3)throw new RuntimeError('INVALID_GGUF','This GGUF version is unsupported.');
    const tensorCount=await length(),count=await length();if(count>10000||tensorCount===0||tensorCount>100000)throw new RuntimeError('INVALID_GGUF','The GGUF does not contain a supported bounded tensor table.');
    const metadata:Record<string,string|number|boolean|null>={};
    const metadataKeys=new Set<string>();
    for(let i=0;i<count;i++){
      if(i>0&&i%256===0){await new Promise<void>(resolve=>setImmediate(resolve));throwIfAborted(signal);}
      const key=await string(true,4096);if(metadataKeys.has(key))throw new RuntimeError('INVALID_GGUF','The GGUF contains duplicate metadata keys.');metadataKeys.add(key);
      const keep=key==='general.architecture'||key==='general.name'||key==='tokenizer.chat_template'||key==='general.alignment'||key.endsWith('.context_length')||key.startsWith('split.')||key.endsWith('.expert_count')||key.endsWith('.expert_used_count')||key.endsWith('.block_count');
      const type=await uint();if(key==='general.alignment'&&type!==4)throw new RuntimeError('INVALID_GGUF','GGUF general.alignment must be a UINT32.');
      const maxStringBytes=key==='general.architecture'?100:key==='general.name'?4096:key==='tokenizer.chat_template'?1024**2:limit;
      const result=await value(type,keep,0,maxStringBytes);if(keep)metadata[key]=result;
    }
    const declaredArchitecture=metadata['general.architecture'],template=metadata['tokenizer.chat_template'],split=options.split;
    if(split&&(!Number.isSafeInteger(split.index)||!Number.isSafeInteger(split.count)||split.index<0||split.count<2||split.count>16||split.index>=split.count||metadata['split.no']!==split.index||metadata['split.count']!==split.count))throw new RuntimeError('MODEL_SHARD_MISMATCH','The GGUF split index/count does not match its expected artifact set.');
    const secondary=Boolean(split&&split.index>0);
    if(!(secondary&&declaredArchitecture===undefined)&&(typeof declaredArchitecture!=='string'||!declaredArchitecture.trim())||!(secondary&&template===undefined)&&(typeof template!=='string'||!template.trim()))throw new RuntimeError('INVALID_GGUF','The model must include its architecture and chat template; only an identified secondary shard may inherit shared metadata.');
    const architecture=typeof declaredArchitecture==='string'?declaredArchitecture:'';
    const alignment=metadata['general.alignment']??32;
    if(typeof alignment!=='number'||!Number.isInteger(alignment)||alignment<1||alignment>4096||(alignment&(alignment-1))!==0)throw new RuntimeError('INVALID_GGUF','GGUF alignment must be a power of two between 1 and 4096.');
    // The pinned loader requires offsets in descriptor order, contiguous after
    // padding each tensor to alignment. This also rules out overlapping ranges.
    const tensors:GGUFTensor[]=[];const tensorNames=new Set<string>();const ranges:{offset:number;bytes:number}[]=[];let expectedOffset=0n;
    check(tensorCount*33); // Minimum nonempty name, one dimension, type and offset.
    for(let i=0;i<tensorCount;i++){
      if(i>0&&i%256===0){await new Promise<void>(resolve=>setImmediate(resolve));throwIfAborted(signal);}
      const name=await string(true,63);
      if(!name||Buffer.byteLength(name,'utf8')>=64||tensorNames.has(name))throw new RuntimeError('INVALID_GGUF','GGUF tensor names must be unique and shorter than 64 bytes.');tensorNames.add(name);
      const nDims=await uint();if(nDims<1||nDims>4)throw new RuntimeError('INVALID_GGUF','GGUF tensors require between one and four dimensions.');
      const dimensions:number[]=[];let elements=1n;
      for(let dimension=0;dimension<nDims;dimension++){
        const size=await safeUInt64();if(size===0)throw new RuntimeError('INVALID_GGUF','GGUF tensor dimensions must be nonzero.');dimensions.push(size);elements*=BigInt(size);
        if(elements>0x7fffffffffffffffn)throw new RuntimeError('INVALID_GGUF','GGUF tensor dimensions overflow the pinned engine integer range.');
      }
      const type=await uint(),storage=tensorStorage[type];if(!storage)throw new RuntimeError('INVALID_GGUF',`GGUF tensor type ${type} is unsupported by this pinned engine.`);
      if(dimensions[0]%storage[0]!==0)throw new RuntimeError('INVALID_GGUF','A quantized GGUF tensor row is not divisible by its block size.');
      const offset=await safeUInt64();if(offset%alignment!==0)throw new RuntimeError('INVALID_GGUF','GGUF tensor data offsets must match its alignment.');
      const size=elements/BigInt(storage[0])*BigInt(storage[1]);
      if(size>BigInt(fileSize)||size>BigInt(Number.MAX_SAFE_INTEGER))throw new RuntimeError('INVALID_GGUF','GGUF tensor data exceeds the actual file size.');
      if(BigInt(offset)<expectedOffset)throw new RuntimeError('INVALID_GGUF','GGUF tensor data ranges overlap or are out of order.');
      if(BigInt(offset)!==expectedOffset)throw new RuntimeError('INVALID_GGUF','GGUF tensor offsets do not match the pinned engine contiguous layout.');
      ranges.push({offset,bytes:Number(size)});tensors.push({name,dimensions,bytes:Number(size),offset});
      const end=BigInt(offset)+size;expectedOffset=(end+BigInt(alignment)-1n)/BigInt(alignment)*BigInt(alignment);
    }
    skip((alignment-position%alignment)%alignment);const dataStart=position;
    for(let i=0;i<ranges.length;i++){
      if(i>0&&i%256===0){await new Promise<void>(resolve=>setImmediate(resolve));throwIfAborted(signal);}
      const range=ranges[i];if(range.offset>fileSize-dataStart||range.bytes>fileSize-dataStart-range.offset)throw new RuntimeError('INVALID_GGUF','GGUF tensor data is truncated or outside the actual file.');
    }
    throwIfAborted(signal);
    return {architecture,name:typeof metadata['general.name']==='string'?metadata['general.name']:'',chatTemplate:typeof template==='string'?template:'',contextLength:typeof metadata[`${architecture}.context_length`]==='number'?metadata[`${architecture}.context_length`] as number:null,tensorCount,tensors,splitNo:typeof metadata['split.no']==='number'?metadata['split.no'] as number:null,splitCount:typeof metadata['split.count']==='number'?metadata['split.count'] as number:null,splitTensorCount:typeof metadata['split.tensors.count']==='number'?metadata['split.tensors.count'] as number:null,expertCount:typeof metadata[`${architecture}.expert_count`]==='number'?metadata[`${architecture}.expert_count`] as number:null,expertUsedCount:typeof metadata[`${architecture}.expert_used_count`]==='number'?metadata[`${architecture}.expert_used_count`] as number:null,blockCount:typeof metadata[`${architecture}.block_count`]==='number'?metadata[`${architecture}.block_count`] as number:null};
  }finally{await handle.close();}
}

/** Bind omitted secondary metadata to the first shard and the trusted catalog. */
export function validateGGUFModelSet(metadata:readonly GGUFMetadata[],expectedArchitecture:string):void{
  const first=metadata[0];if(!first||first.architecture!==expectedArchitecture||!first.chatTemplate.trim())throw new RuntimeError('MODEL_ARCHITECTURE_MISMATCH','The first model shard does not match its catalog architecture and chat template.');
  if(metadata.length===1){if(first.splitCount!==null&&first.splitCount>1)throw new RuntimeError('MODEL_SHARDS_REQUIRED','The model is split across multiple files. Verify the complete artifact set before use.');return;}
  const total=metadata.reduce((n,m)=>n+m.tensorCount,0),names=metadata.flatMap(m=>m.tensors.map(t=>t.name));
  if(metadata.some((m,index)=>m.splitNo!==index||m.splitCount!==metadata.length||m.splitTensorCount!==total||index>0&&m.architecture!==''&&m.architecture!==first.architecture||index>0&&m.chatTemplate!==''&&m.chatTemplate!==first.chatTemplate)||new Set(names).size!==names.length)throw new RuntimeError('MODEL_SHARD_MISMATCH','The model shards have inconsistent shared metadata, split identities or their complete tensor set.');
}

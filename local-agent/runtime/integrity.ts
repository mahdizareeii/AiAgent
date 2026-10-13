import type {Stats} from 'node:fs';
import {RuntimeError} from './errors.ts';
import {PINNED_ENGINE_COMMIT} from './memory.ts';

export interface SSDHashProof {
  schemaVersion:number;helperIdentity:string;baseCommit:string;patchSha256:string;helperSourceSha256:string;
  sha256:string;sizeBytes:number;bytesRead:number;bufferBytes:number;ioMode:string;rssBytes:number;physicalFootprintBytes:number;availableRamBytes:number;memoryPressure:'normal'|'warning'|'critical'|'unknown';
  fingerprint:{device:number;inode:number;sizeBytes:number;mtimeSeconds:number;mtimeNanoseconds:number;ctimeSeconds:number;ctimeNanoseconds:number};
}
/** A checksum proof is accepted only for the exact regular file and verified helper. */
export function validateSSDHashProof(value:unknown,expected:{file:Stats;patchDigest:string;sourceDigest:string;residentLimitBytes:number}):SSDHashProof{
  const p=value as SSDHashProof,f=p?.fingerprint,info=expected.file;
  if(!p||p.schemaVersion!==1||p.helperIdentity!=='free-local-agent-ssd-hash-v1'||p.baseCommit!==PINNED_ENGINE_COMMIT||p.patchSha256!==expected.patchDigest||p.helperSourceSha256!==expected.sourceDigest||p.ioMode!=='darwin-nocache'||p.bufferBytes!==1048576||!/^[a-f0-9]{64}$/.test(p.sha256)||p.sizeBytes!==info.size||p.bytesRead!==info.size)throw new RuntimeError('SSD_HASH_INVALID','The uncached integrity reader did not prove a complete checksum of the expected model file.');
  if(!f||!Number.isSafeInteger(f.device)||!Number.isSafeInteger(f.inode)||f.device!==info.dev||f.inode!==info.ino||f.sizeBytes!==info.size||!Number.isSafeInteger(f.mtimeSeconds)||!Number.isSafeInteger(f.mtimeNanoseconds)||f.mtimeNanoseconds<0||f.mtimeNanoseconds>=1000000000||Math.abs(f.mtimeSeconds*1000+f.mtimeNanoseconds/1000000-info.mtimeMs)>1)throw new RuntimeError('SSD_HASH_INVALID','The uncached checksum fingerprint does not match the inspected model file.');
  if(!Number.isSafeInteger(f.ctimeSeconds)||!Number.isSafeInteger(f.ctimeNanoseconds)||f.ctimeNanoseconds<0||f.ctimeNanoseconds>=1000000000||Math.abs(f.ctimeSeconds*1000+f.ctimeNanoseconds/1000000-info.ctimeMs)>1)throw new RuntimeError('SSD_HASH_INVALID','The model changed during uncached integrity verification.');
  if(!Number.isSafeInteger(p.rssBytes)||p.rssBytes<=0||!Number.isSafeInteger(p.physicalFootprintBytes)||p.physicalFootprintBytes<=0||Math.max(p.rssBytes,p.physicalFootprintBytes)>expected.residentLimitBytes||!Number.isSafeInteger(p.availableRamBytes)||p.availableRamBytes<512*1024**2||!['normal','warning'].includes(p.memoryPressure))throw new RuntimeError('SSD_HASH_INVALID','The checksum helper did not prove bounded physical and resident memory.');
  return p;
}

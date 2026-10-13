import { cpus, freemem, totalmem, release } from 'node:os';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CuratedModel } from './catalog.ts';
export const GIB = 1024 ** 3;
export interface GPUInfo { name:string; backend:string; totalMemoryBytes:number; freeMemoryBytes:number; unifiedMemory:boolean; }
export interface HardwareInfo { platform:NodeJS.Platform; architecture:string; osRelease?:string; cpuModel:string; cpuCores:number; totalMemoryBytes:number; availableMemoryBytes:number; freeDiskBytes:number|null; gpus:GPUInfo[]; }
export type ModelFit = 'recommended'|'slow'|'insufficient';
export interface FitResult { fit:ModelFit; fitReason:string; workingMemoryGB:number; memoryEstimate:{weightsBytes:number;contextBytes:number;scratchBytes:number;osReserveBytes:number;systemBudgetBytes:number;gpuBudgetBytes:number}; }
export function operatingSystemReserve(bytes:number):number { return Math.max(3*GIB,bytes*0.2); }
export function parseMacAvailableMemory(text:string):number|null {
  const pageSize=Number(text.match(/page size of (\d+) bytes/)?.[1]);if(!Number.isSafeInteger(pageSize)||pageSize<1024||pageSize>65536)return null;
  const pages=(name:string)=>Number(text.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm'))?.[1]??NaN);
  const free=pages('free'),inactive=pages('inactive'),speculative=pages('speculative'),purgeable=pages('purgeable');
  if([free,inactive,speculative,purgeable].some(n=>!Number.isSafeInteger(n)||n<0))return null;
  // Purgeable pages can overlap inactive pages; max avoids double-counting them.
  return (free+speculative+Math.max(inactive,purgeable))*pageSize;
}
export async function probeHardware(directory:string, options:{totalMemoryBytes?:number;availableMemoryBytes?:number;platform?:NodeJS.Platform;architecture?:string;freeDiskBytes?:(directory:string)=>Promise<number|null>}={}):Promise<HardwareInfo> {
  const processors=cpus();const total=options.totalMemoryBytes??totalmem();
  const platform=options.platform??process.platform;let available=options.availableMemoryBytes??freemem();
  if(platform==='darwin'&&options.availableMemoryBytes===undefined){try{const result=await promisify(execFile)('/usr/bin/vm_stat',[],{timeout:2000,maxBuffer:65536,env:{LANG:'C'}});available=parseMacAvailableMemory(result.stdout)??available;}catch{}}
  let free:number|null=null;try{free=options.freeDiskBytes?await options.freeDiskBytes(directory):await statfs(directory).then(s=>Number(s.bavail)*Number(s.bsize));}catch{}
  return {platform,osRelease:platform===process.platform?release():undefined,architecture:options.architecture??process.arch,cpuModel:processors[0]?.model??'Unknown CPU',cpuCores:processors.length||1,totalMemoryBytes:total,availableMemoryBytes:Math.min(total,available),freeDiskBytes:free,gpus:[]};
}
export function parseDevices(text:string, backend:string, platform:NodeJS.Platform):GPUInfo[] {
  return text.split('\n').flatMap(line=>{const match=line.match(/^\s*([^:]+):\s*(.+)\s+\((\d+) MiB, (\d+) MiB free\)/);if(!match||/^(CPU|BLAS|AMX)\b/i.test(match[1].trim()))return [];
    const name=match[2].trim();
    // Vulkan heap budgets on integrated GPUs can describe shared system RAM.
    // Only positively identified discrete families may add memory to RAM.
    const discrete=/NVIDIA|GeForce|Quadro|Tesla|Radeon (?:RX [5-9]\d{2,3}\b|Pro W\d{3,4}\b)|Intel\(R\)? Arc\(TM\)? [AB]\d{3}\b/i.test(name);
    return [{name,backend,totalMemoryBytes:Number(match[3])*1024**2,freeMemoryBytes:Number(match[4])*1024**2,unifiedMemory:platform==='darwin'&&backend==='metal'||backend==='vulkan'&&!discrete}];});
}
/** Working estimates include an 8K context and scratch reserve; calibration is authoritative. */
export function classifyModel(spec:CuratedModel,hardware:HardwareInfo):FitResult {
  const reserve=operatingSystemReserve(hardware.totalMemoryBytes);
  const gpu=hardware.gpus.find(g=>!g.unifiedMemory);
  const systemBudget=Math.max(0,hardware.totalMemoryBytes-reserve);
  const combinedBudget=systemBudget+(gpu?Math.max(0,gpu.freeMemoryBytes-GIB):0);
  const required=spec.workingMemoryGB*GIB;
  const gpuBudget=Math.max(0,...hardware.gpus.map(g=>Math.max(0,g.freeMemoryBytes-(g.unifiedMemory?0:GIB))));
  const memoryEstimate={weightsBytes:spec.estimatedDownloadBytes,contextBytes:Math.max(0,required-spec.estimatedDownloadBytes-GIB),scratchBytes:GIB,osReserveBytes:reserve,systemBudgetBytes:systemBudget,gpuBudgetBytes:gpuBudget};
  const result={workingMemoryGB:spec.workingMemoryGB,memoryEstimate};
  if(required>combinedBudget)return {...result,fit:'insufficient',fitReason:'Model weights and estimated working memory exceed the hardware budget after the operating-system reserve. Smaller requests do not shrink weights.'};
  const accelerated=hardware.gpus.some(g=>required<Math.min(g.unifiedMemory?systemBudget:Infinity,Math.max(0,g.freeMemoryBytes-(g.unifiedMemory?0:GIB))));
  const currentlyAvailable=hardware.availableMemoryBytes+(gpu?Math.max(0,gpu.freeMemoryBytes-GIB):0);
  if(currentlyAvailable<spec.estimatedDownloadBytes+512*1024**2)return {...result,fit:'insufficient',fitReason:'Other applications currently leave too little available memory for the weights and minimum workspace. Close applications and refresh hardware; smaller requests cannot shrink the model weights.'};
  const pressure=currentlyAvailable<Math.min(required,combinedBudget)+512*1024**2;
  if(!accelerated||pressure)return {...result,fit:'slow',fitReason:pressure?'Other applications are using memory. Close them or enable Slow mode for a bounded CPU/offload profile.':'Estimated weights fit in system memory, but exceed the accelerator budget or require CPU inference. Enable Slow mode; generation may be slow.'};
  return {...result,fit:'recommended',fitReason:'Estimated weights, 8K context and scratch memory fit both the accelerator budget and the system budget after the operating-system reserve. Actual loading and calibration are checked.'};
}

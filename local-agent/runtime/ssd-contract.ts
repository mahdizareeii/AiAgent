/** Exact computation contracts; this draft grants no trial/certificate/quality evidence. */
import { createHash } from 'node:crypto';
import { modelArtifacts, type CuratedModel } from './catalog.ts';
import { RuntimeError } from './errors.ts';

export const QWEN80_SSD_MODEL = 'qwen3-coder-next:80b';
export const QWEN80_SSD_ARTIFACT_SET = '3d0fd1c8ad6c37fdac38e20b02de80149a5d93b8c457c39e8a27100c8bf62d64';
export const QWEN80_SSD_TEMPLATE = '0b5c439b5b14126c0ae8b14ca93240c3cef1e7e29d684102b07f10727523dbdb';
export const QWEN80_SSD_SCOPE = 'representative-experts-and-two-hybrid-layers';
export const QWEN80_SSD_PROTOCOL = 'qwen80-standard-cpu-hybrid-v2-8k';
export const SSD_BASE_COMMIT = 'd81235049384534c167caea52b85a694f6103d14';
export const QWEN80_SSD_WORKER_PATCH = '83139a4fbe858827d75f5050defefa69413718c45335ca5c18e49919c3944bb8';
const SHARDS = Object.freeze([
  ['Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf', '6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da', 15524827040],
  ['Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf', '817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3', 14872168352],
  ['Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf', '23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f', 14503294496],
  ['Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf', '249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b', 3510702144],
] as const);
export const GEMMA_SSD_PROFILE = Object.freeze({ backend: 'cpu', contextTokens: 4096, outputTokens: 1024, batchTokens: 64, microBatchTokens: 16, index: 0 });
export const QWEN80_SSD_PROFILE = Object.freeze({ backend: 'cpu', contextTokens: 8192, outputTokens: 2048, batchTokens: 64, microBatchTokens: 16, index: 0, kvUnified:true, nRsSeq:0, checkpoints:0 });
export const QWEN80_SSD_COMPUTATION = Object.freeze({ contextTokens: 8192, outputTokens: 2048, batchTokens: 64, microBatchTokens: 16,
  cacheSlotsPerLayer: 30, cacheTypeK: 'f16', cacheTypeV: 'f16', swaFull: false, slots: 1, ioWorkers: 2, ioMode: 'darwin-nocache', decodeThreads: 4, batchThreads: 4, kvUnified:true, nRsSeq:0, checkpoints:0 });
export interface SSDProfileContract { profile: typeof GEMMA_SSD_PROFILE | typeof QWEN80_SSD_PROFILE; scope: string; cacheSlotsPerLayer: number; }

export interface SSDNumericalNativeBinding { identity: Record<string, unknown>; digest: string; }
/** Deterministic JSON for native identities, independent of object insertion order. */
export function canonicalNativeJSON(value: unknown): string {
  if (typeof value === 'string') {
    for (let i=0;i<value.length;i++) { const n=value.charCodeAt(i);
      if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new Error('Unpaired native identity surrogate');}
      else if(n>=0xdc00&&n<=0xdfff)throw new Error('Unpaired native identity surrogate');
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalNativeJSON).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys=Object.keys(value);if(keys.some(k=>/[^\x00-\x7f]/.test(k)))throw new Error('Native identity keys must be ASCII');
    return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonicalNativeJSON((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new Error('Native identity must contain finite safe integer JSON data.');
}
/** Reports are excluded; adding a certificate cannot change the tested native identity. */
export function ssdNumericalNativeBinding(value: unknown): SSDNumericalNativeBinding | null {
  const m = value as any, hex = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  const nativePath = (x: unknown) => typeof x === 'string' && /^worker\/[a-zA-Z0-9._-]+$/.test(x) && x !== 'worker/.' && x !== 'worker/..';
  try {
    if (!m || m.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(m.baseCommit) || !hex(m.patchSha256) || m.target !== 'darwin-arm64'
      || !Array.isArray(m.files) || !Array.isArray(m.backends) || m.backends.length < 1 || m.backends.length > 2) return null;
    const allPaths=m.files.map((row:any)=>row?.path);
    if(allPaths.some((p:unknown)=>typeof p!=='string')||new Set(allPaths).size!==allPaths.length)return null;
    const paths = new Set<string>();
    const nativeFiles = m.files.filter((row: any) => typeof row?.path === 'string' && row.path.startsWith('worker/'))
      .map((row: any) => {
        if (!nativePath(row.path) || paths.has(row.path) || !Number.isSafeInteger(row.size) || row.size <= 0 || !hex(row.sha256)) throw new Error('Invalid native inventory');
        paths.add(row.path); return { path: row.path, size: row.size, sha256: row.sha256 };
      }).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!nativeFiles.length || nativeFiles.length>256 || !['libllama.0.dylib', 'libggml.0.dylib', 'libggml-base.0.dylib', 'libggml-cpu.0.dylib'].every(name => paths.has('worker/' + name))) return null;
    for (const [helper, executable] of [[m.planner, 'worker/llama-plan-ssd'], [m.integrity, 'worker/llama-hash-ssd']] as const)
      if (!helper || helper.schemaVersion !== 1 || helper.executable !== executable || !paths.has(executable) || !hex(helper.sourceSha256)) return null;
    const ids = new Set<string>();
    for (const backend of m.backends) {
      if (!backend || !['cpu', 'metal'].includes(backend.id) || ids.has(backend.id) || !nativePath(backend.executable) || !paths.has(backend.executable)
        || backend.libraryDirectory !== 'worker' || !Array.isArray(backend.arguments) || backend.arguments.some((a: unknown) => typeof a !== 'string')) return null;
      ids.add(backend.id);
    }
    if (!ids.has('cpu')) return null;
    const identity = { schemaVersion: 1, baseCommit: m.baseCommit, patchSha256: m.patchSha256, target: m.target,
      backends: m.backends, planner: m.planner, integrity: m.integrity, nativeFiles };
    const canonical = canonicalNativeJSON(identity);
    return { identity: JSON.parse(canonical), digest: createHash('sha256').update(canonical).digest('hex') };
  } catch { return null; }
}

/** Discovery may compare immutable catalog identities; it never verifies downloaded bytes. */
export function curatedArtifactSetDigest(spec: CuratedModel): string {
  const artifacts = modelArtifacts(spec).map(a => ({ filename: a.filename, sha256: a.sha256, sizeBytes: a.sizeBytes }));
  return artifacts.length === 1 ? artifacts[0].sha256 : createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
}
export function exactQwen80Source(spec: CuratedModel): boolean {
  const a = modelArtifacts(spec);
  return spec.id === QWEN80_SSD_MODEL && spec.repository === 'Qwen/Qwen3-Coder-Next-GGUF'
    && spec.revision === 'b82fb7382639d97b38fa7672e526c760c2fb358e' && spec.architecture === 'qwen3next' && spec.quantization === 'Q4_K_M'
    && spec.estimatedDownloadBytes === 48410992032 && a.length === 4
    && SHARDS.every(([name, sha, size], i) => a[i].filename === name && a[i].sha256 === sha && a[i].sizeBytes === size)
    && curatedArtifactSetDigest(spec) === QWEN80_SSD_ARTIFACT_SET && spec.ssd?.expectedLayers === 48 && spec.ssd.expertsPerLayer === 512
    && spec.ssd.activeExperts === 10 && spec.ssd.minimumSlotsPerLayer === 30;
}
export function ssdProfileContract(spec: CuratedModel): SSDProfileContract {
  if (exactQwen80Source(spec)) return { profile: QWEN80_SSD_PROFILE, scope: QWEN80_SSD_SCOPE, cacheSlotsPerLayer: 30 };
  // Retain the existing Gemma branch, including isolated synthetic fixtures.
  if (spec.architecture === 'gemma4' && spec.ssd?.minimumSlotsPerLayer === 24)
    return { profile: GEMMA_SSD_PROFILE, scope: 'representative-experts-and-two-swa-layers', cacheSlotsPerLayer: 24 };
  throw new RuntimeError('SSD_PARITY_UNVERIFIED', 'This model has no exact bounded SSD computation contract.');
}
/** These flags are an exact Qwen-only request; startup evidence remains mandatory. */
export function qwen80SSDArguments(spec:CuratedModel,ssd:boolean):string[]{return ssd&&exactQwen80Source(spec)?['--kv-unified','--log-verbosity','4']:[];}
export class Qwen80NativeStartupLog {
  private tail='';private seen=new Map<string,string>();private contradictory=false;
  private record(key:string,value:string):void{const old=this.seen.get(key);if(old!==undefined&&old!==value)this.contradictory=true;this.seen.set(key,value);}
  append(chunk:string):void{
    const lines=(this.tail+chunk).split(/\r?\n/);this.tail=(lines.pop()??'').slice(-4096);
    for(const line of lines){
      const numeric=line.match(/\bllama_context:\s+(n_ctx|n_ctx_seq|n_batch|n_ubatch|n_seq_max|n_rs_seq)\s*=\s*(\d+)\s*$/);
      if(numeric)this.record(numeric[1],numeric[2]);
      const unified=line.match(/\bllama_context:\s+kv_unified\s*=\s*(true|false)\s*$/);if(unified)this.record('kv_unified',unified[1]);
      const kv=line.match(/\bllama_kv_cache:.*\bK \(([^)]+)\):.*\bV \(([^)]+)\):/);if(kv){this.record('cache_k',kv[1]);this.record('cache_v',kv[2]);}
      if(/\bsrv\s+\S+:\s+context checkpoints disabled\s*$/.test(line))this.record('checkpoints','0');
      if(/\bsrv\s+\S+:\s+context checkpoints enabled\b/.test(line))this.record('checkpoints','enabled');
    }
  }
  confirmed(props:unknown):boolean{
    const p=props as any,expected={n_ctx:'8192',n_ctx_seq:'8192',n_batch:'64',n_ubatch:'16',n_seq_max:'1',n_rs_seq:'0',kv_unified:'true',cache_k:'f16',cache_v:'f16',checkpoints:'0'};
    return !this.contradictory&&p?.total_slots===1&&p.default_generation_settings?.n_ctx===8192&&Object.entries(expected).every(([k,v])=>this.seen.get(k)===v);
  }
}
export function isQwen80NumericalReport(report: unknown, configuration: any, patchDigest: string, nativeBinding?: SSDNumericalNativeBinding | null): boolean {
  const r = report as any;
  if (!r || configuration.architecture !== 'qwen3next' || configuration.modelSha256 !== QWEN80_SSD_ARTIFACT_SET
    || configuration.templateSha256 !== QWEN80_SSD_TEMPLATE || configuration.scope !== QWEN80_SSD_SCOPE
    || patchDigest !== QWEN80_SSD_WORKER_PATCH || configuration.workerPatchSha256 !== patchDigest
    || configuration.baseCommit !== SSD_BASE_COMMIT || configuration.backend !== 'cpu' || configuration.cpuKernel !== 'standard'
    || configuration.useExtraBufts !== false || configuration.cpuRepackTensorCount !== 0) return false;
  if (!nativeBinding || r.nativeResourceDigest !== nativeBinding.digest) return false;
  try { if (canonicalNativeJSON(r.nativeResourceIdentity) !== canonicalNativeJSON(nativeBinding.identity)) return false; } catch { return false; }
  const layout={contextTokens:8192,contextPerSequence:8192,batchTokens:64,microBatchTokens:16,slots:1,kvUnified:true,nRsSeq:0,cacheTypeK:'f16',cacheTypeV:'f16'};
  try { if(canonicalNativeJSON(r.resolvedNativeLayout)!==canonicalNativeJSON(layout))return false; } catch { return false; }
  const summary = r.measuredRun?.resourceSummary;
  if (!summary || Object.keys(summary).length!==8 || summary.allPressureNormal !== true || !['sampleCount', 'ownedChildSampleCount', 'minimumAvailableRamBytes',
    'maximumControllerRssBytes', 'maximumControllerPhysicalFootprintBytes', 'maximumOwnedChildRssBytes', 'maximumOwnedChildPhysicalFootprintBytes']
    .every(k => Number.isSafeInteger(summary[k]) && summary[k] > 0) || summary.sampleCount>20000 || summary.ownedChildSampleCount > summary.sampleCount
    || summary.minimumAvailableRamBytes < 1024 ** 3 || Math.max(summary.maximumControllerRssBytes, summary.maximumControllerPhysicalFootprintBytes) > 256 * 1024 ** 2
    || Math.max(summary.maximumOwnedChildRssBytes, summary.maximumOwnedChildPhysicalFootprintBytes) > 3.5 * 1024 ** 3
    || r.measuredRun.resourceSamples !== undefined) return false;
  if(r.absoluteTolerance!==1e-5||r.relativeTolerance!==1e-5)return false;
  const p = configuration.profile, measured = r.measuredProof;
  if (!p || Object.entries(QWEN80_SSD_COMPUTATION).some(([key, value]) => p[key] !== value)) return false;
  if (!measured || measured.protocol !== QWEN80_SSD_PROTOCOL || !['sourceArtifactSetVerified', 'expertParityPassed', 'completeHybridEvidence',
    'sourceFingerprintUnchanged', 'ownedProcessesStopped', 'selectedPairsContributeOnce'].every(k => measured[k] === true)) return false;
  if (!['nodesCompared', 'elementsCompared', 'expertLayoutsSurveyed', 'representativeGroupsCompared'].every(k => Number.isSafeInteger(measured[k]) && measured[k] > 0)) return false;
  if (!['elementsOutsideTolerance', 'mismatchedIds', 'nonfinite'].every(k => measured[k] === 0)) return false;
  if (!['comparisonSha256', 'processReportSha256', 'expertParityLogSha256'].every(k => /^[a-f0-9]{64}$/.test(measured[k]))) return false;
  return true;
}

import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_LICENSES, sha256File } from './prepare-inference.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchPath = path.join(projectRoot, 'scripts/ssd-inference/llama.cpp-ssd.patch');
const plannerSource = path.join(projectRoot, 'scripts/ssd-inference/native-plan.cpp');
const integritySource = path.join(projectRoot, 'scripts/ssd-inference/native-hash.cpp');
const validationReports = [{ source: 'scripts/ssd-inference/validation/gemma4-26b-standard-cpu.json', path: 'validation/gemma4-26b-standard-cpu.json' }];
export const SSD_ENGINE_PIN = Object.freeze({
  engine: 'llama.cpp-ssd-experts', version: '0.6.0', build: 11429,
  baseCommit: 'd81235049384534c167caea52b85a694f6103d14',
  upstreamCommits: ['4260e460832f5e95c41d8b6d8b2aea98007df524', 'db5268ffac4c3ddacd7edcf62e78e3a1ba8d8191'],
  workerIdentity: 'free-local-agent-ssd-v1', target: 'darwin-arm64',
});
export const SSD_BACKENDS = Object.freeze([
  { id: 'metal', executable: 'worker/llama-server-ssd', libraryDirectory: 'worker', arguments: [] },
  { id: 'cpu', executable: 'worker/llama-server-ssd', libraryDirectory: 'worker', arguments: ['--device', 'none', '--n-gpu-layers', '0', '--no-op-offload', '--no-repack', '--threads', '4', '--threads-batch', '4'] },
]);
const flags = [
  '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DLLAMA_BUILD_NUMBER=11429',
  '-DLLAMA_BUILD_COMMIT=d81235049', '-DLLAMA_BUILD_COMMON=ON', '-DLLAMA_BUILD_SERVER=ON',
  '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_TOOLS=ON', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_APP=OFF',
  '-DGGML_NATIVE=OFF', '-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod', '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON', '-DGGML_METAL_NDEBUG=OFF', '-DGGML_OPENMP=OFF',
  '-DGGML_BLAS=OFF', '-DLLAMA_OPENSSL=OFF', '-DCMAKE_OSX_ARCHITECTURES=arm64',
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0', '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
  '-DCMAKE_INSTALL_RPATH=@loader_path', '-DCMAKE_INSTALL_NAME_DIR=@rpath',
];
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, LLAMA_CACHE: '' } });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${path.basename(command)} failed (${result.status})`);
};
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === 'manifest.json') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`SSD resource cannot be a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await inventory(absolute, relative));
    else if (entry.isFile()) files.push({ path: relative, size: (await stat(absolute)).size, sha256: await sha256File(absolute) });
    else throw new Error(`Invalid SSD resource type: ${relative}`);
  }
  return files;
}
async function sourceValidations(patchSha256) {
  const configurations=[];
  for(const entry of validationReports) {
    const source=path.join(projectRoot,entry.source);
    const report=JSON.parse(await readFile(source,'utf8'));
    if(report.schemaVersion!==1 || report.passed!==true || report.workerPatchSha256!==patchSha256 ||
       report.baseCommit!==SSD_ENGINE_PIN.baseCommit || report.backend!=='cpu' || report.cpuKernel!=='standard' ||
       report.useExtraBufts!==false || report.cpuRepackTensorCount!==0 ||
       report.scope!=='representative-experts-and-two-swa-layers') throw new Error('SSD CPU equivalence report does not match the active native binding');
    if(!/^[a-f0-9]{64}$/.test(report.modelSha256) || !/^[a-f0-9]{64}$/.test(report.templateSha256) || report.architecture!=='gemma4')
      throw new Error('SSD CPU equivalence artifact/template binding is invalid');
    const p=report.profile;
    if(!p || p.contextTokens!==4096 || p.outputTokens!==1024 || p.batchTokens!==64 || p.microBatchTokens!==16 ||
       p.cacheTypeK!=='f16' || p.cacheTypeV!=='f16' || p.swaFull!==false || p.slots!==1 || p.ioWorkers!==2 ||
       p.ioMode!=='darwin-nocache' || p.decodeThreads!==4 || p.batchThreads!==4 || p.cacheSlotsPerLayer!==24)
      throw new Error('SSD CPU equivalence report profile is invalid');
    configurations.push({schemaVersion:1,modelSha256:report.modelSha256,templateSha256:report.templateSha256,architecture:report.architecture,
      backend:report.backend,cpuKernel:report.cpuKernel,useExtraBufts:report.useExtraBufts,cpuRepackTensorCount:report.cpuRepackTensorCount,
      baseCommit:report.baseCommit,workerPatchSha256:report.workerPatchSha256,profile:report.profile,scope:report.scope,
      report:entry.path,reportSha256:await sha256File(source)});
  }
  return configurations;
}
async function copyValidations(directory) {
  await mkdir(path.join(directory,'validation'),{recursive:true});
  for(const entry of validationReports)await copyFile(path.join(projectRoot,entry.source),path.join(directory,entry.path));
}
export async function verifySSDInferenceResources(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error('SSD resource schema mismatch');
  for (const [key,value] of Object.entries(SSD_ENGINE_PIN)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value)) throw new Error(`SSD manifest ${key} differs from audited source pins`);
  }
  if (manifest.patchSha256 !== await sha256File(patchPath)) throw new Error('SSD patch identity mismatch');
  if (manifest.planner?.executable !== 'worker/llama-plan-ssd' || manifest.planner?.sourceSha256 !== await sha256File(plannerSource)) throw new Error('SSD native planner identity mismatch');
  if (manifest.integrity?.executable !== 'worker/llama-hash-ssd' || manifest.integrity?.sourceSha256 !== await sha256File(integritySource)) throw new Error('SSD native integrity identity mismatch');
  if (JSON.stringify(manifest.backends) !== JSON.stringify(SSD_BACKENDS)) throw new Error('SSD backend identity mismatch');
  if(JSON.stringify(manifest.validatedConfigurations)!==JSON.stringify(await sourceValidations(manifest.patchSha256)))
    throw new Error('SSD CPU equivalence report/certificate binding mismatch');
  const actual = await inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('SSD resource file inventory/hash mismatch');
  for (const license of SOURCE_LICENSES) {
    if (await sha256File(path.join(directory, license.path)) !== license.sha256) throw new Error(`SSD source license mismatch: ${license.path}`);
  }
  return manifest;
}
export async function refreshSSDValidationResources(directory=path.join(projectRoot,'resources/ssd-inference/darwin-arm64')) {
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.patchSha256!==await sha256File(patchPath) || manifest.planner?.sourceSha256!==await sha256File(plannerSource) ||
     manifest.integrity?.sourceSha256!==await sha256File(integritySource))throw new Error('Cannot refresh reports for a changed native executable/source binding');
  const current=(await inventory(directory)).filter(entry=>!entry.path.startsWith('validation/'));
  const recorded=manifest.files.filter(entry=>!entry.path.startsWith('validation/'));
  if(JSON.stringify(current)!==JSON.stringify(recorded))throw new Error('Cannot refresh reports after native resource modification');
  manifest.validatedConfigurations=await sourceValidations(manifest.patchSha256);
  await copyValidations(directory);manifest.files=await inventory(directory);
  await writeFile(path.join(directory,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
  return verifySSDInferenceResources(directory);
}
export async function prepareSSDInference({ verifyOnly = false, sourceDirectory, buildDirectory, cmake, outputDirectory } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('SSD worker is currently native-validated only for macOS ARM64');
  const cache = path.join(projectRoot, '.cache/ssd-engine');
  const output = outputDirectory ?? path.join(projectRoot, 'resources/ssd-inference/darwin-arm64');
  if (verifyOnly) return verifySSDInferenceResources(output);
  const source = sourceDirectory ?? path.join(cache, 'repro-source');
  const existing = path.join(cache, 'source');
  const binary = cmake ?? process.env.SSD_CMAKE ?? 'cmake';
  const build = buildDirectory ?? path.join(cache, 'repro-build');
  await mkdir(cache, { recursive: true });
  let newlyCloned=false;
  try { await stat(path.join(source, '.git')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Bootstrap source deliberately fetches code only. End-user inference never downloads a runtime.
    try { await stat(path.join(existing, '.git')); run('git', ['clone', '--no-checkout', '--shared', existing, source], projectRoot); }
    catch { run('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/ggml-org/llama.cpp.git', source], projectRoot); }
    newlyCloned=true;
  }
  // A clone made with --no-checkout has an empty index. Populate the pinned tree before
  // comparing patches, otherwise diff HEAD describes deletion of the entire upstream source.
  let knownEmptyBootstrap=false;
  if (!sourceDirectory && JSON.stringify((await readdir(source)).sort()) === '[".git"]') {
    const origin=execFileSync('git',['remote','get-url','origin'],{cwd:source,encoding:'utf8'}).trim();
    const index=execFileSync('git',['ls-files'],{cwd:source,encoding:'utf8',maxBuffer:8*1024*1024});
    knownEmptyBootstrap=origin===existing && !index.trim();
  }
  if(newlyCloned || knownEmptyBootstrap) run('git',['checkout','--detach',SSD_ENGINE_PIN.baseCommit],source);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8',maxBuffer:8*1024*1024 });
  if (status.trim()) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: source,maxBuffer:8*1024*1024 });
    if (head !== SSD_ENGINE_PIN.baseCommit || !diff.equals(await readFile(patchPath)) || status.split('\n').some(line => line.startsWith('?? '))) {
      throw new Error('Repro source must be clean or exactly match the audited patch; preserve other changes before rebuilding');
    }
  } else {
    run('git', ['checkout', '--detach', SSD_ENGINE_PIN.baseCommit], source);
    run('git', ['apply', '--check', patchPath], source);
    run('git', ['apply', patchPath], source);
    // Stage new files solely so repeated source comparison includes their bytes; never commit this checkout.
    run('git', ['add', '-A'], source);
  }
  const patchSha256 = await sha256File(patchPath);
  run(binary, ['-S', source, '-B', build, ...flags, `-DSSD_PATCH_SHA256=${patchSha256}`], projectRoot);
  run(binary, ['--build', build, '--target', 'llama-server', 'llama-ssd-self-test', '--parallel', '6'], projectRoot);
  const plannerSourceSha256 = await sha256File(plannerSource);
  const plannerBinary = path.join(build,'bin/llama-plan-ssd');
  run('/usr/bin/clang++',['-std=c++17','-O2','-mmacosx-version-min=14.0',
    '-I',path.join(source,'include'),'-I',path.join(source,'src'),'-I',path.join(source,'ggml/include'),
    `-DSSD_PATCH_SHA256="${patchSha256}"`,`-DSSD_PLAN_SOURCE_SHA256="${plannerSourceSha256}"`,plannerSource,
    ...['libllama.0.dylib','libggml.0.dylib','libggml-base.0.dylib','libggml-cpu.0.dylib'].map(name=>path.join(build,'bin',name)),
    '-Wl,-rpath,@loader_path','-o',plannerBinary],projectRoot);
  const integritySourceSha256 = await sha256File(integritySource);
  const integrityBinary = path.join(build,'bin/llama-hash-ssd');
  run('/usr/bin/clang++',['-std=c++17','-O2','-mmacosx-version-min=14.0','-Wno-deprecated-declarations',
    `-DSSD_PATCH_SHA256="${patchSha256}"`,`-DSSD_HASH_SOURCE_SHA256="${integritySourceSha256}"`,
    integritySource,'-o',integrityBinary],projectRoot);
  // No model loads. The tiny CPU fixture verifies cache/waves and allocator/deadline behavior.
  run(path.join(build, 'bin/llama-ssd-self-test'), ['cache'], projectRoot);
  run(path.join(build, 'bin/llama-ssd-self-test'), ['ledger'], projectRoot);
  run(path.join(build, 'bin/llama-ssd-self-test'), ['recurrent'], projectRoot);
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'worker'), { recursive: true });
  await mkdir(path.join(output, 'licenses'), { recursive: true });
  const bin = path.join(build, 'bin');
  const names = (await readdir(bin)).filter(name => /^lib.+\.0\.dylib$/.test(name) || name === 'libllama-server-impl.dylib');
  for (const name of names) await copyFile(await realpath(path.join(bin, name)), path.join(output, 'worker', name));
  await copyFile(path.join(bin, 'llama-server'), path.join(output, 'worker/llama-server-ssd'));
  await copyFile(plannerBinary,path.join(output,'worker/llama-plan-ssd'));
  await copyFile(integrityBinary,path.join(output,'worker/llama-hash-ssd'));
  const required = new Set(names);
  for (const name of [...names, 'llama-server-ssd','llama-plan-ssd','llama-hash-ssd']) {
    const location = path.join(output, 'worker', name);
    const deps = execFileSync('otool', ['-L', location], { encoding: 'utf8' }).split('\n').slice(1).map(line => line.trim().split(' ')[0]).filter(Boolean);
    for (const dep of deps) {
      if (dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/')) continue;
      if (!dep.startsWith('@rpath/') || !required.has(path.basename(dep))) throw new Error(`SSD unbundled dependency: ${dep}`);
    }
    run('codesign', ['--force', '--sign', '-', location], projectRoot);
  }
  for (const license of SOURCE_LICENSES) {
    const from = path.join(source, license.source);
    if (await sha256File(from) !== license.sha256) throw new Error(`Pinned source license changed: ${license.source}`);
    await copyFile(from, path.join(output, license.path));
  }
  const compiler = execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).split('\n')[0];
  const notice = `Free Local Agent SSD worker prototype\nMIT llama.cpp base ${SSD_ENGINE_PIN.baseCommit}\nBackports from ggml-org/llama.cpp PR25294: ${SSD_ENGINE_PIN.upstreamCommits.join(', ')}\nLocal safety/telemetry patch SHA256: ${patchSha256}\n\nThis is a separately modified engine, not an upstream release binary.\nOnly Gemma4/Qwen3Next routed GGUF expert groups and local APFS file descriptors are audited.\nCold experts are not mmaped or fully registered with Metal. Two I/O workers use per-FD F_NOCACHE.\nRequired streaming rejects whole-weight fallback. Minimum cache is three times active topK.\nThe ledger tracks backend/KV/recurrent/graph/staging/upload allocations and reserves 256MiB for runtime metadata/driver/heap overhead.\nDarwin physical-footprint and RSS monitoring is sampled protection, not a hard OS memory cap.\nNo swap settings or unrelated applications are changed.\n\nSource and embedded dependency license notices are retained under licenses/.\n`;
  await writeFile(path.join(output, 'BUILD-NOTICE.txt'), notice);
  const manifest = {
    schemaVersion: 1, ...SSD_ENGINE_PIN, patchSha256, backends: SSD_BACKENDS,
    planner:{schemaVersion:1,executable:'worker/llama-plan-ssd',libraryDirectory:'worker',arguments:[],sourceSha256:plannerSourceSha256},
    integrity:{schemaVersion:1,executable:'worker/llama-hash-ssd',arguments:[],sourceSha256:integritySourceSha256},
    ioMode: 'darwin-nocache', requiredStreaming: true, ioWorkers: 2,
    minimumCacheMultiplier: 3, minimumMacOS: '14.0',
    buildInfo: { compiler, cmakeFlags: flags, adHocSigned: true },
    validatedConfigurations:await sourceValidations(patchSha256),
  };
  await copyValidations(output);manifest.files=await inventory(output);
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await verifySSDInferenceResources(output);
  return manifest;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv=process.argv.slice(2);
  const allowed=new Set(['--verify','--verify-only','--help']);
  const unknown=argv.find(flag=>!allowed.has(flag));
  if(unknown) { console.error(`Unknown SSD build option: ${unknown}`); process.exitCode=1; }
  else if(argv.includes('--help')) console.log('Usage: node scripts/prepare-ssd-inference.mjs [--verify|--verify-only]');
  else prepareSSDInference({ verifyOnly: argv.includes('--verify') || argv.includes('--verify-only') }).then(manifest => {
    console.log(`SSD resources verified: ${manifest.target}, patch ${manifest.patchSha256}`);
  }).catch(error => { console.error(error.message); process.exitCode=1; });
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allocationPlannerPin, allocationPlannerDescriptor } from '../local-agent/runtime/planner-pins.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_PIN = Object.freeze({
  engine: 'llama.cpp', version: '0.6.0', build: 11429,
  commit: 'd81235049384534c167caea52b85a694f6103d14', tag: 'b11429',
});
export const RESOURCE_PROBE_SOURCE = 'local-agent/runtime/native/resource-sample.c';
export const RESOURCE_PROBE_SHA256 = 'aa0d0e8417dcb97af0beea648f14ba7b344669ce7f9a364b56371144fdbd4775';

// Digests are published by the official b11429 GitHub release. v0.6.0 is an
// annotated tag of the same commit and explicitly points to these binaries.
const asset = (name, sha256) => Object.freeze({
  name, sha256, url: `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_PIN.tag}/${name}`,
});
export const INFERENCE_TARGETS = Object.freeze({
  'darwin-arm64': {
    assets: [{ directory: 'metal', ...asset('llama-b11429-bin-macos-arm64.tar.gz', '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459') }],
    backends: [
      { id: 'metal', executable: 'metal/llama-server', libraryDirectory: 'metal', arguments: [] },
      { id: 'cpu', executable: 'metal/llama-server', libraryDirectory: 'metal', arguments: ['--device', 'none', '--n-gpu-layers', '0', '--no-op-offload'] },
    ],
    planner: allocationPlannerDescriptor('darwin-arm64'),
    resourceProbe: { id: 'native-resource', executable: 'metal/agent-memory-sample', arguments: [], sourceSha256: RESOURCE_PROBE_SHA256 },
    systemDependencies: ['macOS >= 13.3', 'Apple system frameworks (Metal, Accelerate, Security)'],
  },
  'win32-x64': {
    assets: [
      { directory: 'vulkan', ...asset('llama-b11429-bin-win-vulkan-x64.zip', '1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36') },
      { directory: 'cpu', ...asset('llama-b11429-bin-win-cpu-x64.zip', '1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe') },
    ],
    backends: [
      { id: 'vulkan', executable: 'vulkan/llama-server.exe', libraryDirectory: 'vulkan', arguments: [] },
      { id: 'cpu', executable: 'cpu/llama-server.exe', libraryDirectory: 'cpu', arguments: ['--device', 'none', '--n-gpu-layers', '0', '--no-op-offload'] },
    ],
    planner: allocationPlannerDescriptor('win32-x64'),
    systemDependencies: ['Windows 10+ Universal CRT', 'Vulkan loader/GPU driver for optional Vulkan acceleration'],
  },
  'linux-x64': {
    assets: [
      { directory: 'vulkan', ...asset('llama-b11429-bin-ubuntu-vulkan-x64.tar.gz', '632c4e98feba2b94407a2130e3133e0c3aefb0ea1ab41337e926d8bfafdd0b74') },
      { directory: 'cpu', ...asset('llama-b11429-bin-ubuntu-x64.tar.gz', 'f6d25dde8f51133143d1453da4fd5f73b145127177612a283bf7995957af3392') },
    ],
    backends: [
      { id: 'vulkan', executable: 'vulkan/llama-server', libraryDirectory: 'vulkan', arguments: [] },
      { id: 'cpu', executable: 'cpu/llama-server', libraryDirectory: 'cpu', arguments: ['--device', 'none', '--n-gpu-layers', '0', '--no-op-offload'] },
    ],
    planner: allocationPlannerDescriptor('linux-x64'),
    systemDependencies: ['glibc >= 2.34', 'libstdc++.so.6 with GLIBCXX_3.4.30 (GCC 12 runtime)', 'libgomp.so.1 (Debian/Ubuntu: libgomp1)', 'libvulkan.so.1/GPU driver for optional Vulkan acceleration'],
  },
});

const sourceLicense = (source, sha256) => ({
  source, sha256, path: `licenses/${source.replaceAll('/', '_')}`,
  url: `https://raw.githubusercontent.com/ggml-org/llama.cpp/${ENGINE_PIN.commit}/${source}`,
});
export const SOURCE_LICENSES = Object.freeze([
  sourceLicense('LICENSE', '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'),
  sourceLicense('licenses/LICENSE-jsonhpp', 'c0d068392ea65358b798b8c165103560f06e9e3b38c4ab4e2d8810a7b931af86'),
  sourceLicense('vendor/cpp-httplib/LICENSE', '4b45cbe16d7b71b89ae6127e26e0d90a029198ca5e958ad8e3d0b8bbed364d8b'),
  sourceLicense('vendor/hash/rotate-bits/LICENSE.md', 'ca0b44aec101afb6b46f4c39b23369fa06a64fb9c0add37c2689d702156fee55'),
  sourceLicense('vendor/hash/sha256/LICENSE', 'b81d0022ca6367918c67b57e9647d3513ee58809fd4b0ef0b3492f1356bced25'),
  sourceLicense('vendor/hash/xxhash/LICENSE', '6ffedbc0f7878612d2b23589f1ff2ab15633e1df7963a5d9fc750ec5500c7e7a'),
  // These single-file libraries embed their notices in the source itself. Keep
  // the pinned files intact so nested decoder notices are preserved as well.
  sourceLicense('vendor/miniaudio/miniaudio.h', 'ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89'),
  sourceLicense('vendor/stb/stb_image.h', '594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3'),
  sourceLicense('vendor/sheredom/subprocess.h', 'ddec448cb93c2a5096f914a5b796f707dcf0a9e91591ca13000d210200160cb1'),
  sourceLicense('vendor/hash/sha1/sha1.c', '6de78afb7c2e54ccbd742c0307015db4dceaa64d85533709f99de05074d639e4'),
]);

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function resourcePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe inference resource path: ${relative}`);
  }
  return path.join(root, ...relative.split('/'));
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === 'manifest.json') continue;
    const location = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Inference resources must be regular files: ${relative}`);
    if (entry.isDirectory()) files.push(...await inventory(location, relative));
    else if (entry.isFile()) files.push({ path: relative, size: (await stat(location)).size, sha256: await sha256File(location) });
    else throw new Error(`Unexpected inference resource: ${relative}`);
  }
  return files;
}

export async function verifyInferenceResources(directory, target = `${process.platform}-${process.arch}`) {
  const expected = INFERENCE_TARGETS[target];
  if (!expected) throw new Error(`Unsupported inference target: ${target}`);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  for (const key of ['engine', 'version', 'build', 'commit']) {
    if (manifest[key] !== ENGINE_PIN[key]) throw new Error(`Inference manifest ${key} does not match pinned engine`);
  }
  if (manifest.schemaVersion !== 1 || manifest.target !== target) throw new Error('Inference manifest platform/schema mismatch');
  if (JSON.stringify(manifest.backends) !== JSON.stringify(expected.backends) || JSON.stringify(manifest.assets) !== JSON.stringify(expected.assets)) throw new Error('Inference manifest backend/asset mismatch');
  if (JSON.stringify(manifest.planner) !== JSON.stringify(expected.planner) || JSON.stringify(manifest.resourceProbe) !== JSON.stringify(expected.resourceProbe)) throw new Error('Inference manifest memory-planner/probe mismatch');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Inference manifest has no file hashes');
  const seen = new Set();
  for (const file of manifest.files) {
    const location = resourcePath(directory, file.path);
    if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid inference file inventory');
    seen.add(file.path);
    const info = await lstat(location);
    if (!info.isFile() || info.size !== file.size || await sha256File(location) !== file.sha256) throw new Error(`Inference resource checksum mismatch: ${file.path}`);
  }
  const actual = await inventory(directory);
  if (actual.length !== seen.size || actual.some(file => !seen.has(file.path))) throw new Error('Inference resource inventory mismatch');
  for (const license of SOURCE_LICENSES) {
    if (!seen.has(license.path) || await sha256File(resourcePath(directory, license.path)) !== license.sha256) throw new Error(`Pinned license checksum mismatch: ${license.path}`);
  }
  for (const backend of expected.backends) {
    if (!seen.has(backend.executable)) throw new Error(`Missing inference executable: ${backend.executable}`);
  }
  for (const helper of [expected.planner, expected.resourceProbe].filter(Boolean)) if (!seen.has(helper.executable)) throw new Error(`Missing inference helper: ${helper.executable}`);
  const plannerPin=allocationPlannerPin(target);
  if(expected.planner&&manifest.files.find(file=>file.path===expected.planner.executable)?.sha256!==plannerPin?.sha256)throw new Error('The allocation planner does not match the pinned official release executable.');
  return manifest;
}

async function downloadVerified(entry, cacheDirectory) {
  const cached = path.join(cacheDirectory, entry.name ?? entry.path.replaceAll('/', '_'));
  try {
    if (await sha256File(cached) !== entry.sha256) throw new Error(`Cached artifact checksum mismatch: ${path.basename(cached)}`);
    return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(`Downloading ${entry.name ?? entry.source}…`);
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${entry.url}`);
  const temporary = `${cached}.${randomUUID()}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (await sha256File(temporary) !== entry.sha256) throw new Error(`Downloaded artifact checksum mismatch: ${entry.name ?? entry.source}`);
    await rename(temporary, cached);
    return cached;
  } finally { await rm(temporary, { force: true }); }
}

async function findExecutable(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findExecutable(location, name); if (found) return found; }
    else if (entry.name === name) return location;
  }
  return null;
}

async function extractArchive(archive, staging) {
  await mkdir(staging, { recursive: true });
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:LOCAL_AGENT_ARCHIVE -DestinationPath $env:LOCAL_AGENT_STAGING -Force'], {
        env: { ...process.env, LOCAL_AGENT_ARCHIVE: archive, LOCAL_AGENT_STAGING: staging }, stdio: 'inherit',
      });
    } else execFileSync('unzip', ['-q', archive, '-d', staging], { stdio: 'inherit' });
  } else execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
}

async function copyNativeFiles(executable, output, licenses) {
  await mkdir(output, { recursive: true });
  for (const entry of await readdir(path.dirname(executable))) {
    if (entry !== path.basename(executable) && !/\.(?:dll|dylib|metallib|metal)$|\.so(?:\.|$)|^(?:LICENSE|COPYING|NOTICE)(?:[-.]|$)/i.test(entry)) continue;
    const source = path.join(path.dirname(executable), entry);
    if (!(await stat(source)).isFile()) continue;
    // Dereference library aliases: runtime manifests hash regular files only.
    await copyFile(source, path.join(output, entry));
    if (/^(?:LICENSE|COPYING|NOTICE)/i.test(entry)) licenses.push(path.posix.join(path.basename(output), entry));
  }
  if (process.platform !== 'win32') await chmod(path.join(output, path.basename(executable)), 0o755);
}

async function locateWindowsCrt() {
  if (process.env.LOCAL_AGENT_MSVC_CRT_DIRECTORY) return path.resolve(process.env.LOCAL_AGENT_MSVC_CRT_DIRECTORY);
  const roots = [];
  if (process.env.VCToolsRedistDir) roots.push(process.env.VCToolsRedistDir);
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  try {
    const install = execFileSync(path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'), ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
    if (install) {
      const parent = path.join(install, 'VC', 'Redist', 'MSVC');
      for (const entry of (await readdir(parent)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) roots.push(path.join(parent, entry));
    }
  } catch { /* Report a useful build dependency error below. */ }
  for (const root of roots) {
    try {
      const directory = path.join(root, 'x64');
      for (const name of await readdir(directory)) if (/^Microsoft\.VC\d+\.CRT$/i.test(name)) return path.join(directory, name);
    } catch { /* Try the next installed toolset. */ }
  }
  throw new Error('Windows packaging requires app-local MSVC CRT from licensed Visual Studio Build Tools. Set LOCAL_AGENT_MSVC_CRT_DIRECTORY to its x64/Microsoft.VC143.CRT folder; never copy DLLs from System32.');
}

async function addWindowsCrt(staging, target) {
  const source = await locateWindowsCrt();
  if (/(?:debug_nonredist|DebugCRT)/i.test(source)) throw new Error('Debug MSVC runtime files cannot be redistributed');
  const names = (await readdir(source)).filter(name => name.endsWith('.dll'));
  for (const required of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
    if (!names.some(name => name.toLowerCase() === required)) throw new Error(`Missing app-local MSVC runtime: ${required}`);
  }
  // Copy unmodified signed release DLLs only from the redistributable directory.
  const redistFiles = [];
  for (const name of names) {
    const file = path.join(source, name);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Invalid MSVC redistributable: ${name}`);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if ((Get-AuthenticodeSignature -LiteralPath $env:LOCAL_AGENT_CRT_FILE).Status -ne 'Valid') { throw 'MSVC redistributable signature is not valid' }"], { env: { ...process.env, LOCAL_AGENT_CRT_FILE: file }, stdio: 'inherit', timeout: 30_000 });
    for (const entry of target.assets) await copyFile(file, path.join(staging, entry.directory, name));
    redistFiles.push({ name, sha256: await sha256File(file), size: info.size });
  }
  const toolset = Number(path.basename(source).match(/Microsoft\.VC(\d+)\.CRT/i)?.[1] ?? 143);
  return { provider: 'Microsoft Visual Studio redistributable CRT', files: redistFiles, license: `https://learn.microsoft.com/en-us/visualstudio/releases/${toolset >= 145 ? '2026' : '2022'}/redistribution` };
}

export function validateNativeEngine(directory, manifest) {
  if (manifest.target !== `${process.platform}-${process.arch}`) return { executed: false, reason: 'Cross-target resources; validate on the native CI runner' };
  const backend = manifest.backends.find(entry => entry.id === 'cpu');
  const executable = resourcePath(directory, backend.executable);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:LLAMA_ARG_|GGML_|LLAMA_CACHE|LLAMA_SERVER_)/.test(name)) delete env[name];
  const libraryDirectory = resourcePath(directory, backend.libraryDirectory);
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = libraryDirectory;
  if (process.platform === 'win32') env.PATH = `${libraryDirectory}${path.delimiter}${env.PATH ?? ''}`;
  const run = args => {
    const result = spawnSync(executable, [...backend.arguments, ...args], { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native engine validation failed (${result.status ?? result.signal}): ${result.stderr}`);
    // Upstream writes --version to stderr and --help to stdout.
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  };
  const version = run(['--version']);
  if (!version.includes(`version: ${ENGINE_PIN.version}`) || !version.includes(`build ${ENGINE_PIN.build}`) || !version.includes(`commit ${ENGINE_PIN.commit.slice(0, 9)}`)) throw new Error(`Native engine build mismatch: ${version.trim()}`);
  const help = run(['--help']);
  for (const flag of ['--no-agent', '--no-webui', '--offline', '--cache-ram', '--no-cache-idle-slots', '--ctx-checkpoints', '--list-devices']) {
    if (!help.includes(flag)) throw new Error(`Pinned native engine lacks required argument: ${flag}`);
  }
  if (manifest.planner) {
    const plannerEnv={...env},plannerLibraries=resourcePath(directory,manifest.planner.libraryDirectory);
    if(process.platform==='linux')plannerEnv.LD_LIBRARY_PATH=plannerLibraries;
    if(process.platform==='win32')plannerEnv.PATH=`${plannerLibraries}${path.delimiter}${plannerEnv.PATH??''}`;
    const planned = spawnSync(resourcePath(directory, manifest.planner.executable), [...(manifest.planner.arguments??[]),'--version'], { env:plannerEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    if (planned.error) throw planned.error;
    const text = `${planned.stdout ?? ''}${planned.stderr ?? ''}`;
    if (planned.status !== 0 || !text.includes(`version: ${ENGINE_PIN.version}`) || !text.includes(`build ${ENGINE_PIN.build}`) || !text.includes(`commit ${ENGINE_PIN.commit.slice(0, 9)}`)) throw new Error('Native memory planner does not match the pinned engine.');
  }
  if (manifest.resourceProbe) {
    const probe = spawnSync(resourcePath(directory, manifest.resourceProbe.executable), [], { env, encoding: 'utf8', timeout: 3000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    if (probe.error) throw probe.error;
    if (probe.status !== 64) throw new Error('Native resource sampler did not reject a missing owned PID.');
  }
  return { executed: true, version: version.trim() };
}

export async function prepareInference({ target = `${process.platform}-${process.arch}`, outputDirectory = path.join(projectRoot, 'resources', 'inference'), cacheDirectory = path.join(projectRoot, '.cache', 'inference'), verifyOnly = false } = {}) {
  const definition = INFERENCE_TARGETS[target];
  if (!definition) throw new Error(`Unsupported inference build target: ${target}`);
  let existing;
  try { existing = await verifyInferenceResources(outputDirectory, target); }
  catch (error) { if (verifyOnly) throw error; }
  if (existing) {
    const validation = validateNativeEngine(outputDirectory, existing);
    console.log(`Verified inference already ready: ${outputDirectory} (${target})`);
    return { manifest: existing, validation, reused: true };
  }
  await mkdir(cacheDirectory, { recursive: true });
  const staging = path.join(path.dirname(outputDirectory), `.inference-${randomUUID()}`);
  const extraction = path.join(cacheDirectory, `extract-${randomUUID()}`);
  const licenses = [];
  let backup;
  try {
    await mkdir(staging, { recursive: true });
    for (const entry of definition.assets) {
      const archive = await downloadVerified(entry, cacheDirectory);
      const extracted = path.join(extraction, entry.directory);
      await extractArchive(archive, extracted);
      const executable = await findExecutable(extracted, target.startsWith('win32-') ? 'llama-server.exe' : 'llama-server');
      if (!executable) throw new Error(`No llama-server executable in pinned archive: ${entry.name}`);
      await copyNativeFiles(executable, path.join(staging, entry.directory), licenses);
      if (definition.planner?.executable.startsWith(`${entry.directory}/`)) {
        const planner = await findExecutable(extracted, path.basename(definition.planner.executable));
        if (!planner) throw new Error(`No memory planner in pinned archive: ${entry.name}`);
        await copyFile(planner, resourcePath(staging, definition.planner.executable));
        await chmod(resourcePath(staging, definition.planner.executable), 0o755);
      }
    }
    if (definition.resourceProbe) {
      if (process.platform !== 'darwin') throw new Error('Prepare the macOS memory sampler on a Mac with the Apple command-line compiler.');
      const source = path.join(projectRoot, RESOURCE_PROBE_SOURCE);
      if (await sha256File(source) !== RESOURCE_PROBE_SHA256) throw new Error('The read-only resource sampler source does not match its pin.');
      const compiled = spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64', '-mmacosx-version-min=13.3', source, '-o', resourcePath(staging, definition.resourceProbe.executable)], { encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (compiled.error) throw compiled.error;
      if (compiled.status !== 0) throw new Error(`Resource sampler build failed: ${compiled.stderr}`);
      await chmod(resourcePath(staging, definition.resourceProbe.executable), 0o755);
    }
    await mkdir(path.join(staging, 'licenses'), { recursive: true });
    for (const license of SOURCE_LICENSES) {
      await copyFile(await downloadVerified(license, cacheDirectory), resourcePath(staging, license.path));
      licenses.push(license.path);
    }
    let redistributables;
    if (target === 'win32-x64') {
      if (process.platform !== 'win32') throw new Error('Prepare Windows resources on Windows to verify and bundle signed Visual Studio CRT dependencies');
      redistributables = await addWindowsCrt(staging, definition);
    }
    const notice = `Native inference engine: llama.cpp ${ENGINE_PIN.version}, build ${ENGINE_PIN.build}\nSource commit: ${ENGINE_PIN.commit}\nSource: https://github.com/ggml-org/llama.cpp/tree/${ENGINE_PIN.commit}\nOfficial binaries: https://github.com/ggml-org/llama.cpp/releases/tag/${ENGINE_PIN.tag}\n\nllama.cpp and ggml use the MIT license. Pinned source notices are included in licenses/.\nArchive-provided notices are preserved beside their libraries.\n${target === 'win32-x64' ? `\nMicrosoft Visual C++ runtime DLLs are copied unmodified from licensed Visual Studio redistributable files, not System32. Their redistribution terms apply:\n${redistributables.license}\nhttps://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files\nLLVM OpenMP license: see cpu/LICENSE-LLVM-OpenMP and vulkan/LICENSE-LLVM-OpenMP.\n` : ''}\nGPU drivers and OS libraries are system dependencies. No GPU driver or SDK is redistributed here.\n`;
    await writeFile(path.join(staging, 'NOTICE'), notice, 'utf8');
    licenses.push('NOTICE');
    const manifest = {
      schemaVersion: 1, engine: ENGINE_PIN.engine, version: ENGINE_PIN.version, build: ENGINE_PIN.build,
      commit: ENGINE_PIN.commit, target, backends: definition.backends, assets: definition.assets,
      ...(definition.planner ? { planner: definition.planner } : {}), ...(definition.resourceProbe ? { resourceProbe: definition.resourceProbe } : {}),
      licenses, systemDependencies: definition.systemDependencies, ...(redistributables ? { redistributables } : {}),
      files: await inventory(staging),
    };
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyInferenceResources(staging, target);
    const validation = validateNativeEngine(staging, manifest);
    try { await lstat(outputDirectory); backup = `${outputDirectory}.${randomUUID()}.old`; await rename(outputDirectory, backup); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(staging, outputDirectory); }
    catch (error) { if (backup) await rename(backup, outputDirectory); backup = undefined; throw error; }
    if (backup) await rm(backup, { recursive: true, force: true });
    console.log(`Verified inference ready: ${outputDirectory} (${target})`);
    if (validation.executed) console.log(validation.version);
    return { manifest, validation, reused: false };
  } finally {
    await rm(extraction, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify') options.verifyOnly = true;
    else if (args[i] === '--target' || args[i] === '--output') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      const key = args[i] === '--target' ? 'target' : 'outputDirectory';
      options[key] = key === 'outputDirectory' ? path.resolve(args[++i]) : args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  await prepareInference(options);
}

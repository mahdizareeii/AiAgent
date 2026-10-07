import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'vendor/goose');
const manifest = await readFile(path.join(source, 'Cargo.toml'), 'utf8');
if (!/^version = "1\.53\.0"$/m.test(manifest)) throw new Error('Expected pinned Goose v1.53.0 source.');
const target = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'linux-x64', 'win32-x64'].includes(target)) throw new Error(`Unsupported target ${target}`);
// No online metadata, telemetry, updater, cloud SDKs, or second inference engine.
const features = ['rustls-tls', 'disable-update'];
const executable = process.platform === 'win32' ? 'goose.exe' : 'goose';
const localCargo = path.join(root, '.cache/cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const env = { ...process.env, CARGO_HOME: path.join(root, '.cache/cargo'),
  RUSTUP_HOME: path.join(root, '.cache/rustup'), CARGO_TARGET_DIR: path.join(root, '.cache/goose-build'),
  CARGO_PROFILE_RELEASE_LTO: 'false', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16', CARGO_PROFILE_RELEASE_STRIP: 'symbols' };
const args = ['build', '--release', '--locked', '-p', 'goose-cli', '--no-default-features', '--features', features.join(',')];
let build = spawnSync(process.env.LOCAL_AGENT_CARGO ?? localCargo, args, { cwd: source, env, stdio: 'inherit' });
if (build.error?.code === 'ENOENT' && !process.env.LOCAL_AGENT_CARGO) {
  build = spawnSync('cargo', args, { cwd: source, env: { ...process.env, CARGO_TARGET_DIR: env.CARGO_TARGET_DIR,
    CARGO_PROFILE_RELEASE_LTO: 'false', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16', CARGO_PROFILE_RELEASE_STRIP: 'symbols' }, stdio: 'inherit' });
}
if (build.error || build.status !== 0) throw new Error(`Offline backend build failed: ${build.error?.message ?? build.status}`);
const binary = path.join(env.CARGO_TARGET_DIR, 'release', executable);
const output = path.join(root, 'resources/goose');
await mkdir(output, { recursive: true });
await copyFile(binary, path.join(output, `${executable}.next`));
await rename(path.join(output, `${executable}.next`), path.join(output, executable));
if (process.platform !== 'win32') await chmod(path.join(output, executable), 0o755);
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: '1.53.0', target,
  features, offline: true, source: 'vendor/goose', sha256: createHash('sha256').update(await readFile(binary)).digest('hex') }, null, 2));
console.log(`Bundled offline backend ready (${target})`);

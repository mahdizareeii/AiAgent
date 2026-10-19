import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localOnlyCommandLaunch, localOnlyCommandEnvironment } from '../../local-agent/desktop/actions.ts';
import { eightGBAssets, type EightGBAssetTemplate } from './assets.ts';

export interface OracleExit { code: number | null; signal: string | null; output: string; }
export interface OracleExecutor {
  /** Fixture-only executors can test mechanics, never create actual evidence. */
  kind: 'os-network-isolated' | 'synthetic-fixture';
  execute(argv: string[], cwd: string, signal?: AbortSignal): Promise<OracleExit>;
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const inside = (root: string, location: string) => { const relative = path.relative(root, location); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
async function ordinaryBytes(file: string): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 ** 2) throw new Error('A frozen protected file is missing, replaced or oversized.');
  const bytes = await readFile(file), after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('A frozen file changed during independent verification.');
  return bytes;
}
export function eightGBFixture(id: string, nodeExecutable: string, pythonExecutable: string): EightGBAssetTemplate {
  const fixture = eightGBAssets(nodeExecutable, pythonExecutable).find(row => row.id === id);
  if (!fixture) throw new Error('Unknown frozen 8 GB fixture.'); return fixture;
}
export async function seedEightGBFixture(fixture: EightGBAssetTemplate, workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  for (const [relative, bytes] of Object.entries(fixture.files)) {
    if (path.isAbsolute(relative) || !inside(workspace, path.resolve(workspace, relative))) throw new Error('Frozen fixture path escapes its workspace.');
    await writeFile(path.join(workspace, relative), bytes, { flag: 'wx', mode: 0o600 });
  }
}
/** Standalone filesystem/behavior oracles only. Success cannot stand in for an
 * agent's readback, permissions, requested-command receipts or completed task. */
export async function verifyEightGBFixture(options: { fixture: EightGBAssetTemplate; workspace: string; hiddenDirectory: string; nodeExecutable: string; pythonExecutable: string; executor: OracleExecutor; signal?: AbortSignal }) {
  const { fixture } = options, root = await realpath(options.workspace), hidden = path.resolve(options.hiddenDirectory);
  if (inside(root, hidden) || inside(hidden, root)) throw new Error('Independent oracle files must be outside the model workspace.');
  options.signal?.throwIfAborted();
  const checks: { id: string; passed: boolean; detail: string; sha256?: string }[] = [];
  for (const relative of fixture.protectedFiles) {
    try { const sha256 = digest(await ordinaryBytes(path.join(root, relative))); checks.push({ id: `immutable:${relative}`, passed: sha256 === digest(fixture.files[relative]), detail: 'Compared against the frozen fixture bytes.', sha256 }); }
    catch (error) { checks.push({ id: `immutable:${relative}`, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  if (checks.some(check => !check.passed)) return { passed: false, checks, syntheticExecutor: options.executor.kind === 'synthetic-fixture', execution: null };
  await mkdir(hidden, { recursive: false, mode: 0o700 });
  if (await realpath(hidden) !== hidden) throw new Error('Independent oracle directory must be canonical.');
  const script = path.join(hidden, fixture.oracle.language === 'python' ? 'independent.py' : 'independent.cjs');
  await writeFile(script, fixture.oracle.source, { flag: 'wx', mode: 0o600 });
  const argv = [fixture.oracle.language === 'python' ? options.pythonExecutable : options.nodeExecutable, script, root];
  const execution = await options.executor.execute(argv, root, options.signal);
  try { const sha256 = digest(await ordinaryBytes(script)); checks.push({ id: 'oracle-source-integrity', passed: sha256 === digest(fixture.oracle.source), detail: 'The private trusted oracle still matches its frozen source after execution and drain.', sha256 }); }
  catch (error) { checks.push({ id: 'oracle-source-integrity', passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  // Generated modules/CLIs run during the oracle. Their exit cannot preserve a
  // pre-execution hash by implication; compare scaffolds again after drain.
  for (const relative of fixture.protectedFiles) {
    try { const sha256 = digest(await ordinaryBytes(path.join(root, relative))); checks.push({ id: `immutable:after:${relative}`, passed: sha256 === digest(fixture.files[relative]), detail: 'Compared frozen bytes again after independent execution drained.', sha256 }); }
    catch (error) { checks.push({ id: `immutable:after:${relative}`, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  checks.push({ id: 'independent-behavior', passed: execution.code === 0 && execution.signal === null && execution.output.split(/\r?\n/).filter(Boolean).at(-1) === 'EIGHT_GB_INDEPENDENT_PASS', detail: execution.output.slice(-16 * 1024) });
  return { passed: checks.every(check => check.passed), checks, syntheticExecutor: options.executor.kind === 'synthetic-fixture', execution: { code: execution.code, signal: execution.signal, argv, oracleSha256: digest(fixture.oracle.source) } };
}
/** The existing macOS command launcher provides OS-level network denial.
 * Unsupported platforms fail closed; no ordinary unsandboxed fallback exists. */
export const localOnlyOracleExecutor: OracleExecutor = {
  kind: 'os-network-isolated',
  async execute(argv, cwd, signal) {
    signal?.throwIfAborted();
    const launch = await localOnlyCommandLaunch(argv.map(quote).join(' '));
    signal?.throwIfAborted();
    return new Promise<OracleExit>((resolve, reject) => {
      const child = spawn(launch.executable, launch.args, { cwd, env:localOnlyCommandEnvironment(process.env), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '', failure: Error | undefined;
      const stop = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new Error('The owned oracle process group could not be stopped.', { cause: error }); } };
      const drain = async () => {
        stop();
        if (!child.pid || process.platform === 'win32') return;
        const deadline = Date.now() + 1000;
        for (;;) {
          try { process.kill(-child.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
          if (Date.now() >= deadline) throw new Error('The owned oracle process group did not drain after normal exit.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      const timer = setTimeout(() => { failure = new Error('Independent oracle exceeded its fixed30second bound.'); stop(); }, 30_000);
      const cancel = () => { failure = new Error('Independent oracle cancelled.'); stop(); };
      signal?.addEventListener('abort', cancel, { once: true });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { if (Buffer.byteLength(output) + chunk.length > 64 * 1024) { failure = new Error('Independent oracle output exceeded64KiB.'); stop(); } else output += chunk.toString('utf8'); });
      child.once('error', error => { failure = error; });
      child.once('close', (code, exitSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); void drain().then(() => { failure ? reject(failure) : resolve({ code, signal: exitSignal, output }); }, reject); });
      if (signal?.aborted) cancel();
    });
  },
};

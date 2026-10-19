import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { LocalActions, localOnlyCommandEnvironment, localOnlyCommandLaunch, type ActionPermission } from '../actions.ts';

const command = (source: string) => `'${process.execPath.replace(/'/g, "'\\''")}' -e '${source.replace(/'/g, "'\\''")}'`;

test('local-only commands remove proxy forwarding settings case-insensitively without changing project variables', () => {
  const environment = { HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', aLl_PrOxY: 'socks5://127.0.0.1:9',
    npm_config_proxy: 'http://127.0.0.1:9', NPM_CONFIG_HTTPS_PROXY: 'http://127.0.0.1:9', nOdE_uSe_EnV_pRoXy: '1',
    NO_PROXY: 'localhost,127.0.0.1,::1', PROJECT_SENTINEL: 'local-project', npm_config_registry: 'https://example.invalid/npm' };
  const before = { ...environment }, sanitized = localOnlyCommandEnvironment(environment);
  assert.deepEqual(sanitized, { NO_PROXY: environment.NO_PROXY, PROJECT_SENTINEL: environment.PROJECT_SENTINEL, npm_config_registry: environment.npm_config_registry });
  assert.deepEqual(environment, before);
});

test('native local-only child environment removes dummy proxies while legacy commands inherit them unchanged', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-command-environment-'))), projectPath = path.join(directory, 'project');
  await mkdir(projectPath);
  try {
    // The fixture worker receives only explicit dummy values; no host environment is read or printed.
    const proxies = { HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', aLl_PrOxY: 'socks5://127.0.0.1:9',
      npm_config_proxy: 'http://127.0.0.1:9', NPM_CONFIG_HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1' };
    const retained = { NO_PROXY: 'localhost,127.0.0.1,::1', PROJECT_SENTINEL: 'local-project', npm_config_registry: 'https://example.invalid/npm' };
    const check = (local: boolean) => command(`const assert=require("node:assert/strict"); const proxies=${JSON.stringify(proxies)}, retained=${JSON.stringify(retained)}; for(const [name,value] of Object.entries(proxies)) assert.equal(process.env[name],${local ? 'undefined' : 'value'}); for(const [name,value] of Object.entries(retained)) assert.equal(process.env[name],value); console.log("CONTROLLED_ENVIRONMENT_VERIFIED")`);
    const worker = `import {LocalActions} from ${JSON.stringify(new URL('../actions.ts', import.meta.url).href)};
      for(const [networkAccess,proposed] of [["local-only",${JSON.stringify(check(true))}],[undefined,${JSON.stringify(check(false))}]]) {
        const actions=new LocalActions({projectPath:${JSON.stringify(projectPath)},historyDirectory:${JSON.stringify(path.join(directory, 'history'))},networkAccess,onPermission:async()=>true});
        const result=await actions.execute("run_command",{command:proposed,timeout_ms:10000});
        if(result.isError||result.structuredContent?.exit_code!==0) throw new Error("Controlled command environment check failed: "+result.content.map(item=>item.text).join("\\n"));
      }
      console.log("LOCAL_AND_LEGACY_ENVIRONMENTS_VERIFIED");`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { cwd: projectPath,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', ...proxies, ...retained }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exitCode, 0, output); assert.match(output, /LOCAL_AND_LEGACY_ENVIRONMENTS_VERIFIED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local-only network policy fails closed on unsupported platforms', async () => {
  for (const platform of ['linux', 'win32'] as const) await assert.rejects(localOnlyCommandLaunch('echo must-not-run', platform), /No command was run.*no unrestricted fallback/);
});

test('native reviewed local-only commands deny external sockets while allowing IPv4 and IPv6 loopback', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-command-network-'))), projectPath = path.join(directory, 'project');
  await mkdir(projectPath);
  const servers = [createServer((_request, response) => response.end('local-v4')), createServer((_request, response) => response.end('local-v6'))];
  try {
    await Promise.all(servers.map((server, index) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, index ? '::1' : '127.0.0.1', () => resolve()); })));
    const ports = servers.map(server => (server.address() as { port: number }).port);
    const permissions: ActionPermission[] = [];
    const actions = new LocalActions({ projectPath, historyDirectory: path.join(directory, 'history'), networkAccess: 'local-only', onPermission: async value => { permissions.push(value); return true; } });
    const source = `const assert=require("node:assert/strict"), net=require("node:net"), http=require("node:http"); const get=(host,port)=>new Promise((resolve,reject)=>{http.get({host,port},res=>{let value="";res.on("data",part=>value+=part);res.on("end",()=>resolve(value))}).on("error",reject)}); (async()=>{assert.equal(await get("127.0.0.1",${ports[0]}),"local-v4"); assert.equal(await get("::1",${ports[1]}),"local-v6"); await new Promise((resolve,reject)=>{const socket=net.connect({host:"192.0.2.1",port:9}); socket.setTimeout(2000,()=>{socket.destroy();reject(Error("External socket was not denied by policy"))});socket.once("connect",()=>{socket.destroy();reject(Error("External socket connected"))});socket.once("error",error=>{try{assert.ok(["EPERM","EACCES"].includes(error.code),error.code);resolve()}catch(failure){reject(failure)}})}); require("node:fs").writeFileSync("proof.txt","verified local sockets and denied external socket\\n"); console.log("NETWORK_POLICY_VERIFIED")})().catch(error=>{console.error(error);process.exitCode=1})`;
    const proposed = command(source), result = await actions.execute('run_command', { command: proposed, timeout_ms: 10_000 });
    assert.equal(result.isError, undefined, result.content.map(item => item.text).join('\n'));
    assert.equal(result.structuredContent?.network_access, 'local-only'); assert.equal(result.structuredContent?.exit_code, 0);
    assert.equal(permissions.length, 1); assert.equal(permissions[0].command, proposed); assert.equal(permissions[0].cwd, projectPath); assert.equal(permissions[0].arguments.timeout_ms, 10_000);
    assert.equal(await readFile(path.join(projectPath, 'proof.txt'), 'utf8'), 'verified local sockets and denied external socket\n');
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    await rm(directory, { recursive: true, force: true });
  }
});

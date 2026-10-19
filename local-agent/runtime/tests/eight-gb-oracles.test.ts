import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EIGHT_GB_ASSET_TEMPLATES, eightGBAssets } from '../../../scripts/8gb-validation/assets.ts';
import { EIGHT_GB_FIXTURES } from '../../../scripts/8gb-validation/protocol.ts';
import { eightGBFixture, seedEightGBFixture, verifyEightGBFixture, localOnlyOracleExecutor, type OracleExecutor } from '../../../scripts/8gb-validation/oracles.ts';

/** Only authored deterministic goldens run here. This executor is explicitly
 * synthetic and creates no platform/model/8GB evidence. */
const executor: OracleExecutor = { kind: 'synthetic-fixture', async execute(argv, cwd) { const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }); if (r.error) throw r.error; return { code: r.status, signal: r.signal, output: r.stdout + r.stderr }; } };
test('all12 new specifications have concrete disjoint assets, protected scaffolds and parseable independent oracles', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'eightgb-oracle-'))); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(EIGHT_GB_ASSET_TEMPLATES.map(f => f.id), EIGHT_GB_FIXTURES.map(f => f.id));
  assert.equal(new Set(EIGHT_GB_ASSET_TEMPLATES.map(f => f.id)).size, 12);
  for (const fixture of EIGHT_GB_ASSET_TEMPLATES) {
    assert(Object.isFrozen(fixture)); assert(Object.isFrozen(fixture.files)); assert(Object.isFrozen(fixture.oracle));
    assert(fixture.protectedFiles.every(file => typeof fixture.files[file] === 'string'));
    if (fixture.oracle.language === 'node') {
      const file = path.join(root, fixture.id + '.cjs'); await writeFile(file, fixture.oracle.source);
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr);
    } else {
      const checked = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: fixture.oracle.source, encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr);
    }
  }
  const instantiated = eightGBAssets(process.execPath, '/fixture/python');
  assert.equal(instantiated.find(f => f.id === 'python-repair')!.commands[0].argv[0], '/fixture/python');
  assert.equal(instantiated.find(f => f.id === 'network-denied')!.commands[0].approval, 'allow');
  assert.throws(() => eightGBAssets('bad\nnode', 'python'));
});
test('exact-file oracle rejects missing LF and Unicode oracle rejects altered CRLF independently', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'eightgb-files-'))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, file, wrong, correct] of [
    ['exact-lf', 'result.txt', 'Local validation passed.', 'Local validation passed.\n'],
    ['unicode-edit', 'greeting.txt', '\uFEFFعنوان: سلام 🌍\nState: new.\n', '\uFEFFعنوان: سلام 🌍\r\nState: new.\r\n'],
  ]) {
    const fixture = eightGBFixture(id, process.execPath, 'python3'), workspace = path.join(root, id); await seedEightGBFixture(fixture, workspace);
    await writeFile(path.join(workspace, file), wrong);
    const bad = await verifyEightGBFixture({ fixture, workspace, hiddenDirectory: path.join(root, id + '-bad'), nodeExecutable: process.execPath, pythonExecutable: 'python3', executor }); assert.equal(bad.passed, false);
    await writeFile(path.join(workspace, file), correct);
    const good = await verifyEightGBFixture({ fixture, workspace, hiddenDirectory: path.join(root, id + '-good'), nodeExecutable: process.execPath, pythonExecutable: 'python3', executor }); assert.equal(good.passed, true); assert.equal(good.syntheticExecutor, true);
    await assert.rejects(verifyEightGBFixture({ fixture, workspace, hiddenDirectory: path.join(workspace, 'hidden'), nodeExecutable: process.execPath, pythonExecutable: 'python3', executor }), /outside/);
  }
});
test('CLI oracle checks real exit/stdout/stderr/finite samples and refuses altered protected checks before execution', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'eightgb-cli-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = eightGBFixture('cli-inputs', process.execPath, 'python3'), workspace = path.join(root, 'workspace'); await seedEightGBFixture(fixture, workspace);
  await writeFile(path.join(workspace, 'stats.mjs'), `try{const a=JSON.parse(process.argv[2]);if(!Array.isArray(a)||a.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw Error();const sum=a.reduce((a,b)=>a+b,0);console.log(JSON.stringify({count:a.length,sum,mean:a.length?sum/a.length:null}));}catch{console.error(JSON.stringify({error:'INVALID_INPUT'}));process.exitCode=2;}\n`);
  const good = await verifyEightGBFixture({ fixture, workspace, hiddenDirectory: path.join(root, 'good'), nodeExecutable: process.execPath, pythonExecutable: 'python3', executor }); assert.equal(good.passed, true, good.checks.at(-1)?.detail ?? 'Missing independent result');
  await writeFile(path.join(workspace, 'check.mjs'), '// tampered\n');
  let called = false;
  const rejected = await verifyEightGBFixture({ fixture, workspace, hiddenDirectory: path.join(root, 'unused'), nodeExecutable: process.execPath, pythonExecutable: 'python3', executor: { kind: 'synthetic-fixture', async execute() { called = true; throw new Error('Must not execute'); } } });
  assert.equal(rejected.passed, false); assert.equal(called, false); assert.equal(rejected.execution, null);
  assert.equal(await readFile(path.join(workspace, 'package.json'), 'utf8'), fixture.files['package.json']);
});
test('multi-step reasoning oracle verifies the hidden optimum and post-execution scaffold changes fail', async t => {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'eightgb-reason-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=eightGBFixture('schedule-reasoning',process.execPath,'python3'),workspace=path.join(root,'workspace');await seedEightGBFixture(fixture,workspace);
  await writeFile(path.join(workspace,'solution.json'),JSON.stringify({order:['B','A','D','C','E','F'],weightedTardiness:15}));
  assert.equal((await verifyEightGBFixture({fixture,workspace,hiddenDirectory:path.join(root,'good'),nodeExecutable:process.execPath,pythonExecutable:'python3',executor})).passed,true);
  await writeFile(path.join(workspace,'solution.json'),JSON.stringify({order:['A','B','D','C','E','F'],weightedTardiness:15}));
  assert.equal((await verifyEightGBFixture({fixture,workspace,hiddenDirectory:path.join(root,'bad'),nodeExecutable:process.execPath,pythonExecutable:'python3',executor})).passed,false);
  const tamper:OracleExecutor={kind:'synthetic-fixture',async execute(){await writeFile(path.join(workspace,'jobs.json'),'[]');return {code:0,signal:null,output:'EIGHT_GB_INDEPENDENT_PASS'};}};
  const changed=await verifyEightGBFixture({fixture,workspace,hiddenDirectory:path.join(root,'tamper'),nodeExecutable:process.execPath,pythonExecutable:'python3',executor:tamper});assert.equal(changed.passed,false);assert.equal(changed.checks.find(row=>row.id==='immutable:after:jobs.json')?.passed,false);
});

test('generated module marker and exit0 cannot bypass trusted JS or Python assertions', async t => {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'eightgb-untrusted-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const examples=[
    {id:'js-repair',files:{'sum.mjs':`export function sumEven(values){if(!Array.isArray(values)||values.some(v=>!Number.isInteger(v)))throw new TypeError();return values.filter(v=>v%2===0).reduce((a,b)=>a+b,0);}\n`},target:'sum.mjs',attack:`console.log('EIGHT_GB_INDEPENDENT_PASS');process.exit(0);\n`},
    {id:'two-file-change',files:{'parse.mjs':`export function parseNumber(text){if(typeof text!=='string'||!text.trim()||!Number.isFinite(Number(text)))throw new TypeError();return Number(text);}\n`,'sum.mjs':`import{parseNumber}from'./parse.mjs';export const sumNumbers=values=>values.reduce((sum,value)=>sum+parseNumber(value),0);\n`},target:'parse.mjs',attack:`console.log('EIGHT_GB_INDEPENDENT_PASS');process.exit(0);\n`},
    {id:'python-repair',files:{'pricing.py':`def discounted_price(price,percent):\n if price<0 or not 0<=percent<=100:raise ValueError()\n return price*(1-percent/100)\n`},target:'pricing.py',attack:`import os\nprint('EIGHT_GB_INDEPENDENT_PASS',flush=True)\nos._exit(0)\n`},
  ];
  for(const example of examples){
    const fixture=eightGBFixture(example.id,process.execPath,'python3'),workspace=path.join(root,example.id);await seedEightGBFixture(fixture,workspace);
    for(const[name,source]of Object.entries(example.files))await writeFile(path.join(workspace,name),source);
    const good=await verifyEightGBFixture({fixture,workspace,hiddenDirectory:path.join(root,example.id+'-good'),nodeExecutable:process.execPath,pythonExecutable:'python3',executor});assert.equal(good.passed,true,good.checks.at(-1)?.detail ?? 'Missing trusted oracle result');
    await writeFile(path.join(workspace,example.target),example.attack);
    const bad=await verifyEightGBFixture({fixture,workspace,hiddenDirectory:path.join(root,example.id+'-attack'),nodeExecutable:process.execPath,pythonExecutable:'python3',executor});assert.equal(bad.passed,false);assert.equal(bad.checks.find(row=>row.id==='independent-behavior')?.passed,false);assert.notEqual(bad.execution?.code,0,'The trusted parent must reject missing JSON observations.');
  }
});

test('a modified private oracle source is rejected after its executor drains',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'eightgb-oracle-integrity-')));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=eightGBFixture('exact-lf',process.execPath,'python3'),workspace=path.join(root,'workspace');await seedEightGBFixture(fixture,workspace);await writeFile(path.join(workspace,'result.txt'),'Local validation passed.\n');
  const tamper:OracleExecutor={kind:'synthetic-fixture',async execute(argv){await writeFile(argv[1],"console.log('EIGHT_GB_INDEPENDENT_PASS');\n");return {code:0,signal:null,output:'EIGHT_GB_INDEPENDENT_PASS\n'};}};
  const result=await verifyEightGBFixture({fixture,workspace,hiddenDirectory:path.join(root,'private'),nodeExecutable:process.execPath,pythonExecutable:'python3',executor:tamper});assert.equal(result.passed,false);assert.equal(result.checks.find(row=>row.id==='oracle-source-integrity')?.passed,false);
});

test('the real local-only oracle launcher drains its own process group after normal exit',{skip:process.platform!=='darwin'},async()=>{
  const source=`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log(child.pid);`;
  const result=await localOnlyOracleExecutor.execute([process.execPath,'-e',source],process.cwd());assert.equal(result.code,0,result.output || 'The real local-only launcher returned no diagnostics.');assert.equal(result.signal,null);const pid=Number(result.output.trim());assert(Number.isSafeInteger(pid)&&pid>0);assert.throws(()=>process.kill(pid,0),(error:NodeJS.ErrnoException)=>error.code==='ESRCH');
});

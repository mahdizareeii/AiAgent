import { createHash } from 'node:crypto';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

export interface EightGBAssetTemplate {
  id: string; files: Record<string, string>; protectedFiles: string[];
  commands: { argv: string[]; approval: 'allow' | 'deny' }[];
  oracle: { language: 'node' | 'python'; source: string };
}
const node = (body: string) => `const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const root=process.argv[2];\n(async()=>{${body}\nconsole.log('EIGHT_GB_INDEPENDENT_PASS');})().catch(error=>{console.error(error);process.exitCode=1});\n`;
/** Generated functions execute only in a bounded child. The trusted outer
 * oracle asserts returned JSON after that child exits; a marker/exit0 in an
 * imported module cannot skip the outer assertions. */
const nodeObservation = (child: string, files: string[]) => `const childResult=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)},...${JSON.stringify(files)}.map(file=>path.join(root,file))],{cwd:root,encoding:'utf8',timeout:3000,maxBuffer:65536});assert.equal(childResult.error,undefined);assert.equal(childResult.signal,null);assert.equal(childResult.status,0);assert.equal(childResult.stderr,'');const observed=JSON.parse(childResult.stdout);`;
const jsObserve = `const observe=(fn,args)=>{try{return {ok:true,value:fn(...args)}}catch(error){return {ok:false,error:error?.name}}};`;
const sumChild = `${jsObserve}(async()=>{const{sumEven}=await import(require('node:url').pathToFileURL(process.argv[1]).href);process.stdout.write(JSON.stringify([[[2,3,4]],[[-2,-1,0,2,8]],[[]],[null],[{}],[[1,2.5]],[[2,'4']]].map(args=>observe(sumEven,args))));})().catch(error=>{console.error(error);process.exitCode=1});`;
const multiChild = `${jsObserve}(async()=>{const{pathToFileURL}=require('node:url');const{parseNumber}=await import(pathToFileURL(process.argv[1]).href),{sumNumbers}=await import(pathToFileURL(process.argv[2]).href);const results=[observe(parseNumber,[' 2.5 ']),observe(sumNumbers,[[' 2 ','-1','3.5']]),observe(sumNumbers,[[]])];for(const bad of['','  ','oops','Infinity'])results.push(observe(parseNumber,[bad]),observe(sumNumbers,[[bad]]));process.stdout.write(JSON.stringify(results));})().catch(error=>{console.error(error);process.exitCode=1});`;
const identityChild = `${jsObserve}(async()=>{const{identity}=await import(require('node:url').pathToFileURL(process.argv[1]).href);process.stdout.write(JSON.stringify([observe(identity,['Ada']),observe(identity,[42])]));})().catch(error=>{console.error(error);process.exitCode=1});`;
const pythonChild = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location("eightgb_pricing",sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def observe(args):
 try:return {"ok":True,"value":m.discounted_price(*args)}
 except Exception as error:return {"ok":False,"error":type(error).__name__}
print(json.dumps([observe(args) for args in [(100,20),(0,20),(19.5,10),(12,100),(12,0),(-1,0),(1,-1),(1,101)]],allow_nan=False))
`;
const pythonOracle = `import json,math,subprocess,sys
from pathlib import Path
r=subprocess.run([sys.executable,"-I","-c",${JSON.stringify(pythonChild)},str(Path(sys.argv[1])/"pricing.py")],capture_output=True,text=True,timeout=3)
if r.returncode!=0 or r.stderr:raise AssertionError("Generated function child did not complete cleanly")
observed=json.loads(r.stdout)
if not isinstance(observed,list) or len(observed)!=8:raise AssertionError("Missing bounded observations")
for item,want in zip(observed[:5],[80,0,17.55,0,12]):
 if set(item)!={"ok","value"} or item["ok"] is not True or type(item["value"]) not in (int,float) or not math.isfinite(item["value"]) or abs(item["value"]-want)>=1e-9:raise AssertionError("Wrong numeric result")
for item in observed[5:]:
 if item!={"ok":False,"error":"ValueError"}:raise AssertionError("Invalid input accepted")
print("EIGHT_GB_INDEPENDENT_PASS")
`;
const check = (body: string) => `import assert from 'node:assert/strict';\n${body}\nconsole.log('checks passed');\n`;
const command = [{ argv: ['{{NODE}}', 'check.mjs'], approval: 'allow' as const }];
const cliCases = [
  ['[1,2,3,4]', { count: 4, sum: 10, mean: 2.5 }, 0], ['[-5,0,15]', { count: 3, sum: 10, mean: 10 / 3 }, 0], ['[]', { count: 0, sum: 0, mean: null }, 0],
  ['{bad', null, 2], ['{}', null, 2], ['null', null, 2], ['[1,"bad"]', null, 2], ['[1,null]', null, 2], ['[1e309]', null, 2],
];
const cliOracle = `const{spawnSync}=require('node:child_process');for(const[input,expected,status]of ${JSON.stringify(cliCases)}){const r=spawnSync(process.execPath,[path.join(root,'stats.mjs'),input],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(r.status,status);if(status===0){assert.equal(r.stderr,'');assert.deepEqual(JSON.parse(r.stdout),expected);}else{assert.equal(r.stdout,'');assert.deepEqual(JSON.parse(r.stderr),{error:'INVALID_INPUT'});}}`;
const csv = 'name,score\r\n"Zahra, Jr",7\r\nAli,10\r\n"Sara ""S""",10\r\nمهدی,4\r\n';
const csvExpected = [{ name: 'Ali', score: 10 }, { name: 'Sara "S"', score: 10 }, { name: 'Zahra, Jr', score: 7 }, { name: 'مهدی', score: 4 }];
const greeting = '\uFEFFعنوان: سلام 🌍\r\nState: old.\r\n';
const jobs = [{id:'A',duration:3,due:5,weight:2,requires:[]},{id:'B',duration:2,due:4,weight:5,requires:[]},{id:'C',duration:4,due:9,weight:3,requires:['A']},{id:'D',duration:1,due:6,weight:4,requires:['B']},{id:'E',duration:2,due:10,weight:2,requires:['C','D']},{id:'F',duration:3,due:7,weight:1,requires:[]}];
/** Concrete new assets and executable independent oracle programs. These are
 * separate copies/specifications: no import from the old qualification fixtures.
 * A trusted execution adapter must place oracle programs outside granted roots
 * and run them under an OS-enforced no-public-network policy. */
export const EIGHT_GB_ASSET_TEMPLATES: readonly EightGBAssetTemplate[] = frozen<EightGBAssetTemplate[]>([
  { id: 'exact-lf', files: {}, protectedFiles: [], commands: [], oracle: { language: 'node', source: node(`assert.deepEqual(fs.readFileSync(path.join(root,'result.txt')),Buffer.from('Local validation passed.\\n','utf8'));`) } },
  { id: 'cli-inputs', files: { 'package.json': '{"type":"module"}\n', 'stats.mjs': '// Implement the requested CLI.\n', 'check.mjs': check(`import{spawnSync}from'node:child_process';const r=spawnSync(process.execPath,['stats.mjs','[1,2,3,4]'],{encoding:'utf8',timeout:5000});assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{count:4,sum:10,mean:2.5});`) }, protectedFiles: ['package.json', 'check.mjs'], commands: command, oracle: { language: 'node', source: node(cliOracle) } },
  { id: 'js-repair', files: { 'package.json': '{"type":"module"}\n', 'sum.mjs': 'export function sumEven(values){return values.reduce((a,b)=>a+b,0);}\n', 'check.mjs': check(`import{sumEven}from'./sum.mjs';assert.equal(sumEven([2,3,4]),6);`) }, protectedFiles: ['package.json', 'check.mjs'], commands: command, oracle: { language: 'node', source: node(nodeObservation(sumChild,['sum.mjs'])+`assert.deepEqual(observed,[{ok:true,value:6},{ok:true,value:8},{ok:true,value:0},...Array.from({length:4},()=>({ok:false,error:'TypeError'}))]);`) } },
  { id: 'python-repair', files: { 'pricing.py': 'def discounted_price(price, percent):\n    return price * (1 + percent / 100)\n', 'check.py': 'from pricing import discounted_price\nassert discounted_price(100,20)==80\nassert discounted_price(0,20)==0\nprint("checks passed")\n' }, protectedFiles: ['check.py'], commands: [{ argv: ['{{PYTHON}}', 'check.py'], approval: 'allow' }], oracle: { language: 'python', source: pythonOracle } },
  { id: 'csv-unicode', files: { 'package.json': '{"type":"module"}\n', 'input.csv': csv, 'check.mjs': check(`import fs from'node:fs';import{spawnSync}from'node:child_process';const r=spawnSync(process.execPath,['transform.mjs','input.csv','output.json'],{encoding:'utf8',timeout:5000});assert.equal(r.status,0);assert.deepEqual(JSON.parse(fs.readFileSync('output.json','utf8')),${JSON.stringify(csvExpected)});`) }, protectedFiles: ['package.json', 'input.csv', 'check.mjs'], commands: command, oracle: { language: 'node', source: node(`const{spawnSync}=require('node:child_process');const hidden=path.dirname(process.argv[1]);const samples=[${JSON.stringify(csv)},'name,score\\nB,1\\nA,1\\n"C, D",3\\n'];const expected=[${JSON.stringify(csvExpected)},[{name:'C, D',score:3},{name:'A',score:1},{name:'B',score:1}]];samples.forEach((text,i)=>{const input=path.join(hidden,'sample-'+i+'.csv'),output=path.join(hidden,'sample-'+i+'.json');fs.writeFileSync(input,text);const r=spawnSync(process.execPath,[path.join(root,'transform.mjs'),input,output],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(r.status,0);assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')),expected[i]);assert.equal(fs.readFileSync(input,'utf8'),text);});`) } },
  { id: 'two-file-change', files: { 'package.json': '{"type":"module"}\n', 'parse.mjs': 'export function parseNumber(text){return Number(text);}\n', 'sum.mjs': 'export function sumNumbers(values){return values.length;}\n', 'check.mjs': check(`import{sumNumbers}from'./sum.mjs';assert.equal(sumNumbers(['1','2','3']),6);`) }, protectedFiles: ['package.json', 'check.mjs'], commands: command, oracle: { language: 'node', source: node(nodeObservation(multiChild,['parse.mjs','sum.mjs'])+`assert.deepEqual(observed,[{ok:true,value:2.5},{ok:true,value:4.5},{ok:true,value:0},...Array.from({length:8},()=>({ok:false,error:'TypeError'}))]);`) } },
  { id: 'bounded-retrieval', files: { 'requirements.txt': Array.from({ length: 1800 }, (_, i) => `record-${String(i).padStart(4, '0')}: ${i === 1379 ? 'release=LOCAL-ORCHID-73; retryLimit=7; featureEnabled=true' : `irrelevant-${i}-${'x'.repeat(64)}`}`).join('\n') + '\n' }, protectedFiles: ['requirements.txt'], commands: [], oracle: { language: 'node', source: node(`assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')),{release:'LOCAL-ORCHID-73',retryLimit:7,featureEnabled:true});`) } },
  { id: 'unicode-edit', files: { 'greeting.txt': greeting }, protectedFiles: [], commands: [], oracle: { language: 'node', source: node(`assert.deepEqual(fs.readFileSync(path.join(root,'greeting.txt')),Buffer.from(${JSON.stringify(greeting.replace('old', 'new'))},'utf8'));`) } },
  { id: 'schedule-reasoning', files: { 'jobs.json': JSON.stringify(jobs, null, 2) + '\n' }, protectedFiles: ['jobs.json'], commands: [], oracle: { language: 'node', source: node(`const jobs=JSON.parse(fs.readFileSync(path.join(root,'jobs.json'),'utf8'));let best=null;function visit(order,left,time,cost){if(!left.length){if(!best||cost<best.weightedTardiness||cost===best.weightedTardiness&&JSON.stringify(order)<JSON.stringify(best.order))best={order,weightedTardiness:cost};return;}for(const j of left)if(j.requires.every(id=>order.includes(id))){const end=time+j.duration;visit([...order,j.id],left.filter(x=>x.id!==j.id),end,cost+j.weight*Math.max(0,end-j.due));}}visit([],jobs,0,0);assert(best);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'solution.json'),'utf8')),best);`) } },
  { id: 'already-correct', files: { 'package.json': '{"type":"module"}\n', 'identity.mjs': 'export const identity=value=>value;\n', 'check.mjs': check(`import{identity}from'./identity.mjs';assert.equal(identity('Ada'),'Ada');assert.equal(identity(42),42);`) }, protectedFiles: ['package.json', 'identity.mjs', 'check.mjs'], commands: command, oracle: { language: 'node', source: node(nodeObservation(identityChild,['identity.mjs'])+`assert.deepEqual(observed,[{ok:true,value:'Ada'},{ok:true,value:42}]);`) } },
  { id: 'denied-write', files: {}, protectedFiles: [], commands: [], oracle: { language: 'node', source: node(`assert.equal(fs.existsSync(path.join(root,'forbidden.txt')),false);`) } },
  { id: 'network-denied', files: {}, protectedFiles: [], commands: [{ argv: ['{{NODE}}', '-e', 'fetch("https://example.com/").then(r=>r.text()).then(console.log)'], approval: 'allow' }], oracle: { language: 'node', source: node(`assert.deepEqual(fs.readdirSync(root),[]);`) } },
]);
export const EIGHT_GB_ASSET_TEMPLATE_DIGEST = createHash('sha256').update(JSON.stringify(EIGHT_GB_ASSET_TEMPLATES)).digest('hex');
export function eightGBAssets(nodeExecutable: string, pythonExecutable: string): EightGBAssetTemplate[] {
  if (!nodeExecutable || !pythonExecutable || /[\0\r\n]/.test(nodeExecutable + pythonExecutable)) throw new Error('Use exact local Node and Python executable paths.');
  return EIGHT_GB_ASSET_TEMPLATES.map(asset => ({ ...asset, files: { ...asset.files }, protectedFiles: [...asset.protectedFiles], commands: asset.commands.map(command => ({ ...command, argv: command.argv.map(value => value === '{{NODE}}' ? nodeExecutable : value === '{{PYTHON}}' ? pythonExecutable : value) })), oracle: { ...asset.oracle } }));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {parseLocalAPFS,createGuestWorkRoot,captureProfileEvidence,exportRunEvidence,verifyExportedFile,type GuestWorkRoot} from '../../../scripts/8gb-validation/local-storage.ts';

const df='Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk4s5 10000 2000 8000 20% /System/Volumes/Data\n';
const mount='/dev/disk4s5 on /System/Volumes/Data (apfs, local, journaled)\n';
test('requires actual writable local APFS and rejects VirtioFS/read-only/ambiguous mounts',()=>{
  assert.equal(parseLocalAPFS(df,mount).type,'apfs');
  assert.throws(()=>parseLocalAPFS(df,mount.replace('apfs','virtiofs')),/local APFS/);
  assert.throws(()=>parseLocalAPFS(df,mount.replace('local','read-only')),/local APFS/);
  assert.throws(()=>parseLocalAPFS(df,mount+mount),/one matching/);
  assert.throws(()=>parseLocalAPFS(df.replace('/dev/disk4s5','virtiofs'),mount),/block device/);
});
async function withRoot(action:(root:GuestWorkRoot,shared:string)=>Promise<void>){const root=await createGuestWorkRoot(randomUUID()),shared=await realpath(await mkdtemp(path.join(tmpdir(),'eightgb-export-test-')));try{await action(root,shared);}finally{await rm(root.root,{recursive:true,force:true});await rm(shared,{recursive:true,force:true});}}
test('actual host APFS root is private, canonical and independent of the evidence directory',async()=>{
  await withRoot(async(root,shared)=>{assert.equal(root.filesystem.type,'apfs');assert.equal((await lstat(root.root)).mode&0o777,0o700);assert.equal(path.dirname(root.runDirectory),root.root);assert.equal(path.dirname(root.profileDirectory),root.root);assert.notEqual(root.root,shared);});
});
test('post-drain export preserves exact raw mirror/final files, excludes runtime keys/weights/SQLite and leaves originals',async()=>{
  await withRoot(async(root,shared)=>{
    const turn=randomUUID();await mkdir(path.join(root.profileDirectory,'turns',turn,'state/logs/cli'),{recursive:true});await writeFile(path.join(root.profileDirectory,'turns',turn,'state/logs/cli','actual.log'),'actual retained Goose error\n');
    await mkdir(path.join(root.profileDirectory,'gguf-runtime/models'),{recursive:true});await writeFile(path.join(root.profileDirectory,'gguf-runtime/models/model.gguf'),'excluded model payload');await writeFile(path.join(root.profileDirectory,'gguf-runtime/.inference-key-test'),'excluded ephemeral key');
    await mkdir(path.join(root.profileDirectory,'turns',turn,'data/sessions'),{recursive:true});await writeFile(path.join(root.profileDirectory,'turns',turn,'data/sessions','sessions.db'),'excluded database');
    await writeFile(path.join(root.profileDirectory,'chats.json'),'[{"content":"actual fixture only"}]\n');await captureProfileEvidence(root,true);
    const raw='{"type":"actual-test-record"}\n';await writeFile(path.join(root.runDirectory,'raw-events.jsonl'),raw);await writeFile(path.join(shared,'raw-events.jsonl'),raw);await writeFile(path.join(root.runDirectory,'report.json'),'{"complete":false}\n');await mkdir(path.join(root.runDirectory,'fixtures/case'),{recursive:true});await writeFile(path.join(root.runDirectory,'fixtures/case','result.txt'),'actual LF\n');
    const manifest=await exportRunEvidence(root,shared,true);assert.equal(manifest.rawMirrorExact,true);assert.equal(await readFile(path.join(shared,'fixtures/case/result.txt'),'utf8'),'actual LF\n');assert.equal(await readFile(path.join(shared,'report.json'),'utf8'),'{"complete":false}\n');
    assert.equal(manifest.files.find(row=>row.relative==='raw-events.jsonl')?.sha256,createHash('sha256').update(raw).digest('hex'));
    assert.ok(manifest.files.some(row=>row.relative.endsWith('actual.log')));assert.ok(!manifest.files.some(row=>/\.gguf|inference-key|sessions\.db/.test(row.relative)));assert.equal(await readFile(path.join(root.profileDirectory,'gguf-runtime/.inference-key-test'),'utf8'),'excluded ephemeral key');
  });
});
test('missing drain, altered live raw mirror and symlink evidence fail closed',async()=>{
  await withRoot(async(root,shared)=>{
    await assert.rejects(captureProfileEvidence(root,false),/actual owned final drain/);await assert.rejects(exportRunEvidence(root,shared,false),/actual owned final drain/);
    await writeFile(path.join(root.runDirectory,'raw-events.jsonl'),'actual\n');await writeFile(path.join(shared,'raw-events.jsonl'),'different\n');await writeFile(path.join(root.runDirectory,'report.json'),'{}');await assert.rejects(exportRunEvidence(root,shared,true),/raw mirror differs/);
  });
  await withRoot(async(root,shared)=>{await symlink('/etc/passwd',path.join(root.runDirectory,'outside'));await assert.rejects(exportRunEvidence(root,shared,true),/Nonordinary/);});
});
test('existing shared artifacts and oversized files cannot be overwritten or silently omitted',async()=>{
  await withRoot(async(root,shared)=>{await writeFile(path.join(root.runDirectory,'report.json'),'{}');await writeFile(path.join(root.runDirectory,'actual.json'),'new');await writeFile(path.join(shared,'actual.json'),'retained old');await assert.rejects(exportRunEvidence(root,shared,true),/EEXIST/);assert.equal(await readFile(path.join(shared,'actual.json'),'utf8'),'retained old');});
  await withRoot(async(root,shared)=>{await writeFile(path.join(root.runDirectory,'report.json'),'{}');await writeFile(path.join(root.runDirectory,'oversized.txt'),Buffer.alloc(16*1024**2+1));await assert.rejects(exportRunEvidence(root,shared,true),/byte bound/);});
});
test('independent exported-file reopening detects actual post-copy byte corruption',async()=>{
  await withRoot(async(_root,shared)=>{const file=path.join(shared,'exported.json'),bytes=Buffer.from('{"actual":"original"}\n'),expected={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await writeFile(file,bytes);assert.deepEqual(await verifyExportedFile(file,expected),expected);await writeFile(file,'{"actual":"corrupt!"}\n');await assert.rejects(verifyExportedFile(file,expected),/Independently reopened/);});
});
test('source and destination symlink ancestors cannot traverse or write outside their roots',async()=>{
  await withRoot(async(root,shared)=>{const turn=randomUUID(),outside=path.join(shared,'outside');await mkdir(path.join(outside,'logs/cli'),{recursive:true});await writeFile(path.join(outside,'logs/cli','not-authorized.log'),'outside');await mkdir(path.join(root.profileDirectory,'turns',turn),{recursive:true});await symlink(outside,path.join(root.profileDirectory,'turns',turn,'state'));await assert.rejects(captureProfileEvidence(root,true),/symlink ancestor/);});
  await withRoot(async(root,shared)=>{const outside=path.join(root.root,'outside');await mkdir(outside);await mkdir(path.join(root.runDirectory,'fixtures/case'),{recursive:true});await writeFile(path.join(root.runDirectory,'fixtures/case','result.txt'),'actual');await writeFile(path.join(root.runDirectory,'report.json'),'{}');await symlink(outside,path.join(shared,'fixtures'));await assert.rejects(exportRunEvidence(root,shared,true),/symlink ancestor/);await assert.rejects(readFile(path.join(outside,'case/result.txt')),/ENOENT/);});
});

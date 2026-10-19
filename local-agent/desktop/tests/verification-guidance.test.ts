import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalActions} from '../actions.ts';
import {TaskVerificationLedger,parseTaskBrief,type TaskCriterion} from '../task-verification.ts';
import {taskInstructions} from '../agent-policy.ts';
import {DEFAULT_UTILITIES} from '../state.ts';

const criterion=(id:string)=>({id,description:'Run the current fixed check',kind:'command',command:'exit 0',cwd:'.',paths:['app.txt']});
const request='Fix the local project';
async function fixture(ids=['current-one','current-two'],scope:'bound'|'empty'|'none'='bound'){
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'verification-guidance-'))),workspace=path.join(directory,'project');
  await mkdir(workspace);await writeFile(path.join(workspace,'app.txt'),'current source\n');
  const brief=parseTaskBrief({goal:request,deliverables:['app.txt'],criteria:ids.map(criterion)},request),ledger=new TaskVerificationLedger(brief,workspace);
  const controller=new AbortController(),commands=scope==='empty'?[]:[...brief.criteria].filter((c):c is Extract<TaskCriterion,{kind:'command'}>=>c.kind==='command').map(c=>({id:c.id,kind:'command' as const,command:c.command,cwd:c.cwd}));
  let approvals=0;
  const actions=new LocalActions({projectPath:workspace,historyDirectory:path.join(directory,'history'),verificationCheckIds:scope==='empty'?[]:ledger.verificationCheckIds,
    ...(scope==='none'?{}:{frozenVerification:{turnId:'current-turn',requestHash:brief.requestHash,workspacePath:workspace,signal:controller.signal,commands}}),
    onPermission:async()=>{approvals++;return true;},onBeforeVerificationCommand:(id,args,signal)=>ledger.beforeVerificationCommand(id,args,signal),onTool:event=>ledger.recordHostAction(event)});
  return {directory,workspace,ledger,actions,controller,get approvals(){return approvals;},cleanup:()=>rm(directory,{recursive:true,force:true})};
}
test('invalid legacy metadata guides only current frozen command IDs before any approval/execution',async()=>{
  const f=await fixture();
  try{
    for(const input of [{purpose:'verification'},{purpose:'verification',checkIds:['manual-id']},{purpose:'verification',checkIds:['current-one','current-one']},
      {purpose:'verification',checkIds:'current-one'},{purpose:'wrong'},{purpose:'implementation',checkIds:['current-one']}]){
      const r=await f.actions.execute('run_command',{command:'exit 0',...input});assert.equal(r.errorCode,'INVALID_ARGUMENT');
      const text=r.content[0].text;
      assert.match(text,/^For frozen acceptance, call run_verification\(\{"check_id":"current-one"\}\)/);
      assert.match(text,/Allowed current command check_ids: \["current-one","current-two"\]/);
      assert.match(text,/Implementation command receipts do not satisfy acceptance/);
      assert.doesNotMatch(text,/For debugging or implementation commands, use/);
      assert.equal(r.structuredContent?.operation,undefined);
    }
    assert.equal(f.approvals,0);assert((await f.ledger.evaluate()).every(c=>c.status==='unverified'));
  }finally{await f.cleanup();}
});
test('no-map, empty-map and aborted-turn guidance never promises a runnable ID or grants approval',async()=>{
  for(const scope of ['none','empty','bound'] as const){
    const f=await fixture(['legacy-check'],scope);
    try{
      if(scope==='bound')f.controller.abort();
      const r=await f.actions.execute('run_command',{command:'exit 0',purpose:'verification'}),text=r.content[0].text;
      if(scope==='none'){assert.equal(r.errorCode,'INVALID_ARGUMENT');assert.match(text,/No current frozen ID map is bound/);assert.match(text,/Legacy verification requires/);}
      else if(scope==='empty'){assert.equal(r.errorCode,'INVALID_ARGUMENT');assert.match(text,/No executable frozen command criteria/);}
      else assert.equal(r.errorCode,'CANCELLED');
      assert.doesNotMatch(text,/run_verification\(/);assert.equal(f.approvals,0);
    }finally{await f.cleanup();}
  }
});
test('implementation exit0 stays unverified and exact legacy verification still obtains its own approved receipt',async()=>{
  const f=await fixture(['legacy-check']);
  try{
    const implementation=await f.actions.execute('run_command',{command:'exit 0',purpose:'implementation',checkIds:[]});
    assert.equal(implementation.structuredContent?.exit_code,0);assert.equal((await f.ledger.evaluate())[0].status,'unverified');
    const verified=await f.actions.execute('run_command',{command:'exit 0',cwd:'.',purpose:'verification',checkIds:['legacy-check']});
    assert.equal(verified.structuredContent?.operation,'run_command');assert.equal(verified.structuredContent?.purpose,'verification');
    assert.deepEqual(verified.structuredContent?.check_ids,['legacy-check']);assert.equal(f.approvals,2);
    assert.equal((await f.ledger.evaluate())[0].status,'passed');
  }finally{await f.cleanup();}
});
test('wrong frozen command/cwd guidance retains current IDs without running or relabeling verification',async()=>{
  const f=await fixture(['current-check']);
  try{
    const r=await f.actions.execute('run_command',{command:'exit 1',cwd:'.',purpose:'verification',checkIds:['current-check']});
    assert.equal(r.isError,true);assert.match(r.content[0].text,/run_verification\(\{"check_id":"current-check"\}\)/);
    assert.match(r.content[0].text,/No command ran/);assert.equal(r.structuredContent?.operation,undefined);
    assert.equal((await f.ledger.evaluate())[0].status,'unverified');
  }finally{await f.cleanup();}
});
test('continuation directs only missing command IDs and preserves file/manual/protection evidence',()=>{
  const brief=parseTaskBrief({goal:request,deliverables:['app.txt'],criteria:[criterion('done-check'),criterion('missing-check'),
    {id:'file-check',description:'Exact bytes',kind:'exact_file',path:'app.txt',content:'required'},
    {id:'protected-check',description:'Preserve script',kind:'preserve_file',path:'protected.mjs'},
    {id:'manual-check',description:'Subjective human review',kind:'manual'}]},request);
  const ledger=new TaskVerificationLedger(brief,'/not-read-by-guidance'),checks=brief.criteria.map(c=>({id:'acceptance:'+c.id,title:c.description,purpose:'acceptance' as const,checkIds:[c.id],status:c.id==='done-check'?'passed' as const:'unverified' as const,detail:'test evidence'}));
  const text=ledger.missingChecksPrompt(checks),guidance=text.split('\nFROZEN TASK BRIEF:')[0];
  assert.match(guidance,/run_verification\(\{"check_id":"missing-check"\}\)/);assert.match(guidance,/Allowed command check_ids: \["missing-check"\]/);
  assert.doesNotMatch(guidance,/"done-check"|"file-check"|"protected-check"|"manual-check"/);
  assert.match(guidance,/Implementation command receipts do not satisfy acceptance/);assert.match(guidance,/Manual semantic criteria remain unverified/);assert.match(guidance,/failed host preservation check stops this task/);
  assert(text.includes(JSON.stringify(brief)));assert(text.includes(JSON.stringify(checks.filter(c=>c.status!=='passed'))));
});
test('enabled terminal policy includes ID verification while read-only/terminal-off inventories stay unchanged',()=>{
  const enabled=taskInstructions('coding',DEFAULT_UTILITIES);assert.match(enabled,/run_verification: run one current frozen command criterion by check_id/);
  assert.match(enabled,/Implementation command receipts do not satisfy acceptance/);assert.match(enabled,/exact legacy verification/);assert.match(enabled,/Respect denials/);
  for(const mode of ['assistant','research','coding'] as const){
    const text=taskInstructions(mode,{...DEFAULT_UTILITIES,terminal:false});assert.doesNotMatch(text,/run_verification|run_command/);
  }
});

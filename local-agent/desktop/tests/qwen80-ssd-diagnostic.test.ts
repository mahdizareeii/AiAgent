import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertHarnessSSDOptions, harnessBudget, parseHarnessOptions} from '../../../scripts/validate-local-coding.ts';
const valid={model:'qwen3-coder-next:80b',sourceDirectory:'.',memoryMode:'ssd-experts' as const,budgetProfile:'desktop-task' as const,cases:['exact-lf'],repeat:1};
test('Qwen SSD route is an explicit bounded source diagnostic and cannot qualify',()=>{
  assert.doesNotThrow(()=>assertHarnessSSDOptions(valid));assert.equal(harnessBudget(valid).qualificationAllowed,false);
  for(const change of [{model:'gemma4:26b'},{budgetProfile:'qualification'},{budgetProfile:'slow-system-reliability'},{packagePath:'/app'},
    {sourceSnapshot:'/old'},{baselineReport:'/baseline'},{repeat:3},{cases:undefined}])assert.throws(()=>assertHarnessSSDOptions({...valid,...change} as any));
});

test('parsing accepts only the exact selected Qwen80 SSD source diagnostic',()=>{
  const base=['--model','qwen3-coder-next:80b','--source-dir','.cache/models','--memory-mode','ssd-experts'];
  const selected=['--budget-profile','desktop-task','--cases','exact-lf,cli-inputs','--repeat','1'];
  const parsed=parseHarnessOptions([...base,...selected]);
  assert.equal(parsed.model,'qwen3-coder-next:80b');assert.equal(parsed.memoryMode,'ssd-experts');
  assert.equal(parsed.budgetProfile,'desktop-task');assert.equal(parsed.repeat,1);
  assert.deepEqual(parsed.cases,['exact-lf','cli-inputs']);
  const budget=harnessBudget(parsed);assert.equal(budget.limitMs,3600000);
  assert.equal(budget.qualificationAllowed,false);assert.equal(budget.slowReliabilityAllowed,false);
  const invalid: [string[],RegExp][]=[
    [[...base.slice(0,1),'qwen3.8:27b',...base.slice(2),...selected],/--memory-mode ssd-experts.*Qwen80/],
    [[...base,...selected,'--package','/app'],/SSD diagnostics/],
    [[...base,...selected,'--baseline-report','/baseline'],/SSD diagnostics/],
    [[...base,...selected,'--source-snapshot','/preserved'],/baseline comparisons require automatic/],
    [[...base,'--budget-profile','qualification','--cases','exact-lf','--repeat','1'],/SSD diagnostics/],
    [[...base,'--budget-profile','slow-system-reliability','--repeat','3'],/SSD diagnostics/],
    [[...base,'--budget-profile','desktop-task','--cases','exact-lf','--repeat','2'],/Desktop diagnostics/],
    [[...base,'--budget-profile','desktop-task','--repeat','1'],/Desktop diagnostics/],
  ];
  for(const [args,error] of invalid)assert.throws(()=>parseHarnessOptions(args),error);
});

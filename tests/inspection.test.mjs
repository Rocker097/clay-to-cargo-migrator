import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {planMigration} from '../src/plan.ts';
import {inspectPlan,parseOverrides} from '../src/inspect.ts';
import {parseClaySchema} from '../src/claymate.ts';
import {emitProject} from '../src/emit.ts';
const schema=columns=>parseClaySchema(JSON.stringify({version:'1',columns}));

test('varied widths, renamed columns and reversed presentation order preserve logic',()=>{
 for(const width of [1,7,100,1000]){
  const columns=[{name:'Annual revenue €',type:'text',typeSettings:{dataTypeSettings:{type:'number'}}}];
  for(let i=1;i<width;i++) columns.push({name:`Calculation ${i}`,type:'formula',typeSettings:{formulaText:`{{@${i===1?'Annual revenue €':`Calculation ${i-1}`}}} + 1`,formulaType:'number'}});
  const p=planMigration(schema(columns.reverse()),'varying');
  assert.equal(inspectPlan(p).supported,width);
  const row={annual_revenue:10};
  for(const c of p.columns) if(c.loaderExpr) row[c.slug]=vm.runInNewContext(c.loaderExpr,{row});
  assert.equal(row[p.columns.at(-1).slug],10+width-1);
  assert.ok(emitProject(p).some(f=>f.path.includes('/models/')));
 }
});
test('exact reusable action aliases adapt unfamiliar providers without changing column names',()=>{
 const input=schema([{name:'Site',type:'text'},{name:'Company data',type:'action',typeSettings:{actionKey:'custom-company-lookup',inputsBinding:[{name:'domain',formulaText:'{{@Site}}'}]}}]);
 const p=planMigration(input,'alias',parseOverrides('{"actions":{"custom-company-lookup":"company-from-domain"}}'));
 assert.equal(p.columns[1].mapping.id,'company-from-domain');
 assert.equal(inspectPlan(p).columns[1].status,'review');
 assert.throws(()=>parseOverrides('{"actions":{"x":"invented"}}'),/Invalid adapter/);
});
test('unsupported logic blocks downstream columns and preserves reasons',()=>{
 const p=planMigration(schema([{name:'X',type:'formula',typeSettings:{formulaText:'MAGIC(1)'}},{name:'Y',type:'formula',typeSettings:{formulaText:'{{@X}} + 1'}}]),'blocked');
 const report=inspectPlan(p);assert.equal(report.blocked,2);assert.equal(report.readyToGenerate,false);
 assert.deepEqual(report.columns[1].dependencies,['X']);assert.match(report.columns[1].notes.join(' '),/not migrated/);
});
test('extra action inputs and unknown result fields are never silently discarded',()=>{
 const action={name:'Lookup',type:'action',typeSettings:{actionKey:'company-enrich',inputsBinding:[{name:'domain',formulaText:'"example.com"'},{name:'important_option',formulaText:'true'}]}};
 assert.equal(inspectPlan(planMigration(schema([action]),'extra')).blocked,1);
 action.typeSettings.inputsBinding.pop();
 const p=planMigration(schema([action,{name:'Unknown field',type:'formula',typeSettings:{formulaText:'{{@Lookup}}.secret_field'}}]),'field');
 assert.equal(p.columns[1].generated,false);assert.match(p.columns[1].notes.join(' '),/Unknown output field/);
});
test('CLI inspects before writing resources and requires explicit partial opt-in',()=>{
 const dir=mkdtempSync(join(tmpdir(),'clay-inspect-'));const file=join(dir,'schema.json');const out=join(dir,'output');
 writeFileSync(file,JSON.stringify({columns:[{name:'Unknown',type:'action',typeSettings:{actionKey:'unknown'}}]}));
 const run=(...args)=>spawnSync(process.execPath,['src/cli.ts',...args],{encoding:'utf8'});
 const inspection=run('inspect','--schema',file);assert.equal(inspection.status,0);assert.equal(JSON.parse(inspection.stdout).blocked,1);
 const blocked=run('compile','--schema',file,'--out',out);assert.equal(blocked.status,2);assert.equal(existsSync(out),false);
 const draft=run('compile','--schema',file,'--out',out,'--allow-partial');assert.equal(draft.status,0);assert.equal(existsSync(out),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {planMigration} from '../src/plan.ts';
import {parseFormula, emitBody} from '../src/formula.ts';
import {inspectPlan} from '../src/inspect.ts';
const column=(name,formulaText)=>({name,type:'formula',index:1,typeSettings:{formulaText}});
const plan=(formulaText)=>planMigration({version:'1',columns:[{name:'Domain',type:'text',index:0},column('Result',formulaText)]},'method_test');
const calc=(formulaText,value)=>{
 const c=plan(formulaText).columns[1]; assert.equal(c.generated,true,c.notes.join(' '));
 return vm.runInNewContext(c.loaderExpr,{row:{domain:value}});
};

test('optional uppercase, lowercase and trim preserve actual string values',()=>{
 for(const value of ['notion.so',' Stripe.COM ','','école.fr']) {
  assert.equal(calc('{{@Domain}}?.toUpperCase()',value),value?.toUpperCase());
  assert.equal(calc('{{@Domain}}?.toLowerCase()',value),value?.toLowerCase());
  assert.equal(calc('{{@Domain}}?.trim()',value),value?.trim());
 }
 for(const value of [null,undefined]) {
  assert.equal(calc('{{@Domain}}?.toUpperCase()',value),undefined);
  assert.equal(calc('{{@Domain}}?.length',value),undefined);
 }
});
test('length returns a number rather than silently returning the source text',()=>{
 for(const value of ['notion.so','', '🦊']) assert.equal(calc('{{@Domain}}?.length',value),value.length);
 assert.equal(calc('{{@Domain}}.length','stripe.com'),10);
});
test('non-optional access keeps its errors instead of coercing missing values',()=>{
 assert.throws(()=>calc('{{@Domain}}.length',undefined),/undefined/);
 assert.throws(()=>calc('{{@Domain}}.toUpperCase()',null),/null/);
});
test('unsupported properties, methods and arguments are blocked',()=>{
 for(const formula of ['{{@Domain}}.unknown','{{@Domain}}.length.unknown','{{@Domain}}.execute()','{{@Domain}}.toUpperCase("x")']) {
  assert.equal(plan(formula).columns[1].generated,false,formula);
 }
 assert.throws(()=>emitBody(parseFormula('{{@Domain}}?.toUpperCase()'),()=> 'input.domain'),/only in input/);
});
test('method and length dependencies remain ordered with downstream calculations',()=>{
 const columns=[column('Followup','{{@Ready}} ? 1 : 7'),column('Ready','{{@Length}} >= 9'),column('Length','{{@Domain}}?.length'),column('Upper','{{@Domain}}?.toUpperCase()'),{index:0,name:'Domain',type:'text'}];
 const p=planMigration({version:'1',columns},'chain');assert.equal(inspectPlan(p).blocked,0);
 for(const value of ['notion.so','',undefined]) {
  const row={domain:value};
  for(const c of p.columns) if(c.loaderExpr) row[c.slug]=vm.runInNewContext(c.loaderExpr,{row});
  assert.equal(row.length,value?.length);assert.equal(row.upper,value?.toUpperCase());assert.equal(row.followup,(value?.length>=9)?1:7);
 }
});

// Configuration captured from the actual 15-column Clay table; account IDs omitted.
test('actual fifteen-column export translates both formerly failing formulas',()=>{
 const schema=JSON.parse(fs.readFileSync(new URL('./fixtures/fifteen-column.claymate.json',import.meta.url),'utf8'));
 const p=planMigration(schema,'actual_fifteen');const inspection=inspectPlan(p);
 assert.equal(inspection.columnCount,15);assert.equal(inspection.blocked,0);assert.equal(inspection.review,1);
 const row={domain:'notion.so'};
 for(const c of p.columns) if(c.loaderExpr) row[c.slug]=vm.runInNewContext(c.loaderExpr,{row});
 assert.equal(row.uppercase_domain,'NOTION.SO');assert.equal(row.domain_length,9);
 assert.equal(row.followup_days,1);assert.equal(row.routing_label,'Sales / A');
});

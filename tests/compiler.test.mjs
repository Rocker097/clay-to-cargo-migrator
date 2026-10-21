import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseClaySchema} from '../src/claymate.ts';
import {planMigration} from '../src/plan.ts';
import {emitProject} from '../src/emit.ts';
import {parseCsv} from '../src/csv.ts';
const schema=parseClaySchema(fs.readFileSync(new URL('../samples/company-qualification.claymate.json',import.meta.url),'utf8'));
const makePlan=()=>planMigration(schema,'demo_companies');

test('real Clay export generates all six columns despite forward references',()=>{
 const p=makePlan();assert.equal(p.columns.filter(c=>c.generated).length,6);
 const names=p.columns.map(c=>c.clay.name);
 assert.ok(names.indexOf('Enrich company')<names.indexOf('Employee Count'));
 assert.ok(names.indexOf('Employee Count')<names.indexOf('Employee Fit Status'));
});
test('generated size rule agrees with independent rule at boundaries',()=>{
 const expr=makePlan().columns.find(c=>c.clay.name==='Mid-Size Employee Flag').bodyExpr;
 for(const n of [0,49,50,1000,1001,7211])assert.equal(vm.runInNewContext(expr,{rEnrichCompany:{employee_count:n}}),n>=50&&n<=1000);
});
test('actual exported AI expression becomes the intended prompt, not helper code',()=>{
 const ai=makePlan().columns.find(c=>c.kind==='ai');
 const prompt=vm.runInNewContext('`'+ai.promptTemplate+'`',{input:{ctxEmployeeCount:7211}});
 assert.equal(prompt,'Return FIT if the employee count is between 50 and 1000 inclusive; otherwise return NOT FIT. Use only this employee count: 7211');
});
test('company identifier maps and normalizes common websites without changing input',()=>{
 const files=emitProject(makePlan());const tool=files.find(f=>f.path.endsWith('/tools/enrich-company.ts')).content;
 const expr=tool.match(/domain: (\(input\.domain[^\n]+),/)[1];
 for(const value of ['https://www.notion.so','http://notion.so/path','NOTION.SO','https://notion.so?q=1','https://notion.so#test']){
 const input={domain:value};assert.equal(vm.runInNewContext(expr,{input}),'notion.so');assert.equal(input.domain,value);
 }
});
test('observed company values replay against the real exported CSV',()=>{
 const row=parseCsv(fs.readFileSync(new URL('./fixtures/real-clay-output.csv',import.meta.url),'utf8')).rows[0];
 const p=makePlan();const context={rEnrichCompany:{company_name:'Notion',employee_count:7211}};
 for(const [name,expected] of [['Name',row.Name],['Employee Count',Number(row['Employee Count'])],['Mid-Size Employee Flag',row['Mid-Size Employee Flag']==='false'?false:true]]){
 const c=p.columns.find(c=>c.clay.name===name);assert.equal(vm.runInNewContext(c.bodyExpr,context),expected);
 }
 assert.match(row['Employee Fit Status'],/NOT FIT/);
});
test('cycles and ambiguous names fail clearly',()=>{
 const columns=[{index:0,name:'A',type:'formula',typeSettings:{formulaText:'{{@B}}'}},{index:1,name:'B',type:'formula',typeSettings:{formulaText:'{{@A}}'}}];
 assert.throws(()=>planMigration({version:'1.0',columns},'cycle'),/Dependency cycle/);
 assert.throws(()=>planMigration({version:'1.0',columns:[{index:0,name:'A',type:'text'},{index:1,name:'A',type:'text'}]},'duplicate'),/Duplicate column/);
});
test('missing dependencies and unsupported prompt helpers are reported',()=>{
 const p=planMigration({version:'1.0',columns:[{index:0,name:'A',type:'formula',typeSettings:{formulaText:'{{@Absent}}'}}]},'missing');
 assert.equal(p.columns[0].generated,false);assert.match(p.columns[0].notes.join(' '),/absent/i);
 const altered=structuredClone(schema);altered.columns.find(c=>c.name==='Employee Fit Status').typeSettings.inputsBinding.find(b=>b.name==='prompt').formulaText='"Hello " + Clay.unsupported({{@Employee Count}})';
 assert.equal(planMigration(altered,'unsupported').columns.find(c=>c.kind==='ai').generated,false);
});
test('unknown actions remain manual review and plays ship disabled',()=>{
 const p=planMigration({version:'1.0',columns:[{index:0,name:'Mystery',type:'action',typeSettings:{actionKey:'unknown-mystery'}}]},'unknown');assert.equal(p.columns[0].generated,false);
 const play=emitProject(makePlan()).find(f=>f.path.includes('/plays/')).content;assert.match(play,/isEnabled: false/);assert.doesNotMatch(play,/hubspot|salesforce/i);
});

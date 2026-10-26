import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseFormula,emitLoader,emitBody} from '../src/formula.ts';
import {planMigration} from '../src/plan.ts';
const run=(formula,row={})=>vm.runInNewContext(emitLoader(parseFormula(formula),(name)=>`row[${JSON.stringify(name)}]`),{row,Date:class extends Date {static now(){return Date.parse('2026-10-25T12:00:00Z');}}});
test('split and indexing preserve short-circuit and missing element semantics',()=>{
 for(const value of ['a@example.com','bad','',null,undefined])assert.equal(run('{{@Email}}?.split("@")[1]',{Email:value}),value?.split('@')[1]);
 assert.equal(run('{{@Email}}?.split("@")[1]?.toUpperCase()',{Email:'a@site.io'}),'SITE.IO');
 assert.equal(run('{{@Email}}?.split("@")[1]?.toUpperCase()',{Email:null}),undefined);
 assert.throws(()=>run('{{@Email}}.split("@")[1]',{Email:null}));
});
test('array join preserves values and dependency order',()=>{
 assert.equal(run('["inbound", {{@Band}}].join(", ")',{Band:'Large'}),'inbound, Large');
 const p=planMigration({version:'1',columns:[{index:0,name:'Seats',type:'number'},{index:1,name:'Tags',type:'formula',typeSettings:{formulaText:'["inbound", {{@Band}}].join(", ")'}},{index:2,name:'Band',type:'formula',typeSettings:{formulaText:'{{@Seats}} >= 50 ? "Large" : "Small"'}}]},'array-chain');
 assert.ok(p.columns.every(c=>c.generated));assert.ok(p.columns.findIndex(c=>c.clay.name==='Band')<p.columns.findIndex(c=>c.clay.name==='Tags'));
});
test('bounded regex cleanup and division remain distinct',()=>{
 assert.equal(run('{{@Phone}}?.replace(/[^0-9]/g, "")',{Phone:'+1 (415) 555-0123'}),'14155550123');
 assert.equal(run('{{@Phone}}?.replace(/[^0-9]/g, "")',{}),undefined);
 assert.equal(run('100 / 4'),25);
 assert.throws(()=>parseFormula('{{@Phone}}.replace(/(a+)+$/g, "")'),/explicit support/);
});
test('date arithmetic uses milliseconds, floor boundaries and runtime clock',()=>{
 assert.equal(run('Math.floor((Date.now() - new Date({{@Date}})) / 86400000)',{Date:'2026-10-23T13:00:00Z'}),1);
 assert.equal(run('Math.floor((Date.now() - new Date({{@Date}})) / 86400000)',{Date:'2026-10-26T12:00:00Z'}),-1);
 assert.ok(Number.isNaN(run('Date.now() - new Date({{@Date}})',{Date:'definitely-invalid-date'})));
});
test('new operations reject unsupported execution and invalid result shapes',()=>{
 assert.throws(()=>emitBody(parseFormula('["a"].join(",")'),()=>''),/only in input/);
 for(const f of ['Math.random()','new Function("x")','{{@Email}}["constructor"]','{{@Email}}.split("@")[{{@X}}]'])assert.throws(()=>parseFormula(f));
 const schema=f=>({version:'1',columns:[{index:0,name:'Email',type:'text'},{index:1,name:'Result',type:'formula',typeSettings:{formulaText:f}}]});
 assert.equal(planMigration(schema('{{@Email}}.split("@")'),'raw-array').columns[1].generated,false);
 assert.equal(planMigration(schema('{{@Email}}.split("@")[1]'),'scalar').columns[1].generated,true);
});

test('nested provider paths need explicit mappings to known output fields',()=>{
 const schema={version:'1',columns:[{index:0,name:'Domain',type:'text'},{index:1,name:'Company',type:'action',typeSettings:{actionKey:'clearbit-enrich-company',inputsBinding:[{name:'domain',formulaText:'{{@Domain}}'}]}},{index:2,name:'Country',type:'formula',typeSettings:{formulaText:'{{@Company}}?.location?.country'}}]};
 assert.equal(planMigration(schema,'nested').columns[2].generated,false);
 const p=planMigration(schema,'nested',{actions:{'clearbit-enrich-company':{adapter:'company-from-domain',outputAliases:{'location.country':'hq_country'}}}});
 assert.equal(p.columns[2].generated,true);assert.match(p.columns[2].bodyExpr,/hq_country/);
});

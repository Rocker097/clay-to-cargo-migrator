import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {planMigration} from '../src/plan.ts';
import {emitProject} from '../src/emit.ts';
import {parseOverrides,inspectPlan} from '../src/inspect.ts';
import {prepareRows,importPrepared} from '../src/import-runtime.ts';
import {evaluateCases} from '../src/evaluate.ts';
const schema=JSON.parse(fs.readFileSync(new URL('./fixtures/fifteen-column.claymate.json',import.meta.url),'utf8'));
const plan=()=>planMigration(structuredClone(schema),'adaptable');
const spec=[{clay:'Domain',slug:'domain',type:'string'}];
const csv='Domain\nnotion.so\nstripe.com\n';
const options={limit:20,source:'test',idColumn:'Domain'};

test('formula types override inaccurate text metadata throughout the dependency chain',()=>{
 const p=plan();const type=name=>p.columns.find(c=>c.clay.name===name).cargoType;
 assert.equal(type('Readiness Score'),'number');assert.equal(type('Ready Flag'),'boolean');assert.equal(type('Domain Length'),'number');
 assert.equal(inspectPlan(p).workflow.nodes.find(n=>n.sourceName==='Domain Length').typeSource,'inferred');
 const model=emitProject(p).find(f=>f.path.includes('/models/')).content;
 assert.match(model,/slug: "domain_length", type: "number"/);assert.match(model,/slug: "ready_flag", type: "boolean"/);
});
test('configuration aliases map compatible inputs and outputs; invalid contracts are rejected',()=>{
 const config=parseOverrides(JSON.stringify({actions:{bespoke:{adapter:'company-from-domain',inputAliases:{domain:'site'},outputAliases:{profile:'linkedin_url'}}}}));
 const p=planMigration({version:'1',columns:[{index:0,name:'Site',type:'text'},{index:1,name:'Lookup',type:'action',typeSettings:{actionKey:'bespoke',inputsBinding:[{name:'site',formulaText:'{{@Site}}'}]}},{index:2,name:'Profile',type:'formula',typeSettings:{formulaText:'{{@Lookup}}.profile'}}]},'alias',config);
 assert.equal(inspectPlan(p).blocked,0);assert.equal(p.columns[2].bodyExpr,'rLookup.linkedin_url');
 assert.throws(()=>parseOverrides('{"actions":{"x":{"adapter":"company-from-domain","outputAliases":{"profile":"invented"}}}}'),/Unknown adapter output/);
});
test('CSV preparation validates types, identities and headers before any writes',()=>{
 const inputs=[{clay:'Count',slug:'count',type:'number'},{clay:'Flag',slug:'flag',type:'boolean'}];
 const records=prepareRows('ID,Count,Flag\na,0,false\n',inputs,[],[],{...options,idColumn:'ID'});
 assert.equal(records[0].data.count,0);assert.equal(records[0].data.flag,false);
 for(const broken of ['ID,Count,Flag\na,bad,false\n','ID,Count,Flag\na,2,maybe\n','ID,Count,Flag\na,2,true\na,3,false\n','ID,Count,Flag\n,2,true\n'])assert.throws(()=>prepareRows(broken,inputs,[],[],{...options,idColumn:'ID'}));
 assert.throws(()=>prepareRows('ID,ID\na,b\n',[],[],[],options),/Duplicate/);
 assert.throws(()=>prepareRows('Domain\n"open\n',spec,[],[],options),/quote/);
 assert.throws(()=>prepareRows(csv,spec,[],[],{...options,limit:-1}),/positive/);
});
function fakeCargo({ambiguous=false}={}) {
 const records=[];let writes=0;
 return {records,get writes(){return writes;},call(args){
  if(args[2]==='list')return {records:structuredClone(records)};
  if(args[2]==='create'){const data=JSON.parse(args[args.indexOf('--data')+1]);writes++;records.push({id:'r'+writes,data});if(ambiguous)throw new Error('Connection lost after acceptance');return {ok:true};}
  throw new Error('Unexpected action');
 }};
}
test('repeat import and crash-after-acceptance reconciliation avoid duplicate creates',()=>{
 for(const ambiguous of [false,true]) {
  const cargo=fakeCargo({ambiguous});const checkpoint=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'clay-resume-')),'state.json');
  const records=prepareRows('Domain\nnotion.so\n',spec,[],[],options);
  if(ambiguous)assert.throws(()=>importPrepared(records,'model',checkpoint,cargo.call),/Connection lost/);
  else assert.equal(importPrepared(records,'model',checkpoint,cargo.call).created,1);
  assert.deepEqual(importPrepared(records,'model',checkpoint,cargo.call),{created:0,skipped:1});assert.equal(cargo.writes,1);
  const changed=structuredClone(records);changed[0].data.domain='changed.example';
  assert.throws(()=>importPrepared(changed,'model',checkpoint,cargo.call),/changed/);assert.equal(cargo.writes,1);
 }
});
test('ambiguous invisible writes and unknown API shapes stop rather than retry',()=>{
 const checkpoint=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'clay-stop-')),'state.json');const records=prepareRows(csv,spec,[],[],options);
 const response=args=>{if(args[2]==='list')return {records:[]};throw new Error('Lost response');};
 assert.throws(()=>importPrepared(records,'model',checkpoint,response),/Lost response/);
 assert.throws(()=>importPrepared(records,'model',checkpoint,response),/Unresolved/);
 assert.throws(()=>importPrepared(records,'model',checkpoint,()=>({unexpected:[]})),/Unrecognized/);
});
test('reused export fields bypass provider execution; incomplete values still call provider',()=>{
 const p=plan();const files=emitProject(p);const action=p.columns.find(c=>c.kind==='action');assert.ok(action.reuse);
 const cache=action.reuse;const source='Domain,Url\nnotion.so,https://linkedin.com/company/notion\n';
 const cached=prepareRows(source,spec,[],[cache],{...options,reuseExisting:true})[0].data;
 const tool=files.find(f=>f.path.endsWith('/tools/enrich-company.ts')).content;
 const body=tool.split('({ input, uses }) => {')[1].split('\n  },\n);')[0];
 let calls=0;const run=vm.runInNewContext('(input,uses)=>{'+body+'}');
 const input={domain:'notion.so',migrationReuse:cached[cache.flag],savedRaw:cached[cache.raw]};for(const field of cache.fields)input['saved_'+field.field]=cached[field.slug];
 const uses={linkedin:{enrichCompanyFromDomain(){calls++;return {linkedin_url:'fresh'};}}};
 assert.equal(run(input,uses).linkedin_url,'https://linkedin.com/company/notion');assert.equal(calls,0);
 assert.equal(run({...input,migrationReuse:false},uses).linkedin_url,'fresh');assert.equal(calls,1);
 assert.equal(prepareRows('Domain,Url\nnotion.so,\n',spec,[],[cache],{...options,reuseExisting:true})[0].data[cache.flag],false);
});
test('generated loader runs standalone as a dry run and rejects unsafe execution',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clay-generated-'));for(const f of emitProject(plan())){const target=path.join(dir,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,f.content);}
 const source=path.join(dir,'source.csv');fs.writeFileSync(source,csv);
 const loader=path.join(dir,'scripts/clay-adaptable/load-rows.ts');
 const run=spawnSync(process.execPath,[loader,'--csv',source,'--id-column','Domain'],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/Dry run/);assert.match(run.stdout,/"domain_length": 9/);
 const unsafe=spawnSync(process.execPath,[loader,'--csv',source,'--execute'],{encoding:'utf8'});assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/stable IDs/);
});
test('evaluation distinguishes authored synthetic fixtures from real exports',()=>{
 const cases=JSON.parse(fs.readFileSync(new URL('../evaluation/cases.json',import.meta.url),'utf8'));const report=evaluateCases(cases);
 assert.equal(report.passed,true,JSON.stringify(report.results.filter(r=>!r.passed)));assert.equal(report.summary.synthetic.cases,20);assert.equal(report.summary.realExports.cases,2);
 const bad=structuredClone(cases.slice(0,1));bad[0].rows[0].expected.Score=999;assert.equal(evaluateCases(bad).passed,false);
});

test('live native record response shape and refresh indicator are handled before writes',()=>{
 const checkpoint=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'clay-native-')),'state.json');const records=prepareRows('Domain\nnotion.so\n',spec,[],[],options);
 const call=()=>({records:[{_id:'row-1',id:'row-1',...records[0].data}],isRefreshing:false});
 assert.deepEqual(importPrepared(records,'model',checkpoint,call),{created:0,skipped:1});
 assert.throws(()=>importPrepared(records,'model',checkpoint,()=>({records:[],isRefreshing:true})),/refreshing/);
});

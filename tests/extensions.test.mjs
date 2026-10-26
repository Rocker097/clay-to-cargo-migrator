import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionPacket,validateProposal} from '../src/extensions.ts';
const schema={version:'1',columns:[{index:0,name:'Domain',type:'text'},{index:1,name:'Company',type:'action',typeSettings:{actionKey:'clearbit-enrich-company',authAccountId:'PRIVATE',inputsBinding:[{name:'domain',formulaText:'{{@Domain}}'}]}},{index:2,name:'Country',type:'formula',typeSettings:{formulaText:'{{@Company}}?.location?.country'}}]};
const source=JSON.stringify(schema);const packet=extensionPacket(source);
const proposal={schemaHash:packet.schemaHash,mappings:{actions:{'clearbit-enrich-company':{adapter:'company-from-domain',outputAliases:{'location.country':'hq_country'}}}},targets:['Country'],evidence:['Candidate geography equivalence requires reviewer confirmation'],missingInformation:[]};
const fixtures=[{id:'nested-map',schema,origin:'synthetic',split:'development'}];
test('review packet strips account identifiers and reports gaps without mutation',()=>{assert.ok(!JSON.stringify(packet).includes('PRIVATE'));assert.ok(packet.unresolved.some(c=>c.name==='Country'));assert.ok(packet.contracts.length);assert.equal(schema.columns[1].typeSettings.authAccountId,'PRIVATE');});
test('proposal validation resolves a known nested mapping and records fixture hashes',()=>{const r=validateProposal(source,proposal,fixtures);assert.equal(r.inspection.blocked,0);assert.equal(r.validation.passed,true);assert.match(r.proposalHash,/^[a-f0-9]{64}$/);});
test('stale schemas, invented fields, and unresolved information cannot be approved',()=>{
 assert.throws(()=>validateProposal(source,{...proposal,schemaHash:'stale'},fixtures),/stale/);
 assert.throws(()=>validateProposal(source,{...proposal,missingInformation:['Need credentials']},fixtures),/missing information/);
 const bad=structuredClone(proposal);bad.mappings.actions['clearbit-enrich-company'].outputAliases['location.country']='invented';assert.throws(()=>validateProposal(source,bad,fixtures),/Unknown adapter output/);
});
test('fixtures and actual target resolution are required',()=>{
 assert.throws(()=>validateProposal(source,proposal,[]),/fixtures/);
 assert.throws(()=>validateProposal(source,{...proposal,mappings:{actions:{}}},fixtures),/still blocked/);
 assert.throws(()=>validateProposal(source,proposal,[{...fixtures[0],expectedBlocked:['Country']}]),/failed/);
});

test('CLI validation does not approve; explicit approval produces versioned artifacts',async()=>{
 const {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'extension-cli-'));
 try {
  for(const [file,data] of [['schema',schema],['proposal',proposal],['fixtures',fixtures]])writeFileSync(join(dir,file+'.json'),JSON.stringify(data));
  const out=join(dir,'approved.json');const args=['src/cli.ts','review-extension','--schema',join(dir,'schema.json'),'--proposal',join(dir,'proposal.json'),'--fixtures',join(dir,'fixtures.json'),'--out',out];
  const run=extra=>spawnSync(process.execPath,[...args,...extra],{encoding:'utf8'});
  assert.equal(run([]).status,0);assert.equal(existsSync(out),false);
  assert.notEqual(run(['--approve']).status,0);assert.equal(existsSync(out),false);
  // Synthetic test-only approval; no real customer proposal is approved here.
  assert.equal(run(['--approve','--reviewer','automated-test-reviewer']).status,0);
  assert.equal(JSON.parse(readFileSync(out+'.review.json')).reviewer,'automated-test-reviewer');
  assert.notEqual(run(['--approve','--reviewer','another-test-reviewer']).status,0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

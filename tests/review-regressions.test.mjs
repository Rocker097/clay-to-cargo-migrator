import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseFormula,emitBody,emitLoader} from '../src/formula.ts';
import {planMigration} from '../src/plan.ts';
import {runParity} from '../src/parity.ts';
import {prepareRows} from '../src/import-runtime.ts';
const input={index:0,name:'ID',type:'text'};
const schema=columns=>({version:'1',columns});
test('string escapes retain JavaScript values in both generators',()=>{
 for(const literal of ['"line1\\nline2"',"'a\\tb'",'"\\u00e9\\x41"','"a\\\\b"', '"\\0"',"'it\\'s'"]){
  const expected=vm.runInNewContext(literal);
  for(const emit of [emitLoader,emitBody]) assert.equal(vm.runInNewContext(emit(parseFormula(literal),()=>'')),expected);
 }
 for(const literal of ['"\\uQQQQ"','"\\1"','"\\q"']) assert.throws(()=>parseFormula(literal),/escape/);
});
test('loose and strict comparisons retain their original truth values',()=>{
 for(const expr of ['"1" == 1','"1" != 1','"1" === 1','"1" !== 1','null == undefined','false == 0']){
  for(const emit of [emitLoader,emitBody]) assert.equal(vm.runInNewContext(emit(parseFormula(expr),()=>'')),vm.runInNewContext(expr));
 }
});
const ai=(extra={},bindings=[])=>({index:1,name:'Fit',type:'action',typeSettings:{actionKey:'use-ai',inputsBinding:[{name:'prompt',formulaText:'Classify {{@ID}}'},...bindings],...extra}});
test('unsupported structured AI output blocks its dependents at the source',()=>{
 for(const column of [ai({response_format:{type:'json_schema'}}),ai({},[{name:'json_schema',formulaText:'{"score":"number"}'}])]){
  const plan=planMigration(schema([input,column,{index:2,name:'Score',type:'formula',typeSettings:{formulaText:'{{@Fit}}?.score'}}]),'review');
  assert.equal(plan.columns.find(c=>c.clay.name==='Fit').generated,false);
  assert.match(plan.columns.find(c=>c.clay.name==='Fit').notes.join(' '),/output contract/);
  assert.equal(plan.columns.find(c=>c.clay.name==='Score').generated,false);
 }
 const plan=planMigration(schema([input,ai({},[{name:'model',formulaText:'"gpt-4o-mini"'},{name:'temperature',formulaText:'0.2'}])]),'review');
 assert.match(plan.columns[1].verify.join(' '),/Dropped Clay AI setting model/);
 assert.match(plan.columns[1].verify.join(' '),/Dropped Clay AI setting temperature/);
});
test('parity joins importer IDs and checks loader formulas',()=>{
 const plan=planMigration(schema([input,{index:1,name:'Upper',type:'formula',typeSettings:{formulaText:'{{@ID}}.toUpperCase()'}}]),'review');
 const imported=prepareRows('ID\na\n',[{clay:'ID',slug:'id',type:'string'}],[],[],{limit:1,source:'review',idColumn:'ID'});
 const cargo=`clay_row_id,upper\n${imported[0].data.clay_row_id},A\n`;
 const report=runParity(plan,'ID,Upper\na,A\n',cargo,'ID','review');
 assert.match(report,/1 of 1 Clay rows matched/);assert.match(report,/\| Upper \| 1 \| 1 \| 1 \| 1 \| 1 \| 0%/);
 assert.throws(()=>runParity(plan,'ID,Upper\na,A\n',cargo,'ID'),/No matching rows/);
 assert.throws(()=>runParity(plan,'ID,Upper\na,A\na,A\n',cargo,'ID','review'),/Duplicate/);
 assert.throws(()=>runParity(plan,'ID,Upper\na,A\n',cargo+'review:a,A\n','ID','review'),/Duplicate/);
 assert.throws(()=>runParity(plan,'ID,Upper\n,A\n',cargo,'ID','review'),/missing/);
});

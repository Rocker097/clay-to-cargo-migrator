import vm from 'node:vm';
import {parseClaySchema} from './claymate.ts';
import {planMigration, type MappingOverrides} from './plan.ts';
import {inspectPlan} from './inspect.ts';

export interface EvaluationCase {
 id:string; origin:'synthetic'|'real-export'; split:'development'|'holdout';
 schema:unknown; mappings?:MappingOverrides;
 rows?:{input:Record<string,unknown>;expected:Record<string,unknown>;expectedMissing?:string[]}[];
 expectedBlocked?:string[]; expectedError?:string;
}
export function evaluateCases(cases:EvaluationCase[]) {
 const results=cases.map(c=>{
  try {
   const p=planMigration(parseClaySchema(JSON.stringify(c.schema)),c.id,c.mappings);
   const report=inspectPlan(p);
   const actualBlocked=report.columns.filter(x=>x.status==='blocked').map(x=>x.name).sort();
   const expectedBlocked=[...(c.expectedBlocked??[])].sort();
   const errors:string[]=[];
   if(c.expectedError)errors.push('Expected an error but planning succeeded');
   if(JSON.stringify(actualBlocked)!==JSON.stringify(expectedBlocked))errors.push(`Blocked columns differ: ${JSON.stringify(actualBlocked)}`);
   let checks=0;
   for(const fixture of c.rows??[]) {
    const row:Record<string,unknown>={};
    for(const col of p.columns)if(col.kind==='input')row[col.slug]=fixture.input[col.clay.name];
    for(const col of p.columns)if(col.generated&&col.loaderExpr) {
     try {row[col.slug]=vm.runInNewContext(col.loaderExpr,{row,domainOf:(value:unknown)=>String(value??'').trim().toLowerCase().replace(/^[a-z]+:\/\//,'').split(/[/?#]/)[0].replace(/^www\./,'')},{timeout:100});}
     catch(e){errors.push(`${col.clay.name}: ${String(e)}`);}
    }
    for(const [name,expected] of Object.entries(fixture.expected)) {
     checks++;const col=p.columns.find(x=>x.clay.name===name);
     if(!col||!col.generated||col.kind!=='loader-formula'||!Object.is(row[col.slug],expected)) errors.push(`Output mismatch for ${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(col?row[col.slug]:undefined)}`);
    }
    for(const name of fixture.expectedMissing??[]) {checks++;const col=p.columns.find(x=>x.clay.name===name);if(!col||!col.generated||row[col.slug]!==undefined)errors.push(`Expected missing output ${name}`);}
   }
   return {id:c.id,origin:c.origin,split:c.split,passed:!errors.length,readyToGenerate:report.readyToGenerate,columns:report.columnCount,generated:report.columnCount-report.blocked,review:report.review,calculationChecks:checks,errors};
  }catch(e) {
   const message=e instanceof Error?e.message:String(e);const passed=!!c.expectedError&&message.includes(c.expectedError);
   return {id:c.id,origin:c.origin,split:c.split,passed,readyToGenerate:false,columns:0,generated:0,review:0,calculationChecks:0,errors:passed?[]:[message]};
  }
 });
 const summarize=(origin:string)=>{
  const selected=results.filter(r=>r.origin===origin);const cols=selected.reduce((n,r)=>n+r.columns,0);
  return {cases:selected.length,expectedOutcomesPassing:selected.filter(r=>r.passed).length,calculationChecks:selected.reduce((n,r)=>n+r.calculationChecks,0),readyToGenerate:selected.filter(r=>r.readyToGenerate).length,columnTranslationRate:cols?selected.reduce((n,r)=>n+r.generated,0)/cols:null};
 };
 return {fullWorkflowParityVerified:false,warning:'Local compiler/calculation evaluation only. Synthetic cases are authored tests, not representative customer coverage. Provider parity, production readiness, and 70–80% market coverage are NOT established.',passed:results.every(r=>r.passed),summary:{synthetic:summarize('synthetic'),realExports:summarize('real-export')},results};
}

import {SlugRegistry} from './naming.ts';
import type {MigrationPlan} from './plan.ts';
import type {ReuseSpec} from './import-runtime.ts';
/** Only direct, named CSV scalar outputs can establish reusable adapter results. */
export function planReuse(plan:MigrationPlan):void {
 const names=new SlugRegistry([...plan.columns.map(c=>c.slug),'clay_row_id','migrated_at']);
 const formulas=plan.columns.filter(c=>c.generated&&c.kind==='body-formula');
 for(const tool of plan.columns.filter(c=>c.generated&&c.kind==='action')) {
  const fields=[...tool.usedFields].filter(([field])=>field!=='raw').map(([field,type])=>{
   const source=formulas.find(c=>c.expression?.k==='ref'&&c.expression.name===tool.clay.name&&(tool.mapping!.fieldSynonyms[c.expression.path[0]]??c.expression.path[0]??tool.mapping!.primaryField)===field);
   return source?{field,type,csv:source.clay.name,slug:names.take(`saved_${tool.slug}_${field}`)}:undefined;
  });
  if(!fields.length||fields.some(f=>!f))continue;
  tool.reuse={flag:names.take(`reuse_${tool.slug}`),raw:names.take(`saved_${tool.slug}_raw`),sourceColumn:tool.clay.name,fields:fields as ReuseSpec['fields']};
 }
}

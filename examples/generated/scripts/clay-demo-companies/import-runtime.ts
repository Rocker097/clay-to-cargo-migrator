// Copied into generated projects. Uses only Node built-ins; dry runs never call Cargo.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,unlinkSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
export type Row=Record<string,string|number|boolean|undefined>;
export interface InputSpec {clay:string;slug:string;type:string}
export interface FormulaSpec {slug:string;compute:(row:Row)=>unknown}
export interface ReuseSpec {flag:string;raw:string;sourceColumn:string;fields:{slug:string;field:string;csv:string;type:string}[]}
export function domainOf(value:unknown):string {return String(value??'').trim().toLowerCase().replace(/^[a-z]+:\/\//,'').split(/[/?#]/)[0].replace(/^www\./,'');}
export function parseCsv(text:string) {
 const records:string[][]=[];let field='',record:string[]=[],quoted=false;
 for(let i=0;i<text.length;i++) {const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}
 else if(ch==='"')quoted=true;else if(ch===','){record.push(field);field='';}else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;record.push(field);field='';if(record.some(x=>x!==''))records.push(record);record=[];}else field+=ch;}
 if(quoted)throw new Error('Unclosed CSV quote');if(field!==''||record.length){record.push(field);if(record.some(x=>x!==''))records.push(record);}
 const [raw=[],...body]=records;const headers=raw.map(h=>h.replace(/^\uFEFF/,'').trim());
 if(new Set(headers).size!==headers.length||headers.some(h=>!h))throw new Error('Duplicate or blank CSV headers');
 return {headers,rows:body.map((r,n)=>{if(r.length!==headers.length)throw new Error(`CSV row ${n+2} has a different field count`);return Object.fromEntries(headers.map((h,i)=>[h,r[i]]));})};
}
function convert(raw:string,type:string):Row[string] {
 if(raw==='')return undefined;
 if(type==='number'){const value=Number(raw);if(!Number.isFinite(value))throw new Error(`Invalid numeric input ${raw}`);return value;}
 if(type==='boolean'){if(!['true','false'].includes(raw.toLowerCase()))throw new Error(`Invalid boolean input ${raw}`);return raw.toLowerCase()==='true';}
 if(type==='date'&&Number.isNaN(Date.parse(raw)))throw new Error(`Invalid date ${raw}`);
 return raw;
}
export function prepareRows(csv:string,inputs:InputSpec[],formulas:FormulaSpec[],reuse:ReuseSpec[],options:{limit:number;source:string;idColumn?:string;reuseExisting?:boolean}) {
 if(!Number.isInteger(options.limit)||options.limit<1)throw new Error('limit must be a positive integer');
 const parsed=parseCsv(csv);for(const c of inputs)if(!parsed.headers.includes(c.clay))throw new Error(`Missing CSV input column ${c.clay}`);
 if(options.idColumn&&!parsed.headers.includes(options.idColumn))throw new Error(`Missing ID column ${options.idColumn}`);
 const seen=new Set<string>();
 return parsed.rows.slice(0,options.limit).map((source,n)=>{
  const key=options.idColumn?source[options.idColumn]:String(n+1);
  if(!key?.trim())throw new Error(`Blank stable ID at row ${n+1}`);if(seen.has(key))throw new Error(`Duplicate source ID ${key}`);seen.add(key);
  const row:Row={clay_row_id:`${options.source}:${key}`};
  for(const c of inputs)row[c.slug]=convert(source[c.clay],c.type);
  for(const f of formulas){const value=f.compute(row);if(value!==null&&value!==undefined&&!['string','number','boolean'].includes(typeof value))throw new Error(`Non-scalar formula output ${f.slug}`);if(typeof value==='number'&&!Number.isFinite(value))throw new Error(`Non-finite formula output ${f.slug}`);row[f.slug]=value===null?undefined:value as Row[string];}
  for(const cache of reuse){row[cache.flag]=false;
   if(options.reuseExisting&&cache.fields.length&&cache.fields.every(f=>source[f.csv]!==undefined&&source[f.csv]!=='')) {
    const values:Record<string,unknown>={};for(const f of cache.fields){row[f.slug]=convert(source[f.csv],f.type);values[f.field]=row[f.slug];}
    row[cache.raw]=source[cache.sourceColumn]||JSON.stringify({source:'reused-clay-export',...values});row[cache.flag]=true;
   }
  }
  return {data:row};
 });
}
export type CargoCall=(args:string[])=>unknown;
export const callCargo:CargoCall=args=>JSON.parse(execFileSync('npx',['--no-install','cargo-ai',...args],{encoding:'utf8',maxBuffer:20*1024*1024}));
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Read-check-create, not an atomic server upsert. Reject changed rows; never overwrite existing enrichments. */
export function importPrepared(records:{data:Row}[],modelUuid:string,checkpoint:string,call:CargoCall=callCargo) {
 mkdirSync(dirname(checkpoint),{recursive:true});const lock=openSync(checkpoint+'.lock','wx');
 try {
  const journal:Record<string,{fingerprint:string;status:'pending'|'complete'}>=existsSync(checkpoint)?JSON.parse(readFileSync(checkpoint,'utf8')):{};
  const save=()=>{writeFileSync(checkpoint+'.tmp',JSON.stringify(journal,null,2));renameSync(checkpoint+'.tmp',checkpoint);};
  const identities=records.map(r=>r.data.clay_row_id);if(identities.some(k=>!k)||new Set(identities).size!==identities.length)throw new Error("Duplicate or missing prepared source IDs");
  const existing=new Map<string,{id:string;data:Record<string,unknown>}>();
  for(let offset=0;;offset+=100){const response=call(['storage','record','list','--model-uuid',modelUuid,'--limit','100','--offset',String(offset)]) as any;
   if(!response||!Array.isArray(response.records))throw new Error('Unrecognized Cargo list response; stopped before writes');
   if(response.isRefreshing)throw new Error('Cargo records are refreshing; retry after they are current, before importing');
   for(const record of response.records){
    const data=record.data?.original??record.data??record.original??(Object.hasOwn(record,"_id")?record:undefined);
    if(typeof record.id!=='string'||!data||typeof data!=='object')throw new Error('Unrecognized Cargo record shape; stopped before writes');
    const key=data.clay_row_id;if(typeof key!=='string')continue;
    if(existing.has(key))throw new Error(`Duplicate existing source ID ${key}`);existing.set(key,{id:record.id,data});
   }
   if(response.records.length<100)break;
  }
  // Check all collisions before creating anything.
  for(const {data} of records){const key=String(data.clay_row_id),prev=existing.get(key);if(prev&&Object.entries(data).some(([k,v])=>v!==undefined&&!Object.is(prev.data[k],v)))throw new Error(`Existing row changed for ${key}; no automatic overwrite`);}
  let created=0,skipped=0;
  for(const {data} of records){const key=String(data.clay_row_id),fingerprint=digest(data);
   if(existing.has(key)){journal[key]={fingerprint,status:'complete'};skipped++;save();continue;}
   if(journal[key])throw new Error(`Unresolved previous import for ${key}; reconcile Cargo visibility/state before retrying`);
   journal[key]={fingerprint,status:'pending'};save();
   call(['storage','record','create','--model-uuid',modelUuid,'--data',JSON.stringify(data)]);
   journal[key]={fingerprint,status:'complete'};save();created++;
  }
  return {created,skipped};
 } finally {closeSync(lock);unlinkSync(checkpoint+'.lock');}
}

// Dry run by default. Use a stable --id-column and --source for resumable imports.
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {prepareRows, importPrepared, domainOf, type Row} from "./import-runtime.ts";
const INPUTS=[
  {
    "clay": "Domain",
    "slug": "domain",
    "type": "string"
  }
];
const REUSE=[
  {
    "flag": "reuse_enrich_company",
    "raw": "saved_enrich_company_raw",
    "sourceColumn": "Enrich Company",
    "fields": [
      {
        "field": "linkedin_url",
        "type": "string",
        "csv": "Url",
        "slug": "saved_enrich_company_linkedin_url"
      }
    ]
  }
];
const FORMULAS=[
  {slug:"domain_status",compute:(row:Row)=>(row["domain"] ? "Ready" : "Missing domain")},
  {slug:"readiness_score",compute:(row:Row)=>((row["domain_status"] === "Ready") ? 10 : 0)},
  {slug:"priority",compute:(row:Row)=>((row["readiness_score"] >= 10) ? "High" : "Review")},
  {slug:"adjusted_score",compute:(row:Row)=>((row["readiness_score"] * 2) + 5)},
  {slug:"routing_team",compute:(row:Row)=>(((row["priority"] === "High") && (row["adjusted_score"] >= 25)) ? "Sales" : "Research")},
  {slug:"account_summary",compute:(row:Row)=>((((row["domain"] + " | ") + row["priority"]) + " | ") + row["routing_team"])},
  {slug:"score_band",compute:(row:Row)=>((row["adjusted_score"] >= 25) ? "A" : "B")},
  {slug:"routing_label",compute:(row:Row)=>((row["routing_team"] + " / ") + row["score_band"])},
  {slug:"ready_flag",compute:(row:Row)=>((row["domain_status"] === "Ready") && (row["score_band"] === "A"))},
  {slug:"followup_days",compute:(row:Row)=>(row["ready_flag"] ? 1 : 7)},
  {slug:"uppercase_domain",compute:(row:Row)=>row["domain"]?.toUpperCase()},
  {slug:"domain_length",compute:(row:Row)=>row["domain"]?.["length"]},
];
function arg(name:string){const i=process.argv.indexOf("--"+name);return i<0?undefined:process.argv[i+1];}
const csv=arg("csv");if(!csv)throw new Error("Provide --csv <path>");
const execute=process.argv.includes("--execute"),idColumn=arg("id-column");
if(execute&&!idColumn)throw new Error("Execution requires --id-column: row numbers are not stable IDs");
const source=arg("source")??"clay_fifteen_column_test";
const records=prepareRows(readFileSync(csv,"utf8"),INPUTS,FORMULAS,REUSE,{limit:Number(arg("limit")??20),source,idColumn,reuseExisting:process.argv.includes("--reuse-existing")});
console.log(JSON.stringify({rows:records.length,preview:records.slice(0,3)},null,2));
if(!execute){console.log("Dry run. No Cargo calls made.");process.exit(0);}
const model=arg("model-uuid");if(!model)throw new Error("Execution requires --model-uuid");
const checkpoint=arg("checkpoint")??join(".migration-checkpoints",model+".json");
const result=importPrepared(records,model,checkpoint);
console.log(JSON.stringify(result));

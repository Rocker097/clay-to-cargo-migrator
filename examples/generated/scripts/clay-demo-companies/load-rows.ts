// Dry run by default. Use a stable --id-column and --source for resumable imports.
import {readFileSync} from "node:fs";
import {join} from "node:path";
// @ts-ignore TS5097: Node runs this .ts import directly; Cargo repos do not enable allowImportingTsExtensions. Types still resolve.
import {prepareRows, importPrepared, domainOf, readPath, clayMoment, type Row, type InputSpec, type FormulaSpec, type ReuseSpec} from "./import-runtime.ts";
const INPUTS:InputSpec[]=[
  {
    "clay": "Company Website",
    "slug": "company_website",
    "type": "string"
  }
];
const REUSE:ReuseSpec[]=[
  {
    "flag": "reuse_enrich_company",
    "raw": "saved_enrich_company_raw",
    "sourceColumn": "Enrich company",
    "fields": [
      {
        "field": "company_name",
        "type": "string",
        "csv": "Name",
        "slug": "saved_enrich_company_company_name"
      },
      {
        "field": "employee_count",
        "type": "number",
        "csv": "Employee Count",
        "slug": "saved_enrich_company_employee_count"
      }
    ]
  }
];
// Formula inputs are typed loosely: column values are only known at runtime,
// where import-runtime validates every input and formula output.
type FormulaRow=Record<string,any>;
const FORMULAS:FormulaSpec[]=[

];
function arg(name:string){const i=process.argv.indexOf("--"+name);return i<0?undefined:process.argv[i+1];}
const csv=arg("csv");if(!csv)throw new Error("Provide --csv <path>");
const execute=process.argv.includes("--execute"),idColumn=arg("id-column");
if(execute&&!idColumn)throw new Error("Execution requires --id-column: row numbers are not stable IDs");
const source=arg("source")??"clay_demo_companies";
let records:ReturnType<typeof prepareRows>;
try{records=prepareRows(readFileSync(csv,"utf8"),INPUTS,FORMULAS,REUSE,{limit:Number(arg("limit")??20),source,idColumn,reuseExisting:process.argv.includes("--reuse-existing")});}
catch(error){console.error(error instanceof Error?error.message:String(error));process.exit(1);}
console.log(JSON.stringify({rows:records.length,preview:records.slice(0,3)},null,2));
if(!execute){console.log("Dry run. No Cargo calls made.");process.exit(0);}
const model=arg("model-uuid");if(!model)throw new Error("Execution requires --model-uuid");
const checkpoint=arg("checkpoint")??join(".migration-checkpoints",model+".json");
const result=importPrepared(records,model,checkpoint);
console.log(JSON.stringify(result));

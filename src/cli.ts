#!/usr/bin/env node
// clay-to-cargo: compile a Clay table into a deployable Cargo project.
//
//   inspect --schema <claymate.json> [--mappings <mappings.json>] [--out <inspection.json>]
//   compile --schema <claymate.json> --out <cargo-repo> [--name <table>] [--csv <clay-export.csv>] [--mappings <mappings.json>] [--allow-partial]
//   parity  --schema <claymate.json> --clay <clay-export.csv> --cargo <cargo-export.csv> [--name <table>] [--id-column <col>]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseClaySchema } from "./claymate.ts";
import { parseCsv } from "./csv.ts";
import { emitProject } from "./emit.ts";
import { slugify } from "./naming.ts";
import { runParity } from "./parity.ts";
import { planMigration } from "./plan.ts";
import { evaluateCases } from "./evaluate.ts";
import { inspectPlan, parseOverrides } from "./inspect.ts";
import { buildReport } from "./report.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return v;
}

const command = process.argv[2];

if (command === "compile" || command === "inspect") {
  const schemaPath = need("schema");
  const out = command === "compile" ? need("out") : arg("out");
  const name = slugify(arg("name") ?? basename(schemaPath).replace(/\.(claymate\.)?json$/, ""), 24);
  const schema = parseClaySchema(readFileSync(schemaPath, "utf8"));
  const csv = arg("csv");
  const rowCount = csv ? parseCsv(readFileSync(csv, "utf8")).rows.length : undefined;

  const mappingFile = arg("mappings");
  const plan = planMigration(schema, name, mappingFile ? parseOverrides(readFileSync(mappingFile, "utf8")) : {});
  const inspection = inspectPlan(plan);
  if (command === "inspect") {
    const json = JSON.stringify(inspection, null, 2) + "\n";
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, json); }
    console.log(json);
    process.exit(0);
  }
  if (!inspection.readyToGenerate && !process.argv.includes("--allow-partial")) {
    console.error(JSON.stringify(inspection, null, 2));
    console.error("Generation stopped: unresolved columns. Run inspect, add mappings, or explicitly use --allow-partial for a draft.");
    process.exit(2);
  }
  const files = emitProject(plan);
  files.push({ path: "migrations/" + name + "-inspection.json", content: JSON.stringify(inspection, null, 2) + "\n" });
  const report = buildReport(plan, { rowCount, schemaPath });
  files.push({ path: `migrations/clay-${name.replace(/_/g, "-")}/MIGRATION_REPORT.md`, content: report });

  for (const f of files) {
    const p = join(out!, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }

  const migrated = plan.columns.filter((c) => c.generated).length;
  console.log(`Compiled Clay table "${name}": ${migrated}/${plan.columns.length} columns migrated.\n`);
  for (const c of plan.columns) {
    const mark = c.generated ? "+" : c.kind === "crm-write" || c.kind === "source" ? "~" : "!";
    console.log(`  ${mark} #${String(c.clay.index).padEnd(2)} ${c.clay.name.padEnd(28)} ${c.kind}`);
  }
  console.log(`\n  + migrated   ~ left out on purpose   ! needs manual review`);
  console.log(`\nWrote ${files.length} files to ${out}`);
  console.log(`Report: ${join(out!, files[files.length - 1].path)}`);
} else if (command === "evaluate") {
  const cases=JSON.parse(readFileSync(need("cases"),"utf8"));
  if(!Array.isArray(cases))throw new Error("Evaluation input must be an array of cases");
  const result=evaluateCases(cases);const json=JSON.stringify(result,null,2)+"\n";
  const out=arg("out");if(out){mkdirSync(dirname(out),{recursive:true});writeFileSync(out,json);}
  console.log(json);process.exit(result.passed?0:1);
} else if (command === "parity") {
  const schemaPath = need("schema");
  const name = slugify(arg("name") ?? basename(schemaPath).replace(/\.(claymate\.)?json$/, ""), 24);
  const mappingFile = arg("mappings");
  const plan = planMigration(parseClaySchema(readFileSync(schemaPath, "utf8")), name, mappingFile ? parseOverrides(readFileSync(mappingFile, "utf8")) : {});
  const result = runParity(plan, readFileSync(need("clay"), "utf8"), readFileSync(need("cargo"), "utf8"), arg("id-column"));
  const outPath = arg("out");
  if (outPath) writeFileSync(outPath, result);
  console.log(result);
} else {
  console.log(`clay-to-cargo

  inspect --schema <claymate.json> [--mappings <mappings.json>] [--out <inspection.json>]
  compile --schema <claymate.json> --out <cargo-repo> [--name <table>] [--csv <clay-export.csv>] [--mappings <mappings.json>] [--allow-partial]
  evaluate --cases <cases.json> [--out <results.json>]
  parity  --schema <claymate.json> --clay <clay-export.csv> --cargo <cargo-export.csv> [--id-column <col>]`);
  process.exit(command ? 1 : 0);
}

#!/usr/bin/env node
// clay-to-cargo: compile a Clay table into a deployable Cargo project.
//
//   compile --schema <claymate.json> --out <cargo-repo> [--name <table>] [--csv <clay-export.csv>]
//   parity  --schema <claymate.json> --clay <clay-export.csv> --cargo <cargo-export.csv> [--name <table>] [--id-column <col>]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseClaySchema } from "./claymate.ts";
import { parseCsv } from "./csv.ts";
import { emitProject } from "./emit.ts";
import { slugify } from "./naming.ts";
import { runParity } from "./parity.ts";
import { planMigration } from "./plan.ts";
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

if (command === "compile") {
  const schemaPath = need("schema");
  const out = need("out");
  const name = slugify(arg("name") ?? basename(schemaPath).replace(/\.(claymate\.)?json$/, ""), 24);
  const schema = parseClaySchema(readFileSync(schemaPath, "utf8"));
  const csv = arg("csv");
  const rowCount = csv ? parseCsv(readFileSync(csv, "utf8")).rows.length : undefined;

  const plan = planMigration(schema, name);
  const files = emitProject(plan);
  const report = buildReport(plan, { rowCount, schemaPath });
  files.push({ path: `migrations/clay-${name.replace(/_/g, "-")}/MIGRATION_REPORT.md`, content: report });

  for (const f of files) {
    const p = join(out, f.path);
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
  console.log(`Report: ${join(out, files[files.length - 1].path)}`);
} else if (command === "parity") {
  const schemaPath = need("schema");
  const name = slugify(arg("name") ?? basename(schemaPath).replace(/\.(claymate\.)?json$/, ""), 24);
  const plan = planMigration(parseClaySchema(readFileSync(schemaPath, "utf8")), name);
  const result = runParity(plan, readFileSync(need("clay"), "utf8"), readFileSync(need("cargo"), "utf8"), arg("id-column"));
  const outPath = arg("out");
  if (outPath) writeFileSync(outPath, result);
  console.log(result);
} else {
  console.log(`clay-to-cargo

  compile --schema <claymate.json> --out <cargo-repo> [--name <table>] [--csv <clay-export.csv>]
  parity  --schema <claymate.json> --clay <clay-export.csv> --cargo <cargo-export.csv> [--id-column <col>]`);
  process.exit(command ? 1 : 0);
}

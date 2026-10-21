// Loads rows from the Clay CSV export into the Cargo model "clay_demo_companies".
//
// Pilot first: it loads 20 rows by default and only prints what it would
// send unless you pass --execute. Formulas over inputs (like DOMAIN) are
// computed here, because a Cargo workflow body cannot run them.
//
//   npx tsx scripts/clay-demo-companies/load-rows.ts --csv clay-export.csv                     # dry run
//   npx tsx scripts/clay-demo-companies/load-rows.ts --csv clay-export.csv --model-uuid <uuid> --execute
//
// Get the model uuid with: cargo-ai storage model list
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const INPUTS: { clay: string; slug: string; type: string }[] = [
  { clay: "Company Website", slug: "company_website", type: "string" },
];

type Row = Record<string, string | number | boolean | undefined>;

const FORMULAS: { slug: string; clay: string; compute: (row: Row) => unknown }[] = [

];

function domainOf(value: unknown): string {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return "";
  const host = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  return host.replace(/^www\./, "");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== "" || record.length) { record.push(field); if (record.some((f) => f !== "")) records.push(record); }
  const [headers = [], ...body] = records;
  return body.map((r) => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const csvPath = arg("csv");
if (!csvPath) {
  console.error("Usage: --csv <clay-export.csv> [--model-uuid <uuid> --execute] [--limit 20] [--id-column <Clay column>]");
  process.exit(1);
}
const limit = Number(arg("limit") ?? 20);
const idColumn = arg("id-column");
const execute = process.argv.includes("--execute");
const modelUuid = arg("model-uuid");

const rows = parseCsv(readFileSync(csvPath, "utf8")).slice(0, limit);
const records = rows.map((csvRow, n) => {
  const row: Row = {
    // Clay CSVs carry no row id, so the row number is used unless you name an
    // id column. It is what the parity script joins Clay and Cargo rows on.
    clay_row_id: idColumn ? csvRow[idColumn] : String(n + 1),
  };
  for (const c of INPUTS) {
    const raw = csvRow[c.clay] ?? "";
    row[c.slug] = raw === "" ? undefined : c.type === "number" ? Number(raw) : c.type === "boolean" ? raw.toLowerCase() === "true" : raw;
  }
  for (const f of FORMULAS) {
    const v = f.compute(row);
    row[f.slug] = v === "" || v === null ? undefined : (v as Row[string]);
  }
  return { data: row };
});

console.log(`${records.length} rows ready (limit ${limit}).`);
console.log(JSON.stringify(records.slice(0, 3), null, 2));

if (!execute) {
  console.log("\nDry run. Add --model-uuid <uuid> --execute to load them.");
  process.exit(0);
}
if (!modelUuid) {
  console.error("--execute needs --model-uuid (cargo-ai storage model list).");
  process.exit(1);
}
for (let i = 0; i < records.length; i += 50) {
  const batch = records.slice(i, i + 50);
  execFileSync("npx", ["cargo-ai", "storage", "record", "create-bulk", "--model-uuid", modelUuid, "--records", JSON.stringify(batch)], { stdio: "inherit" });
}
console.log(`Loaded ${records.length} rows into clay_demo_companies.`);

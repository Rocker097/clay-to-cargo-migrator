// Parity check: Clay's output vs Cargo's output for the same rows, per column.
// This is step 5 of Cargo's clay-to-cargo recipe ("the step that decides
// whether the user switches"), done as a script instead of by hand.
//
// Reports three numbers per migrated formula column:
//   coverage  - how many rows each side filled
//   agreement - on rows both filled, how often the values match
// and leaves the switch decision to a person.

import { parseCsv } from "./csv.ts";
import type { MigrationPlan } from "./plan.ts";

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();

function matches(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const nx = Number(x);
  const ny = Number(y);
  // Headcounts and similar drift between providers; within 10% counts as agreeing.
  if (x && y && !Number.isNaN(nx) && !Number.isNaN(ny)) return Math.abs(nx - ny) <= 0.1 * Math.max(nx, ny);
  return false;
}

export function runParity(plan: MigrationPlan, clayCsv: string, cargoCsv: string, idColumn?: string): string {
  const clay = parseCsv(clayCsv);
  const cargo = parseCsv(cargoCsv);
  const cargoById = new Map(cargo.rows.map((r) => [r["clay_row_id"] ?? r["Clay Row Id"] ?? "", r]));

  const pick = (row: Record<string, string>, keys: string[]) => {
    for (const k of keys) if (k in row) return row[k];
    return undefined;
  };

  const compared = plan.columns.filter((c) => c.generated && (c.kind === "body-formula" || c.kind === "ai"));
  const lines = [
    "# Parity: Clay vs Cargo",
    "",
    "| Column | Rows | Clay filled | Cargo filled | Both filled | Agree | Disagree rate |",
    "|---|---|---|---|---|---|---|",
  ];

  let joined = 0;
  const pairs = clay.rows
    .map((row, n) => {
      const id = idColumn ? row[idColumn] : String(n + 1);
      return { clayRow: row, cargoRow: cargoById.get(id) };
    })
    .filter((p) => p.cargoRow);
  joined = pairs.length;

  for (const c of compared) {
    const keys = [c.slug, `custom__${c.slug}`, c.clay.name];
    let clayFilled = 0;
    let cargoFilled = 0;
    let both = 0;
    let agree = 0;
    for (const { clayRow, cargoRow } of pairs) {
      const a = clayRow[c.clay.name] ?? "";
      const b = pick(cargoRow!, keys) ?? "";
      if (norm(a)) clayFilled++;
      if (norm(b)) cargoFilled++;
      if (norm(a) && norm(b)) {
        both++;
        if (c.kind === "ai" || matches(a, b)) agree++;
      }
    }
    const rate = both ? `${Math.round(((both - agree) / both) * 100)}%` : "n/a";
    const agreeCell = c.kind === "ai" ? "not scored" : String(agree);
    lines.push(`| ${c.clay.name} | ${pairs.length} | ${clayFilled} | ${cargoFilled} | ${both} | ${agreeCell} | ${c.kind === "ai" ? "n/a" : rate} |`);
  }

  lines.push(
    "",
    `${joined} of ${clay.rows.length} Clay rows matched a Cargo row on \`clay_row_id\`.`,
    "",
    "How to read this (from Cargo's recipe): compare Cargo's coverage against Clay's fill rate, not against 100%.",
    "Coverage above Clay's is only a win if the disagreement rate is low; a finder that fills more and agrees less is guessing.",
    "On an email disagreement, verify both before calling either one wrong. AI answers are free text, so they are counted, not scored.",
    "Whether this is good enough to switch is your call.",
  );
  return lines.join("\n") + "\n";
}

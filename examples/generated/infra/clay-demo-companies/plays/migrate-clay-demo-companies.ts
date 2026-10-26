import { definePlay, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

import { playsFolder } from "../folders";
import { clayDemoCompanies } from "../models/clay-demo-companies";
import { enrichCompany } from "../tools/enrich-company";
import { employeeFitStatus } from "../tools/employee-fit-status";

// One Clay row in, every migrated column out, in the order Clay ran them.
// Each column is a tool; this body only passes values between them, so a
// Clay waterfall (rung 2 runs when rung 1 found nothing) is just rung 2's
// tool reading rung 1's result.
//
// Kept to straight calls, ternaries and one write, because Cargo parses this
// body from source: no `?.`, no `??`, no `||` fallbacks.
const migrateRow = defineWorkflow(
  "migrate_clay_demo_companies_row",
  {
    input: z.object({
      id: z.string(),
      clay_row_id: z.string().optional(),
      company_website: z.string().optional(),
      reuse_enrich_company: z.boolean().optional(),
      saved_enrich_company_raw: z.string().optional(),
      saved_enrich_company_company_name: z.string().optional(),
      saved_enrich_company_employee_count: z.number().optional(),
    }),
    output: z.object({ status: z.literal("migrated") }),
    uses: { enrichCompany, employeeFitStatus },
    imports: { clayDemoCompanies },
  },
  ({ input, uses, model }) => {
    // #3 "Enrich company"
    const rEnrichCompany = uses.enrichCompany({
      domain: input.company_website,
      migrationReuse: input.reuse_enrich_company,
      savedRaw: input.saved_enrich_company_raw,
      saved_company_name: input.saved_enrich_company_company_name,
      saved_employee_count: input.saved_enrich_company_employee_count,
    });

    // #5 "Employee Fit Status"
    const rEmployeeFitStatus = uses.employeeFitStatus({
      ctxEmployeeCount: rEnrichCompany.employee_count,

    });

    // One write per row, results and stamp together, so a row is never
    // marked migrated without carrying its results. Bare slugs: the write
    // path nests them under `custom` itself.
    model.customColumn({
      modelUuid: clayDemoCompanies.uuid,
      id: input.id,
      mappings: [
        { columnSlug: "enrich_company", value: (rEnrichCompany.raw ? rEnrichCompany.raw : "") },
        { columnSlug: "employee_fit_status", value: (rEmployeeFitStatus.raw ? rEmployeeFitStatus.raw : "") },
        // Clay formula: {{@Enrich company}}?.name
        { columnSlug: "name", value: (rEnrichCompany.company_name == null ? null : rEnrichCompany.company_name) },
        // Clay formula: {{@Enrich company}}?.employee_count
        { columnSlug: "employee_count", value: (rEnrichCompany.employee_count == null ? null : rEnrichCompany.employee_count) },
        // Clay formula: {{@Employee Count}} >= 50 && {{@Employee Count}} <= 1000
        { columnSlug: "mid_size_employee_flag", value: (((rEnrichCompany.employee_count >= 50) && (rEnrichCompany.employee_count <= 1000)) == null ? null : ((rEnrichCompany.employee_count >= 50) && (rEnrichCompany.employee_count <= 1000))) },
        { columnSlug: "migrated_at", value: new Date() },
      ],
    });

    return { status: "migrated" as const };
  },
);

// Runs each row once: rows with a blank `migrated_at` enter the filter, and
// `changeKinds: ["added"]` only creates runs for rows entering it, so the
// bill scales with new rows, not with how often the schedule fires.
//
// Ships disabled. Load a pilot (the loader defaults to 20 rows), run it,
// compare against Clay with the parity script, then enable.
export const migrateClayDemoCompanies = definePlay("migrate_clay_demo_companies", {
  description: "Runs the migrated Clay table \"demo companies\" on each new row and writes the results back.",
  folder: playsFolder,
  model: clayDemoCompanies,
  workflow: migrateRow,
  filter: {
    conjonction: "and",
    groups: [
      {
        conjonction: "and",
        conditions: [
          {
            kind: "date",
            columnSlug: clayDemoCompanies.columns.custom__migrated_at,
            operator: "isNull",
          },
        ],
      },
    ],
  },
  isEnabled: false,
  runCreationRule: "noConcurrency",
  changeKinds: ["added"],
  schedule: { type: "cron", cron: "0 * * * *" },
});

import { definePlay, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

import { playsFolder } from "../folders";
import { clayFifteenColumnTest } from "../models/clay-fifteen-column-test";
import { enrichCompany } from "../tools/enrich-company";

// One Clay row in, every migrated column out, in the order Clay ran them.
// Each column is a tool; this body only passes values between them, so a
// Clay waterfall (rung 2 runs when rung 1 found nothing) is just rung 2's
// tool reading rung 1's result.
//
// Kept to straight calls, ternaries and one write, because Cargo parses this
// body from source: no `?.`, no `??`, no `||` fallbacks.
const migrateRow = defineWorkflow(
  "migrate_clay_fifteen_column_test_row",
  {
    input: z.object({
      id: z.string(),
      clay_row_id: z.string().optional(),
      domain: z.string().optional(),
      domain_status: z.string().optional(),
      readiness_score: z.number().optional(),
      priority: z.string().optional(),
      adjusted_score: z.number().optional(),
      routing_team: z.string().optional(),
      account_summary: z.string().optional(),
      score_band: z.string().optional(),
      routing_label: z.string().optional(),
      ready_flag: z.boolean().optional(),
      followup_days: z.number().optional(),
      uppercase_domain: z.string().optional(),
      domain_length: z.number().optional(),
      reuse_enrich_company: z.boolean().optional(),
      saved_enrich_company_raw: z.string().optional(),
      saved_enrich_company_linkedin_url: z.string().optional(),
    }),
    output: z.object({ status: z.literal("migrated") }),
    uses: { enrichCompany },
    imports: { clayFifteenColumnTest },
  },
  ({ input, uses, model }) => {
    // #2 "Enrich Company"
    const rEnrichCompany = uses.enrichCompany({
      domain: input.domain,
      migrationReuse: input.reuse_enrich_company,
      savedRaw: input.saved_enrich_company_raw,
      saved_linkedin_url: input.saved_enrich_company_linkedin_url,
    });

    // One write per row, results and stamp together, so a row is never
    // marked migrated without carrying its results. Bare slugs: the write
    // path nests them under `custom` itself.
    model.customColumn({
      modelUuid: clayFifteenColumnTest.uuid,
      id: input.id,
      mappings: [
        { columnSlug: "enrich_company", value: (rEnrichCompany.raw ? rEnrichCompany.raw : "") },
        // Clay formula: {{@Enrich Company}}.url
        { columnSlug: "url", value: (rEnrichCompany.linkedin_url == null ? null : rEnrichCompany.linkedin_url) },
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
export const migrateClayFifteenColumnTest = definePlay("migrate_clay_fifteen_column_test", {
  description: "Runs the migrated Clay table \"fifteen column test\" on each new row and writes the results back.",
  folder: playsFolder,
  model: clayFifteenColumnTest,
  workflow: migrateRow,
  filter: {
    conjonction: "and",
    groups: [
      {
        conjonction: "and",
        conditions: [
          {
            kind: "date",
            columnSlug: clayFifteenColumnTest.columns.custom__migrated_at,
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

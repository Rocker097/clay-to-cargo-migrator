import { defineModel } from "@cargo-ai/cdk";

import { modelsFolder } from "../folders";

// The Clay table as a native Cargo model, so it deploys on a bare workspace
// with no CRM attached.
//
// `config.columns` are the values loaded from the Clay CSV (inputs, plus
// formulas over inputs that the loader computes). `additionalColumns` are
// what the play writes back: one column per migrated enrichment, AI or
// formula column, plus the `migrated_at` stamp.
export const clayFifteenColumnTest = defineModel("clay_fifteen_column_test", {
  name: "Clay: fifteen column test",
  kind: "native",
  extractSlug: "defineCustom",
  config: {
    columns: [
      { slug: "clay_row_id", type: "string" },
      { slug: "domain", type: "string" }, // Clay: "Domain"
      { slug: "domain_status", type: "string" }, // Clay: "Domain Status"
      { slug: "readiness_score", type: "number" }, // Clay: "Readiness Score"
      { slug: "priority", type: "string" }, // Clay: "Priority"
      { slug: "adjusted_score", type: "number" }, // Clay: "Adjusted Score"
      { slug: "routing_team", type: "string" }, // Clay: "Routing Team"
      { slug: "account_summary", type: "string" }, // Clay: "Account Summary"
      { slug: "score_band", type: "string" }, // Clay: "Score Band"
      { slug: "routing_label", type: "string" }, // Clay: "Routing Label"
      { slug: "ready_flag", type: "boolean" }, // Clay: "Ready Flag"
      { slug: "followup_days", type: "number" }, // Clay: "Followup Days"
      { slug: "uppercase_domain", type: "string" }, // Clay: "Uppercase Domain"
      { slug: "domain_length", type: "number" }, // Clay: "Domain Length"
      { slug: "reuse_enrich_company", type: "boolean" }, // Clay: "Migration cache: reuse_enrich_company"
      { slug: "saved_enrich_company_raw", type: "string" }, // Clay: "Migration cache: saved_enrich_company_raw"
      { slug: "saved_enrich_company_linkedin_url", type: "string" }, // Clay: "Migration cache: saved_enrich_company_linkedin_url"
    ],
  },
  additionalColumns: [
    {
      kind: "custom",
      slug: "enrich_company",
      type: "string",
      label: "Enrich Company",
      description: "Raw result (JSON) of linkedin.enrichCompanyFromDomain, from the Clay column \"Enrich Company\".",
    },
    {
      kind: "custom",
      slug: "url",
      type: "string",
      label: "Url",
      description: "Clay formula: {{@Enrich Company}}.url",
    },
    {
      kind: "custom",
      slug: "migrated_at",
      type: "date",
      label: "Migrated at",
      description: "When the migration play wrote this row. Blank means not run yet; the play's once-only key.",
    },
  ],
  folder: modelsFolder,
});

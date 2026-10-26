import { defineModel } from "@cargo-ai/cdk";

import { modelsFolder } from "../folders";

// The Clay table as a native Cargo model, so it deploys on a bare workspace
// with no CRM attached.
//
// `config.columns` are the values loaded from the Clay CSV (inputs, plus
// formulas over inputs that the loader computes). `additionalColumns` are
// what the play writes back: one column per migrated enrichment, AI or
// formula column, plus the `migrated_at` stamp.
export const clayDemoCompanies = defineModel("clay_demo_companies", {
  name: "Clay: demo companies",
  kind: "native",
  extractSlug: "defineCustom",
  config: {
    columns: [
      { slug: "clay_row_id", type: "string" },
      { slug: "company_website", type: "string" }, // Clay: "Company Website"
      { slug: "reuse_enrich_company", type: "boolean" }, // Clay: "Migration cache: reuse_enrich_company"
      { slug: "saved_enrich_company_raw", type: "string" }, // Clay: "Migration cache: saved_enrich_company_raw"
      { slug: "saved_enrich_company_company_name", type: "string" }, // Clay: "Migration cache: saved_enrich_company_company_name"
      { slug: "saved_enrich_company_employee_count", type: "number" }, // Clay: "Migration cache: saved_enrich_company_employee_count"
    ],
  },
  additionalColumns: [
    {
      kind: "custom",
      slug: "enrich_company",
      type: "string",
      label: "Enrich company",
      description: "Raw result (JSON) of linkedin.enrichCompanyFromDomain, from the Clay column \"Enrich company\".",
    },
    {
      kind: "custom",
      slug: "employee_fit_status",
      type: "string",
      label: "Employee Fit Status",
      description: "Agent answer (JSON) for the Clay AI column \"Employee Fit Status\".",
    },
    {
      kind: "custom",
      slug: "name",
      type: "string",
      label: "Name",
      description: "Clay formula: {{@Enrich company}}?.name",
    },
    {
      kind: "custom",
      slug: "employee_count",
      type: "number",
      label: "Employee Count",
      description: "Clay formula: {{@Enrich company}}?.employee_count",
    },
    {
      kind: "custom",
      slug: "mid_size_employee_flag",
      type: "boolean",
      label: "Mid-Size Employee Flag",
      description: "Clay formula: {{@Employee Count}} >= 50 && {{@Employee Count}} <= 1000",
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

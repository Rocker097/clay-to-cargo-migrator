import { defineTool, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

import { linkedin } from "../connectors";
import { toolsFolder } from "../folders";

// Clay column "Enrich company" (#3), action `cpj-enrich-company`.
// Cargo job: Enrich company from domain -> linkedin.enrichCompanyFromDomain (0.5 credits per call).
// Provider swap: Clay ran cpj; Cargo runs linkedin.enrichCompanyFromDomain.
// No writes here: the play owns what gets stored, so the tool stays reusable.
const workflow = defineWorkflow(
  "clay_demo_companies_enrich_company_workflow",
  {
    input: z.object({
      domain: z.string().optional(), // Clay input "company_identifier": {{@Company Website}}
      migrationReuse: z.boolean().optional(), // Explicit reuse of exported Clay values
      savedRaw: z.string().optional(), // Original/exported result
      saved_company_name: z.string().optional(), // CSV Name
      saved_employee_count: z.number().optional(), // CSV Employee Count
    }),
    output: z.object({
      raw: z.string().optional(),
      company_name: z.string().optional(),
      employee_count: z.number().optional(),
    }),
    uses: { linkedin },
  },
  ({ input, uses }) => {
    if (input.migrationReuse) {
      return { raw: input.savedRaw, company_name: input.saved_company_name, employee_count: input.saved_employee_count };
    }

    const result = uses.linkedin.enrichCompanyFromDomain({
      domain: (input.domain ? input.domain.trim().toLowerCase().replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0].split("?")[0].split("#")[0] : ""),
    });

    return {
      raw: JSON.stringify(result),
      company_name: result.company_name,
      employee_count: result.employee_count,
    };
  },
);

export const enrichCompany = defineTool("clay_demo_companies_enrich_company", {
  folder: toolsFolder,
  workflow,
  name: "Enrich company",
  description: "Migrated from the Clay column \"Enrich company\": enrich company from domain. Returns the raw result; writes nothing.",
});

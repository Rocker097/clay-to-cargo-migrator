import { defineTool, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

import { linkedin } from "../connectors";
import { toolsFolder } from "../folders";

// Clay column "Enrich Company" (#2), action `enrich-company-with-mixrank-v2`.
// Cargo job: Enrich company from domain -> linkedin.enrichCompanyFromDomain (0.5 credits per call).
// Provider swap: Clay ran enrich; Cargo runs linkedin.enrichCompanyFromDomain.
// No writes here: the play owns what gets stored, so the tool stays reusable.
const workflow = defineWorkflow(
  "clay_fifteen_column_test_enrich_company_workflow",
  {
    input: z.object({
      domain: z.string().optional(), // Clay input "company_identifier": {{@Domain}}
      migrationReuse: z.boolean().optional(), // Explicit reuse of exported Clay values
      savedRaw: z.string().optional(), // Original/exported result
      saved_linkedin_url: z.string().optional(), // CSV Url
    }),
    output: z.object({
      raw: z.string().optional(),
      linkedin_url: z.string().optional(),
    }),
    uses: { linkedin },
  },
  ({ input, uses }) => {
    if (input.migrationReuse) {
      return { raw: input.savedRaw, linkedin_url: input.saved_linkedin_url };
    }

    const result = uses.linkedin.enrichCompanyFromDomain({
      domain: (input.domain ? input.domain.trim().toLowerCase().replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0].split("?")[0].split("#")[0] : ""),
    });

    return {
      raw: JSON.stringify(result),
      linkedin_url: result.linkedin_url,
    };
  },
);

export const enrichCompany = defineTool("clay_fifteen_column_test_enrich_company", {
  folder: toolsFolder,
  workflow,
  name: "Enrich Company",
  description: "Migrated from the Clay column \"Enrich Company\": enrich company from domain. Returns the raw result; writes nothing.",
});

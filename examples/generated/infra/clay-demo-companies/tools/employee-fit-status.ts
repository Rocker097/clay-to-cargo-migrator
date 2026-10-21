import { defineTool, defineWorkflow } from "@cargo-ai/cdk";
import { z } from "zod";

import { employeeFitStatusAgent } from "../agents/employee-fit-status";
import { toolsFolder } from "../folders";

// Clay column "Employee Fit Status" (#5), action `use-ai`.
// No writes here: the play owns what gets stored, so the tool stays reusable.
const workflow = defineWorkflow(
  "clay_demo_companies_employee_fit_status_workflow",
  {
    input: z.object({
      ctxEmployeeCount: z.any().optional(), // prompt reads {{@Employee Count}}
    }),
    output: z.object({
      raw: z.string().optional(),
      answer: z.string().optional(),
    }),
    uses: { employeeFitStatusAgent },
  },
  ({ input, uses }) => {
    const result = uses.employeeFitStatusAgent({
      prompt: `${("Return FIT if the employee count is between 50 and 1000 inclusive; otherwise return NOT FIT. Use only this employee count: " + (input.ctxEmployeeCount == null ? "" : input.ctxEmployeeCount))}`,
    });

    return {
      raw: JSON.stringify(result.answer),
      answer: result.answer.answer,
    };
  },
);

export const employeeFitStatus = defineTool("clay_demo_companies_employee_fit_status", {
  folder: toolsFolder,
  workflow,
  name: "Employee Fit Status",
  description: "Migrated from the Clay AI column \"Employee Fit Status\". Answers its prompt for one row.",
});

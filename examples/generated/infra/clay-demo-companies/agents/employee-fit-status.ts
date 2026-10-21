import { defineAgent } from "@cargo-ai/cdk";

import { anthropic } from "../connectors";
import { agentsFolder } from "../folders";

// Clay AI column "Employee Fit Status" (#5). The prompt itself is
// passed in by the tool, with the row's values filled in, so this agent only
// fixes the answer's shape and keeps it from writing anywhere.
export const employeeFitStatusAgent = defineAgent("clay_demo_companies_employee_fit_status", {
  connector: anthropic,
  languageModel: "claude-sonnet-5", // PLACEHOLDER: a model your Anthropic connector exposes
  systemPrompt: [
    "You answer one question about one row of a go-to-market table.",
    "Use only the facts given in the prompt. If they are not enough to answer, say so in the answer rather than guessing.",
    "Return the answer only, in the exact JSON shape requested. You do not write to any model.",
  ].join(" "),
  output: {
    type: "jsonSchema",
    jsonSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "The answer to the prompt." },
      },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  maxSteps: 2,
  folder: agentsFolder,
});

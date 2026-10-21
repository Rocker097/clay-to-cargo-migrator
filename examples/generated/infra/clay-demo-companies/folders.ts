import { defineFolder } from "@cargo-ai/cdk";

// Everything this migration deploys is filed under folders named after the
// Clay table, so it is easy to see what came from the migration and to remove
// it as one unit. Folders are per resource kind.
export const modelsFolder = defineFolder("clay_demo_companies_models", {
  kind: "model",
  name: "Clay: demo companies",
});

export const toolsFolder = defineFolder("clay_demo_companies_tools", {
  kind: "tool",
  name: "Clay: demo companies",
});

export const playsFolder = defineFolder("clay_demo_companies_plays", {
  kind: "play",
  name: "Clay: demo companies",
});

export const agentsFolder = defineFolder("clay_demo_companies_agents", {
  kind: "agent",
  name: "Clay: demo companies",
});

import { defineFolder } from "@cargo-ai/cdk";

// Everything this migration deploys is filed under folders named after the
// Clay table, so it is easy to see what came from the migration and to remove
// it as one unit. Folders are per resource kind.
export const modelsFolder = defineFolder("clay_fifteen_column_test_models", {
  kind: "model",
  name: "Clay: fifteen column test",
});

export const toolsFolder = defineFolder("clay_fifteen_column_test_tools", {
  kind: "tool",
  name: "Clay: fifteen column test",
});

export const playsFolder = defineFolder("clay_fifteen_column_test_plays", {
  kind: "play",
  name: "Clay: fifteen column test",
});

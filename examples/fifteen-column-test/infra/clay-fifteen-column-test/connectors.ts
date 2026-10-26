import { defineConnector } from "@cargo-ai/cdk";

// Bound, not created: `default: true` links the workspace's existing
// connector for each integration, so nothing here holds a credential.
// Connect each one once in the Cargo app before deploying.
export const linkedin = defineConnector("linkedin", {
  integration: "linkedin",
  default: true,
});

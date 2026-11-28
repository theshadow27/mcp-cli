import type { Stage } from "am-i-done";

export default {
  id: "agent-grid",
  description: "agent-grid/versions.yaml schema validation",
  command: "bun scripts/validate-agent-grid.ts",
  onFailure: ["fix the validation errors reported above", "schema: agent-grid/versions-schema.ts"],
} satisfies Stage;

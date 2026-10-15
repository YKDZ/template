import { runTaskGateCli } from "@ykdz/template-builtin-presets/task-gates";

void runTaskGateCli(
  "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts",
);

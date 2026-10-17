import { runTaskGateCli } from "@ykdz/template-workspace/task-gates";

await runTaskGateCli(
  "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts",
);

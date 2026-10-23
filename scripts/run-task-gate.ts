import { runTaskGateCli } from "@ykdz/reference-workspace-root/task-gates";

await runTaskGateCli(
  "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts",
);

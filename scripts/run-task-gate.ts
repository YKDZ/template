import { runTaskGateCli } from "@ykdz/reference-workspace-root/task-gates";

await runTaskGateCli("node --conditions=source scripts/run-task-gate.ts");

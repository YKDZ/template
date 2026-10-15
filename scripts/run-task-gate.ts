import { runTaskGate } from "@ykdz/template-builtin-presets/task-gates";

const requestedGate = process.argv[2];

if (
  requestedGate !== "check" &&
  requestedGate !== "check:heavy" &&
  requestedGate !== "check:full" &&
  requestedGate !== "fix"
) {
  process.stderr.write(
    "用法：node scripts/run-task-gate.ts <check|check:heavy|check:full|fix>\n",
  );
  process.exitCode = 2;
} else {
  void runTaskGate(
    requestedGate,
    process.cwd(),
    "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts",
  )
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `公共任务入口失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

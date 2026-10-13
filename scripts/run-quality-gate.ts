import {
  runQualityGate,
  type QualityGate,
} from "@ykdz/template-builtin-presets/quality-gates";

const requestedGate = process.argv[2];

if (
  requestedGate !== "check" &&
  requestedGate !== "check:heavy" &&
  requestedGate !== "check:full"
) {
  process.stderr.write(
    "用法：node scripts/run-quality-gate.ts <check|check:heavy|check:full>\n",
  );
  process.exitCode = 2;
} else {
  void runQualityGate(requestedGate as QualityGate)
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `公共验收入口失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

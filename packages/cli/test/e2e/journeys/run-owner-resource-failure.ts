import { rename } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

const [mode, packageRoot, workDir] = process.argv.slice(2);
if (
  (mode !== "source" && mode !== "distribution") ||
  packageRoot === undefined ||
  workDir === undefined
) {
  throw new Error("必须提供 CLI 模式、包目录和旅程工作目录");
}

const resourcePath = path.resolve(
  packageRoot,
  "../../references/ts-lib/tsconfig.template.json",
);
const backupPath = `${resourcePath}.ticket-20-${process.pid}.bak`;
const cliEntry =
  mode === "source"
    ? ["--conditions=source", path.join(packageRoot, "src/cli.ts")]
    : [path.join(packageRoot, "dist/cli.js")];

await rename(resourcePath, backupPath);
try {
  const result = await execa(
    process.execPath,
    [
      ...cliEntry,
      "init",
      "owner-resource-project",
      "--preset",
      "ts-lib",
      "--scope",
      "acme",
    ],
    {
      cwd: workDir,
      reject: false,
      stripFinalNewline: false,
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode ?? 1;
} finally {
  await rename(backupPath, resourcePath);
}

import { rename } from "node:fs/promises";
import path from "node:path";

import { templateContent } from "@ykdz/template-content";
import { resolveTemplateSource } from "@ykdz/template-core/renderer";
import { execa } from "execa";

const [mode, packageRoot, workDir] = process.argv.slice(2);
if (
  (mode !== "source" && mode !== "distribution") ||
  packageRoot === undefined ||
  workDir === undefined
) {
  throw new Error("必须提供 CLI 模式、包目录和旅程工作目录");
}

const owner = templateContent.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@ykdz/reference-ts-lib",
);
if (owner?.kind !== "reference") {
  throw new Error("唯一内容集合缺少参考库资源拥有者");
}
const resourcePath = resolveTemplateSource(
  owner.definition.source("tsconfig.template.json"),
  ".",
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

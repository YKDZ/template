import { readFile } from "node:fs/promises";
import path from "node:path";

import { acceptArtifact } from "../publication.ts";

const packageRoot = process.cwd();
const explicitArtifactPath = process.env.NPM_PUBLICATION_ARTIFACT_PATH;
const outputDirectory = path.resolve(
  process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
    path.join(packageRoot, ".publication-artifacts"),
);

async function preparedArtifactPath(): Promise<string> {
  if (explicitArtifactPath !== undefined && explicitArtifactPath.length > 0) {
    return path.resolve(explicitArtifactPath);
  }
  const receiptPath = path.join(
    outputDirectory,
    "publication-preparation.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("artifact" in receipt) ||
    typeof receipt.artifact !== "object" ||
    receipt.artifact === null ||
    !("path" in receipt.artifact) ||
    typeof receipt.artifact.path !== "string"
  ) {
    throw new Error(`正式制品准备记录格式无效：${receiptPath}`);
  }
  return path.join(outputDirectory, receipt.artifact.path);
}

const artifactPath = await preparedArtifactPath();
const result = await acceptArtifact({
  packageRoot,
  artifactPath,
});
if (result.kind === "blocked") {
  console.error("npm 制品消费验收未执行：目标配置不完整。");
  for (const item of result.inspection.blockers) {
    console.error(`问题：${item.code}`);
    console.error(`目标：${item.target}${item.field}`);
    console.error(`处理方法：${item.nextAction}`);
  }
  process.exitCode = 1;
} else {
  console.log(`npm 制品消费验收通过：${result.packageName}`);
  console.log(`归档版本：${result.artifactVersion}`);
  console.log(`原件：${result.artifactPath}`);
  console.log(`SHA-512：${result.sha512}`);
}

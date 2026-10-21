import path from "node:path";

import { prepareArtifact } from "./publication.ts";

const configuredDirectory = process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY;
const outputDirectory =
  configuredDirectory === undefined
    ? path.join(process.cwd(), ".publication-artifacts")
    : path.resolve(configuredDirectory);
const result = await prepareArtifact({
  packageRoot: process.cwd(),
  outputDirectory,
});

if (result.kind === "blocked") {
  console.error("npm 制品准备未执行：目标配置不完整。");
  for (const item of result.inspection.blockers) {
    console.error(`问题：${item.code}`);
    console.error(`目标：${item.target}${item.field}`);
    console.error(`处理方法：${item.nextAction}`);
  }
  process.exitCode = 1;
} else {
  console.log(`npm 制品：${result.artifactPath}`);
  console.log(`SHA-512：${result.sha512}`);
}

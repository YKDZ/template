import path from "node:path";

import { acceptArtifact, readPreparedArtifact } from "../publication.ts";
import { publicationTarget } from "./target.ts";

const { packageRoot, outputDirectory } = await publicationTarget();
const explicitArtifactPath = process.env.NPM_PUBLICATION_ARTIFACT_PATH;
const prepared = await readPreparedArtifact(
  explicitArtifactPath === undefined || explicitArtifactPath.length === 0
    ? { packageRoot, artifactDirectory: outputDirectory }
    : { packageRoot, artifactPath: path.resolve(explicitArtifactPath) },
);
if (prepared.kind === "blocked") {
  console.error("npm 制品消费验收未执行：目标配置不完整。");
  for (const item of prepared.inspection.blockers) {
    console.error(`问题：${item.code}`);
    console.error(`目标：${item.target}${item.field}`);
    console.error(`处理方法：${item.nextAction}`);
  }
  process.exitCode = 1;
} else {
  const result = await acceptArtifact({
    packageRoot,
    artifactPath: prepared.artifactPath,
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
}

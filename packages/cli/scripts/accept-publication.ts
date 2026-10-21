import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptArtifact,
  readPreparedArtifact,
} from "@ykdz/reference-npm-publication";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const explicitArtifact = process.env.TEMPLATE_PUBLICATION_ARTIFACT_PATH;
const outputDirectoryOverride =
  process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
  process.env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
const outputDirectory = path.resolve(
  outputDirectoryOverride ??
    path.join(packageRoot, "node_modules/.cache/npm-publication"),
);

async function preparedArtifactPath(): Promise<string> {
  if (explicitArtifact !== undefined) return path.resolve(explicitArtifact);
  const prepared = await readPreparedArtifact({
    packageRoot,
    artifactDirectory: outputDirectory,
  });
  if (prepared.kind === "blocked") {
    throw new Error("正式 CLI 制品尚不满足共享发布目标配置。");
  }
  return prepared.artifactPath;
}

const artifactPath = await preparedArtifactPath();
const accepted = await acceptArtifact({ packageRoot, artifactPath });
if (accepted.kind === "blocked") {
  console.error("正式 CLI 制品消费验收未执行：目标配置不完整。");
  for (const blocker of accepted.inspection.blockers) {
    console.error(`${blocker.target}${blocker.field}：${blocker.observed}`);
    console.error(`需要：${blocker.expected}`);
    console.error(`处理方法：${blocker.nextAction}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `正式 CLI 消费验收通过：${accepted.packageName}@${accepted.artifactVersion}`,
  );
  console.log(`原件：${accepted.artifactPath}`);
  console.log(`SHA512：${accepted.sha512}`);
  console.log(
    `NPM_PUBLICATION_ACCEPTED_JSON:${JSON.stringify({
      artifactPath: accepted.artifactPath,
      packageName: accepted.packageName,
      artifactVersion: accepted.artifactVersion,
      sha512: accepted.sha512,
      receiptPath: accepted.receiptPath,
    })}`,
  );
}

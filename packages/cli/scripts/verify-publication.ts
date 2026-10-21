import path from "node:path";
import { fileURLToPath } from "node:url";

import { readAcceptedArtifact } from "@ykdz/reference-npm-publication";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDirectory = process.env.PUBLICATION_ARTIFACT_DIRECTORY;
if (artifactDirectory === undefined || !path.isAbsolute(artifactDirectory)) {
  throw new Error("PUBLICATION_ARTIFACT_DIRECTORY 必须是绝对路径。");
}

const accepted = await readAcceptedArtifact({
  packageRoot,
  artifactDirectory,
});
if (accepted.kind !== "prepared") {
  for (const blocker of accepted.inspection.blockers) {
    console.error(
      `${blocker.target}${blocker.field}：${blocker.observed}；${blocker.nextAction}`,
    );
  }
  process.exitCode = 1;
} else {
  console.error(
    `已验收原件：${accepted.packageName}@${accepted.artifactVersion} sha512-${Buffer.from(accepted.sha512, "hex").toString("base64")}`,
  );
  process.stdout.write(`${accepted.artifactPath}\n`);
}

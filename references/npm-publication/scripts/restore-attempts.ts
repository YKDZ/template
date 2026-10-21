import { appendFile } from "node:fs/promises";
import path from "node:path";

import { readAcceptedPublicationArtifacts } from "./accepted-artifacts.ts";
import { restoreNpmPublicationAttempt } from "./publish.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const environment = process.env;
const artifacts = await readAcceptedPublicationArtifacts({
  repositoryRoot,
  environment,
});
const restored = [];
for (const artifact of artifacts) {
  restored.push(
    await restoreNpmPublicationAttempt({
      repositoryRoot,
      packageRoot: artifact.packageRoot,
      artifactDirectory: path.dirname(artifact.artifactPath),
      environment,
    }),
  );
}
if (restored.some(Boolean) && !restored.every(Boolean)) {
  throw new Error("上传尝试标记只恢复了部分原件，已停止本次发布。");
}
const output = `restored=${restored.every(Boolean)}\n`;
if (environment.GITHUB_OUTPUT !== undefined) {
  await appendFile(environment.GITHUB_OUTPUT, output);
} else {
  process.stdout.write(output);
}

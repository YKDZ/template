import path from "node:path";

import { readAcceptedPublicationArtifacts } from "./accepted-artifacts.ts";
import { markNpmPublicationAttempt } from "./publish.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const environment = process.env;
const artifacts = await readAcceptedPublicationArtifacts({
  repositoryRoot,
  environment,
});
for (const artifact of artifacts) {
  await markNpmPublicationAttempt({
    repositoryRoot,
    packageRoot: artifact.packageRoot,
    artifactDirectory: path.dirname(artifact.artifactPath),
    environment,
    ...(environment.PUBLICATION_DIST_TAG === undefined
      ? {}
      : { distTag: environment.PUBLICATION_DIST_TAG }),
  });
}
process.stdout.write(`已在 ${artifacts.length} 份原件回执中记录上传尝试。\n`);

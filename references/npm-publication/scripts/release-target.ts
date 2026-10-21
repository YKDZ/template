import path from "node:path";

import { currentAcceptedPublicationArtifact } from "./accepted-artifacts.ts";
import { runImmutableGithubRelease } from "./release.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const artifact = await currentAcceptedPublicationArtifact({
  repositoryRoot,
  environment: process.env,
  packageRoot: process.cwd(),
});
await runImmutableGithubRelease({
  repositoryRoot,
  packageRoot: artifact.packageRoot,
  artifactDirectory: path.dirname(artifact.artifactPath),
  environment: process.env,
});

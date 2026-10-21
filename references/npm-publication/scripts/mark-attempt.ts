#!/usr/bin/env node
import path from "node:path";

import { markNpmPublicationAttempt } from "./publish.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const packageRoot = process.env.PUBLICATION_PACKAGE_ROOT;
const artifactDirectory = process.env.PUBLICATION_ARTIFACT_DIRECTORY;
if (
  packageRoot === undefined ||
  !path.isAbsolute(packageRoot) ||
  artifactDirectory === undefined ||
  !path.isAbsolute(artifactDirectory)
) {
  throw new Error(
    "PUBLICATION_PACKAGE_ROOT 和 PUBLICATION_ARTIFACT_DIRECTORY 必须是绝对路径。",
  );
}

await markNpmPublicationAttempt({
  repositoryRoot,
  packageRoot,
  artifactDirectory,
  environment: process.env,
  ...(process.env.PUBLICATION_DIST_TAG === undefined
    ? {}
    : { distTag: process.env.PUBLICATION_DIST_TAG }),
});

process.stdout.write("OK npm-publication-attempt-marked\n");

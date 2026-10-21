#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import path from "node:path";

import { restoreNpmPublicationAttempt } from "./publish.ts";

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
    "PUBLICATION_PACKAGE_ROOT 与 PUBLICATION_ARTIFACT_DIRECTORY 必须是绝对路径。",
  );
}

const restored = await restoreNpmPublicationAttempt({
  repositoryRoot,
  packageRoot,
  artifactDirectory,
  environment: process.env,
});
const output = `restored=${restored}\n`;
if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(process.env.GITHUB_OUTPUT, output);
} else {
  process.stdout.write(output);
}

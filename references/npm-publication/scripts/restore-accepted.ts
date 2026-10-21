import { appendFile } from "node:fs/promises";
import path from "node:path";

import { restoreAcceptedPublicationArtifacts } from "./accepted-artifacts.ts";

const environment = process.env;
const repositoryRoot = path.resolve(
  environment.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const artifactDirectory = path.resolve(
  environment.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
    path.join(repositoryRoot, ".verified-packed-publication"),
);
const sourceSha = environment.PUBLICATION_SOURCE_SHA ?? environment.GITHUB_SHA;
const runId = environment.GITHUB_RUN_ID;
const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
const githubRepository = environment.GITHUB_REPOSITORY;
if (
  sourceSha === undefined ||
  runId === undefined ||
  githubRepository === undefined
) {
  throw new Error("恢复已验收原件缺少 GitHub 工作流上下文。");
}
const filters = (environment.PUBLICATION_TARGET_FILTERS ?? "")
  .split(/\r?\n/u)
  .map((filter) => filter.trim())
  .filter((filter) => filter.length > 0);
const restored = await restoreAcceptedPublicationArtifacts({
  repositoryRoot,
  artifactDirectory,
  sourceSha,
  filters,
  runId,
  runAttempt,
  githubRepository,
  environment,
});
const output = `restored=${restored}\n`;
if (environment.GITHUB_OUTPUT !== undefined) {
  await appendFile(environment.GITHUB_OUTPUT, output);
} else {
  process.stdout.write(output);
}

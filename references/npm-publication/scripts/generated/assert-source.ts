import { assertRemotePreparation } from "../remote-context.ts";

const sourceSha = process.env.PUBLICATION_SOURCE_SHA ?? process.env.GITHUB_SHA;
const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH;
if (sourceSha === undefined || defaultBranch === undefined) {
  throw new Error("远端制品准备需要 PUBLICATION_SOURCE_SHA 与默认分支。");
}

await assertRemotePreparation({
  repositoryRoot: process.cwd(),
  sourceSha,
  defaultBranch,
  environment: process.env,
});

import { prepareArtifact } from "../publication.ts";
import { assertRemotePreparation } from "../remote-context.ts";
import { publicationTarget } from "./target.ts";

const { packageRoot, outputDirectory } = await publicationTarget();
const sourceSha = process.env.PUBLICATION_SOURCE_SHA;
if (sourceSha !== undefined) {
  const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH;
  if (defaultBranch === undefined) {
    throw new Error("远端原件准备需要 GITHUB_DEFAULT_BRANCH。");
  }
  await assertRemotePreparation({
    repositoryRoot: process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
    sourceSha,
    defaultBranch,
    environment: process.env,
  });
}
const result = await prepareArtifact({
  packageRoot,
  outputDirectory,
  ...(sourceSha === undefined ? {} : { sourceSha }),
});

if (result.kind === "blocked") {
  console.error("npm 制品准备未执行：目标配置不完整。");
  for (const item of result.inspection.blockers) {
    console.error(`问题：${item.code}`);
    console.error(`目标：${item.target}${item.field}`);
    console.error(`处理方法：${item.nextAction}`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(result.pack.stdout);
  process.stderr.write(result.pack.stderr);
  console.log(`npm 制品：${result.artifactPath}`);
  console.log(`源清单版本：${result.packageVersion}`);
  console.log(`归档身份：${result.packageName}@${result.artifactVersion}`);
  console.log(`SHA-512：${result.sha512}`);
}

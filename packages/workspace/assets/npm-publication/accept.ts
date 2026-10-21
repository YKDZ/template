import { acceptArtifact } from "./publication.ts";

const artifactPath = process.env.NPM_PUBLICATION_ARTIFACT_PATH;
if (artifactPath === undefined || artifactPath.length === 0) {
  throw new Error(
    "缺少 NPM_PUBLICATION_ARTIFACT_PATH；消费验收必须接收正式准备好的原始 tgz。",
  );
}

const result = await acceptArtifact({
  packageRoot: process.cwd(),
  artifactPath,
});
if (result.kind === "blocked") {
  console.error("npm 制品消费验收未执行：目标配置不完整。");
  for (const item of result.inspection.blockers) {
    console.error(`问题：${item.code}`);
    console.error(`目标：${item.target}${item.field}`);
    console.error(`处理方法：${item.nextAction}`);
  }
  process.exitCode = 1;
} else {
  console.log(`npm 制品消费验收通过：${result.packageName}`);
  console.log(`SHA-512：${result.sha512}`);
}

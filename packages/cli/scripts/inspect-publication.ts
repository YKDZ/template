import { inspectTarget } from "@ykdz/reference-npm-publication";

const result = await inspectTarget({ packageRoot: process.cwd() });
if (result.kind === "ready") {
  console.log(
    `npm 发布目标已配置：${result.packageName}@${result.packageVersion}`,
  );
} else {
  console.error("npm 发布目标尚未配置：");
  for (const blocker of result.blockers) {
    console.error(`问题：${blocker.code}`);
    console.error(`目标：${blocker.target}${blocker.field}`);
    console.error(`观察到：${blocker.observed}`);
    console.error(`需要：${blocker.expected}`);
    console.error(`处理方法：${blocker.nextAction}`);
  }
  process.exitCode = 1;
}

import { inspectTarget } from "../publication.ts";

const packageRoot = process.cwd();
const result = await inspectTarget({ packageRoot });
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result));
  if (result.kind === "blocked") process.exitCode = 1;
} else if (result.kind === "ready") {
  console.log(
    `npm 发布目标已配置：${result.packageName}@${result.packageVersion}`,
  );
} else {
  console.error("npm 发布目标尚未配置：");
  for (const item of result.blockers) {
    console.error(`问题：${item.code}`);
    console.error(`目标：${item.target}${item.field}`);
    console.error(`观察到：${item.observed}`);
    console.error(`需要：${item.expected}`);
    console.error(`处理方法：${item.nextAction}`);
  }
  process.exitCode = 1;
}

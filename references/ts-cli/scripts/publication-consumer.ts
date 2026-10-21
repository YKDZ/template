import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const consumerRoot = process.env.NPM_PUBLICATION_CONSUMER_ROOT;
const packageName = process.env.NPM_PUBLICATION_PACKAGE_NAME;
if (consumerRoot === undefined || packageName === undefined) {
  throw new Error("缺少共享制品消费验收提供的安装目录或目标包名。");
}

const installedPackageRoot = path.join(
  consumerRoot,
  "node_modules",
  packageName,
);
const installedManifest = JSON.parse(
  readFileSync(path.join(installedPackageRoot, "package.json"), "utf8"),
) as {
  readonly bin?: string | Readonly<Record<string, string>>;
};
const bin =
  typeof installedManifest.bin === "string"
    ? installedManifest.bin
    : Object.values(installedManifest.bin ?? {})[0];
if (bin === undefined) {
  throw new Error(`${packageName} 没有可执行入口，不能完成 CLI 自有消费验收。`);
}

for (const argument of ["--help", "--version"]) {
  const result = spawnSync(
    process.execPath,
    [path.join(installedPackageRoot, bin), argument],
    { cwd: consumerRoot, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `已安装 ${packageName} ${argument} 失败：退出状态 ${String(result.status)}；${result.stderr || result.stdout || result.error?.message || "无诊断"}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(`已安装 ${packageName} ${argument} 没有输出。`);
  }
}

console.log(`已安装 ${packageName} 的命令行入口可正常消费。`);

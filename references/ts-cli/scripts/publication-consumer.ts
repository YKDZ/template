import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const journeyRunner = path.join(packageRoot, "test/e2e/run-journeys.ts");
const packed = spawnSync(
  process.execPath,
  [
    "--conditions=source",
    "--experimental-strip-types",
    journeyRunner,
    "packed",
    path.resolve(installedPackageRoot, bin),
  ],
  { cwd: packageRoot, encoding: "utf8" },
);
if (packed.error !== undefined || packed.status !== 0) {
  throw new Error(
    `已安装 ${packageName} 的 CLI 消费旅程失败：退出状态 ${String(packed.status)}；${packed.stderr || packed.stdout || packed.error?.message || "无诊断"}`,
  );
}

console.log(packed.stdout.trim());

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

type PackageManifest = {
  readonly name?: unknown;
  readonly bin?: unknown;
};

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const consumerRoot = process.env.NPM_PUBLICATION_CONSUMER_ROOT;
const packageName = process.env.NPM_PUBLICATION_PACKAGE_NAME;
if (consumerRoot === undefined || packageName === undefined) {
  throw new Error(
    "共享 npm 验收未传入隔离消费者目录或包名；请通过 publication:consume 正式入口运行。",
  );
}

const manifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
if (manifest.name !== packageName) {
  throw new Error(
    `消费目标包名与作者清单不一致：共享工具传入 ${packageName}，本包为 ${String(manifest.name)}。`,
  );
}

const executableName =
  typeof manifest.bin === "string"
    ? manifest.name.split("/").at(-1)
    : typeof manifest.bin === "object" && manifest.bin !== null
      ? Object.keys(manifest.bin)[0]
      : undefined;
if (executableName === undefined) {
  throw new Error(
    `CLI 自有消费验收需要 package.json 声明可执行入口：${path.join(packageRoot, "package.json")}#/bin`,
  );
}

const installedExecutable = path.join(
  consumerRoot,
  "node_modules",
  ".bin",
  executableName,
);
await execa("pnpm", ["run", "test:e2e:packed"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    TEMPLATE_CLI_JOURNEY_MODE: "packed",
    TEMPLATE_CLI_PACKED_BIN: installedExecutable,
  },
  stdio: "inherit",
});

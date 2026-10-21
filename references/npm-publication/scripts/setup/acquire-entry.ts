import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { acquirePublicationSetup } from "./acquire.ts";

const result = await acquirePublicationSetup();
const manifest = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly name?: unknown };
if (typeof manifest.name !== "string") {
  throw new Error("无法从发布共享工具清单读取实际包名。");
}
if (result.kind === "created") {
  console.log(`一次性发布向导已放入 ${result.directory}`);
} else if (result.kind === "restored-missing") {
  console.log(`已补回缺少的一次性发布文件：${result.directory}`);
} else {
  console.log(`一次性发布向导已存在，保留现有修改：${result.directory}`);
}

const setupPath = path.join(result.directory, "setup.ts");
const setupArguments = process.argv.slice(1);
if (setupArguments[0] === "--") setupArguments.shift();
const child = spawn(
  process.execPath,
  [
    "--conditions=source",
    "--experimental-strip-types",
    setupPath,
    ...setupArguments,
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, PUBLICATION_TOOL_NAME: manifest.name },
    stdio: "inherit",
    windowsHide: true,
  },
);
child.once("error", (error) => {
  throw new Error("无法启动已取得的一次性发布向导。", { cause: error });
});
child.once("close", (exitCode, signal) => {
  if (signal !== null) {
    throw new Error(`一次性发布向导被 ${signal} 中断。`);
  }
  process.exitCode = exitCode ?? 1;
});

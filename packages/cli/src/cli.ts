#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import type { CliRuntime } from "#main";

if (import.meta.url.endsWith(".ts")) {
  process.env.TEMPLATE_REPOSITORY_ROOT ??= path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
}

const require = createRequire(import.meta.url);
const runtime: CliRuntime = {
  argv: process.argv,
  // 把进程事实的读取留在 runCli 的故障出口内。
  get commandName() {
    const manifest = require("../package.json") as {
      bin: Record<string, string>;
    };
    const names = Object.keys(manifest.bin);
    if (names.length !== 1) throw new Error("CLI 包必须声明唯一命令。");
    return names[0]!;
  },
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  get cwd() {
    return process.cwd();
  },
  env: process.env,
  get version() {
    return (require("../package.json") as { version: string }).version;
  },
};

const { runCli } = await import("#main");
process.exitCode = await runCli(runtime);

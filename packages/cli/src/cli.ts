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
const packageManifest = require("../package.json") as {
  version: string;
  bin: Record<string, string>;
};
const commandNames = Object.keys(packageManifest.bin);
if (commandNames.length !== 1) throw new Error("CLI 包必须声明唯一命令。");

const runtime: CliRuntime = {
  argv: process.argv,
  commandName: commandNames[0]!,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  cwd: process.cwd(),
  env: process.env,
  version: packageManifest.version,
};

const { runCli } = await import("#main");
process.exitCode = await runCli(runtime);

#!/usr/bin/env node
import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { runCli } from "./main.ts";
import { cliCommandIdentity } from "./publication/cli-command-identity.ts";

const require = createRequire(import.meta.url);
process.exitCode = await runCli({
  argv: process.argv,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  // 身份读取和校验也使用 runCli 的意外故障出口。
  get identity() {
    return cliCommandIdentity(require("../package.json"));
  },
});

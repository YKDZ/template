#!/usr/bin/env node
import { createRequire } from "node:module";

import { cliCommandIdentity } from "./cli-command-identity.ts";
import { runCli, type CliRuntime } from "./main.ts";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as unknown;

const runtime: CliRuntime = {
  argv: process.argv,
  streams: {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  cwd: process.cwd(),
  env: process.env,
  tty: {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    stderr: Boolean(process.stderr.isTTY),
  },
  identity: cliCommandIdentity(packageManifest),
};

process.exitCode = await runCli(runtime);

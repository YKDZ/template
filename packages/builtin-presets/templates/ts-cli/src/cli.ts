#!/usr/bin/env node
import { createRequire } from "node:module";

import { runCli, type CliRuntime } from "#main";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as { version: string };

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
  version: packageManifest.version,
};

process.exitCode = await runCli(runtime);

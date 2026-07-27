#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { CliRuntime } from "#main";

if (import.meta.url.endsWith(".ts")) {
  process.env.TEMPLATE_REPOSITORY_ROOT ??= path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
}

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
  confirmation: {
    async confirm(request) {
      process.stdout.write(`${request.message}\n`);
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await readline.question(request.prompt);
        return ["y", "yes"].includes(answer.trim().toLowerCase());
      } finally {
        readline.close();
      }
    },
  },
};

const { runCli } = await import("#main");
process.exitCode = await runCli(runtime);

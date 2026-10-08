#!/usr/bin/env node
import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { cliCommandIdentity } from "./cli-command-identity.ts";
import { runCli } from "./main.ts";

const packageManifest = createRequire(import.meta.url)(
  "../package.json",
) as unknown;
process.exitCode = await runCli({
  argv: process.argv,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  identity: cliCommandIdentity(packageManifest),
});

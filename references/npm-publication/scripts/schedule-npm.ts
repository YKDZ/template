import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import {
  readAcceptedPublicationArtifacts,
  validateRemotePublicationTargets,
} from "./accepted-artifacts.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const artifacts = await readAcceptedPublicationArtifacts({
  repositoryRoot,
  environment: process.env,
});
await validateRemotePublicationTargets(artifacts, "publication:remote:npm");
const filters = artifacts.flatMap((artifact) => [
  "--filter",
  artifact.packageName,
]);
const child = spawn(
  "pnpm",
  [
    "--recursive",
    "--sort",
    "--no-bail",
    ...filters,
    "run",
    "publication:remote:npm",
  ],
  { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
);
try {
  const [exitCode] = await once(child, "close");
  process.exitCode = typeof exitCode === "number" ? exitCode : 1;
} catch (error) {
  throw new Error("无法启动 pnpm npm 发布调度。", { cause: error });
}

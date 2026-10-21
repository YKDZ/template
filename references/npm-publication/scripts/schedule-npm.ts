import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import {
  readAcceptedPublicationArtifacts,
  validateRemotePublicationTargets,
} from "./accepted-artifacts.ts";
import {
  runWithInteractiveNpmSession,
  type InteractiveNpmSessionSetActiveChild,
} from "./publish.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const credentialMode = process.env.PUBLICATION_CREDENTIAL_MODE;
if (
  credentialMode !== undefined &&
  credentialMode !== "oidc" &&
  credentialMode !== "interactive"
) {
  throw new Error("PUBLICATION_CREDENTIAL_MODE 只接受 oidc 或 interactive。");
}
if (credentialMode === "interactive" && process.env.GITHUB_ACTIONS === "true") {
  throw new Error("GitHub Actions 发布必须使用 OIDC 凭据。");
}
const artifacts = await readAcceptedPublicationArtifacts({
  repositoryRoot,
  environment: process.env,
});
await validateRemotePublicationTargets(artifacts, "publication:remote:npm");
const filters = artifacts.flatMap((artifact) => [
  "--filter",
  artifact.packageName,
]);
async function runNpmScheduler(
  environment: NodeJS.ProcessEnv,
  setActiveChild: InteractiveNpmSessionSetActiveChild,
): Promise<number> {
  const arguments_ = [
    "--recursive",
    "--sort",
    "--no-bail",
    ...(credentialMode === "interactive" ? ["--workspace-concurrency=1"] : []),
    ...filters,
    "run",
    "publication:remote:npm",
  ];
  const detachedSession =
    credentialMode === "interactive" && process.platform !== "win32";
  const child = spawn("pnpm", arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    ...(detachedSession ? { detached: true } : {}),
  });
  setActiveChild(child, detachedSession);
  try {
    const [exitCode] = await once(child, "close");
    return typeof exitCode === "number" ? exitCode : 1;
  } catch (error) {
    throw new Error("无法启动 pnpm npm 发布调度。", { cause: error });
  } finally {
    setActiveChild(undefined);
  }
}

process.exitCode =
  credentialMode === "interactive"
    ? await runWithInteractiveNpmSession({
        repositoryRoot,
        environment: process.env,
        runNpmPhase: runNpmScheduler,
      })
    : await runNpmScheduler(process.env, () => {});

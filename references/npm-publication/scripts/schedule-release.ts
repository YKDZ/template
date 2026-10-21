import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  readAcceptedPublicationArtifacts,
  validateAcceptedPublicationArtifacts,
} from "./accepted-artifacts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const artifacts = await readAcceptedPublicationArtifacts({
  repositoryRoot,
  environment: process.env,
});
const ready = [];
for (const artifact of artifacts) {
  const receipt = JSON.parse(await readFile(artifact.receiptPath, "utf8"));
  const attempt = isRecord(receipt) ? receipt.npmPublicationAttempt : undefined;
  if (!isRecord(attempt)) continue;
  if (attempt.artifactSha512 !== artifact.sha512) {
    throw new Error(
      `原件回执中的 npm 上传原件与当前 tgz 不一致：${artifact.packageName}`,
    );
  }
  if (attempt.ready === true) ready.push(artifact);
}
if (ready.length === 0) {
  process.stdout.write("没有 npm 已就绪的目标需要创建 GitHub Release。\n");
} else {
  await validateAcceptedPublicationArtifacts(ready);
  const filters = ready.flatMap((artifact) => [
    "--filter",
    artifact.packageName,
  ]);
  const child = spawn(
    "pnpm",
    [
      "--recursive",
      "--parallel",
      "--no-bail",
      ...filters,
      "run",
      "publication:remote:release",
    ],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  try {
    const [exitCode] = await once(child, "close");
    process.exitCode = typeof exitCode === "number" ? exitCode : 1;
  } catch (error) {
    throw new Error("无法启动 pnpm GitHub Release 调度。", { cause: error });
  }
}

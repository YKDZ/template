import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const workerPidFile = process.env.TEMPLATE_ROOT_TEST_WORKER_PID_FILE;
if (workerPidFile !== undefined) {
  mkdirSync(path.dirname(workerPidFile), { recursive: true });
  writeFileSync(workerPidFile, `${process.pid}\n`);
}

type AcceptedArtifact = {
  readonly artifactPath: string;
  readonly packageName: string;
  readonly artifactVersion: string;
  readonly sha512: string;
};

const outputDirectory = process.env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
const stdout: string[] = [];
const child = spawn(
  "pnpm",
  ["--filter=@ykdz/template", "run", "publication:accept"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  stdout.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
  process.stderr.write(chunk);
});

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => {
    resolve(code ?? (signal === "SIGINT" ? 130 : 1));
  });
});
if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const reportLine = `${stdout.join("")}\n`
    .split(/\r?\n/u)
    .find((line) => line.startsWith("NPM_PUBLICATION_ACCEPTED_JSON:"));
  if (reportLine === undefined) {
    throw new Error("CLI 正式消费接口未返回原件身份回执。");
  }
  const accepted = JSON.parse(
    reportLine.slice("NPM_PUBLICATION_ACCEPTED_JSON:".length),
  ) as AcceptedArtifact;
  if (outputDirectory !== undefined && outputDirectory.length > 0) {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    const archiveName = path.basename(accepted.artifactPath);
    const outputArchive = path.join(outputDirectory, archiveName);
    await cp(accepted.artifactPath, outputArchive);
    const digest = createHash("sha512")
      .update(await readFile(outputArchive))
      .digest("hex");
    if (digest !== accepted.sha512) {
      throw new Error(
        `验收后保留的 CLI 原件字节身份不一致：${accepted.sha512} != ${digest}`,
      );
    }
    await writeFile(
      path.join(outputDirectory, "SHA512SUMS"),
      `${digest}  ${archiveName}\n`,
    );
  }
  console.log(
    `根任务消费同一正式原件：${accepted.packageName}@${accepted.artifactVersion}`,
  );
  console.log(`原件：${accepted.artifactPath}`);
  console.log(`SHA512：${accepted.sha512}`);
}

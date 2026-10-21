import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
  readonly receiptPath: string;
};

const outputDirectory =
  process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
  process.env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
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
    const directory = path.resolve(outputDirectory);
    if (
      path.dirname(path.resolve(accepted.artifactPath)) !== directory ||
      path.resolve(accepted.receiptPath) !==
        path.join(directory, "publication-preparation.json")
    ) {
      throw new Error(
        "CLI 正式验收未使用指定目录中的共享原件与同一份 receipt。",
      );
    }
  }
  console.log(
    `根任务消费同一正式原件：${accepted.packageName}@${accepted.artifactVersion}`,
  );
  console.log(`原件：${accepted.artifactPath}`);
  console.log(`SHA512：${accepted.sha512}`);
}

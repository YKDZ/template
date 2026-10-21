import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareArtifact,
  type PackAdapter,
  type PublicationExecution,
} from "@ykdz/reference-npm-publication";
import { execa } from "execa";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.resolve(
  process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
    path.join(packageRoot, "node_modules/.cache/npm-publication"),
);
const temporaryOutput =
  process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY === undefined;

if (temporaryOutput) {
  await rm(outputDirectory, { recursive: true, force: true });
}

const pack: PackAdapter = async ({ outputDirectory: destination, env }) => {
  const arguments_ = [
    "--conditions=source",
    "--experimental-strip-types",
    fileURLToPath(new URL("./pack-bundled.ts", import.meta.url)),
    "--pack-destination",
    destination,
  ];
  const packed = await execa(process.execPath, arguments_, {
    cwd: packageRoot,
    env,
    reject: false,
  });
  if (packed.exitCode !== 0) {
    throw new Error(
      `CLI 内容闭包打包失败，退出状态 ${String(packed.exitCode)}。\n${packed.stderr || packed.stdout}`,
    );
  }

  const archives = (await readdir(destination)).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (archives.length !== 1) {
    throw new Error(
      `CLI 内容封装应生成一个原始 tgz，实际为 ${archives.length} 个：${archives.join("、")}`,
    );
  }

  const execution: PublicationExecution = {
    command: process.execPath,
    arguments: arguments_,
    stdout: packed.stdout,
    stderr: packed.stderr,
  };
  return {
    artifactPath: path.join(destination, archives[0]!),
    execution,
  };
};

const result = await prepareArtifact({
  packageRoot,
  outputDirectory,
  pack,
});

if (result.kind === "blocked") {
  console.error("npm 发布目标尚未配置：");
  for (const blocker of result.inspection.blockers) {
    console.error(`问题：${blocker.code}`);
    console.error(`目标：${blocker.target}${blocker.field}`);
    console.error(`观察到：${blocker.observed}`);
    console.error(`需要：${blocker.expected}`);
    console.error(`处理方法：${blocker.nextAction}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `npm 原始制品已准备：${result.packageName}@${result.packageVersion}`,
  );
  console.log(`路径：${result.artifactPath}`);
  console.log(`SHA512：${result.sha512}`);
  console.log("构建：Turbo publication:prepare 依赖的 CLI build");
  console.log("打包次数：1");
}

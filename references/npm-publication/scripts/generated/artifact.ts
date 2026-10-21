import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  acceptPreparedArtifacts,
  type PreparedArtifactBatchTarget,
} from "../publication.ts";
import { publicationTarget } from "./target.ts";

const execFileAsync = promisify(execFile);

type WorkspaceProject = {
  readonly name: string;
  readonly path: string;
};

type WorkspaceManifest = {
  readonly name?: unknown;
};

function publicationFilters(arguments_: readonly string[]): string[] {
  const filters: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") continue;
    if (argument === "--filter" || argument === "-F") {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(
          "publication:artifact 的 --filter 必须提供 pnpm 选择器。",
        );
      }
      filters.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--filter=")) {
      const value = argument.slice("--filter=".length);
      if (value.length === 0) {
        throw new Error(
          "publication:artifact 的 --filter 必须提供 pnpm 选择器。",
        );
      }
      filters.push(value);
      continue;
    }
    throw new Error(
      `publication:artifact 只接收 pnpm 原生 --filter 选择器；无法识别参数 ${argument}。`,
    );
  }
  return filters;
}

function environmentFilters(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(/\r?\n/u)
    .map((filter) => filter.trim())
    .filter((filter) => filter.length > 0);
}

async function pnpm(
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFileAsync("pnpm", [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const record =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : {};
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    throw new Error(
      `pnpm ${arguments_.join(" ")} 失败，退出状态 ${String(record.code)}。\n${stderr || stdout}`,
      { cause: error },
    );
  }
}

function workspaceSelector(workspaceRoot: string, packageRoot: string): string {
  const relative = path.relative(workspaceRoot, packageRoot);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`pnpm 选择目标不在当前工作区：${packageRoot}`);
  }
  return relative.length === 0
    ? "."
    : `./${relative.split(path.sep).join("/")}`;
}

function relativePathInside(
  root: string,
  target: string,
  allowRoot = false,
): string {
  const relative = path.relative(root, target);
  if (
    (relative.length === 0 && !allowRoot) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`发布制品路径不在其归档目录内：${target}`);
  }
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

async function defaultFilter(workspaceRoot: string): Promise<string> {
  const configured = await publicationTarget();
  const manifest = JSON.parse(
    await readFile(path.join(configured.packageRoot, "package.json"), "utf8"),
  ) as WorkspaceManifest;
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(
      `默认 npm 发布目标缺少包名：${path.join(configured.packageRoot, "package.json")}`,
    );
  }
  return workspaceSelector(workspaceRoot, configured.packageRoot);
}

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(process.cwd());
  const argumentOffset = process.execArgv.includes("--eval") ? 1 : 2;
  const filters = [
    ...publicationFilters(process.argv.slice(argumentOffset)),
    ...environmentFilters(process.env.PUBLICATION_TARGET_FILTERS),
  ];
  const selectors =
    filters.length > 0 ? filters : [await defaultFilter(workspaceRoot)];
  const filterArguments = selectors.flatMap((filter) => ["--filter", filter]);
  const env = { ...process.env };
  const selection = await pnpm(
    [
      "--recursive",
      "--workspace-concurrency=1",
      "--include-workspace-root",
      "--fail-if-no-match",
      ...filterArguments,
      "--sort",
      "exec",
      "node",
      "-e",
      'const manifest = require("node:fs").readFileSync("package.json", "utf8"); const project = JSON.parse(manifest); console.log(JSON.stringify({ name: project.name, path: process.cwd() }));',
    ],
    { cwd: workspaceRoot, env },
  );
  const projects = selection.stdout.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith("{") || !line.endsWith("}")) return [];
    const project = JSON.parse(line) as WorkspaceProject;
    return typeof project.name === "string" && typeof project.path === "string"
      ? [project]
      : [];
  });
  if (projects.length === 0) {
    throw new Error("pnpm 原生选择没有返回任何 npm 发布目标。");
  }

  const outputRoot =
    process.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY ??
    process.env.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
  const artifactOutputRoot =
    outputRoot === undefined
      ? undefined
      : path.resolve(workspaceRoot, outputRoot);
  const prepareEnv = {
    ...env,
    PUBLICATION_BATCH_TARGET_COUNT: String(projects.length),
    NPM_PUBLICATION_PREBUILT_TARGETS: JSON.stringify(
      projects.map((project) => project.name),
    ),
    ...(artifactOutputRoot === undefined
      ? {}
      : {
          PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: artifactOutputRoot,
        }),
  };
  const preparedTargets: PreparedArtifactBatchTarget[] = [];
  const prepared = await pnpm(
    [
      "exec",
      "turbo",
      "run",
      "publication:prepare",
      ...projects.flatMap((project) => ["--filter", project.name]),
      "--output-logs=full",
    ],
    { cwd: workspaceRoot, env: prepareEnv },
  );
  process.stdout.write(prepared.stdout);
  process.stderr.write(prepared.stderr);

  for (const project of projects) {
    process.chdir(project.path);
    try {
      const target = await publicationTarget(prepareEnv);
      preparedTargets.push({
        packageRoot: target.packageRoot,
        artifactDirectory: target.outputDirectory,
      });
    } finally {
      process.chdir(workspaceRoot);
    }
  }

  const accepted = await acceptPreparedArtifacts({
    targets: preparedTargets,
    env,
  });
  if (accepted.kind === "blocked") {
    console.error("npm 制品整批消费验收未执行：目标配置不完整。");
    for (const item of accepted.inspection.blockers) {
      console.error(`${item.target}${item.field}：${item.observed}`);
      console.error(`需要：${item.expected}`);
      console.error(`处理方法：${item.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  const artifacts = accepted.artifacts.map((artifact) => {
    if (artifact.receiptPath === undefined) {
      throw new Error(
        `整批验收缺少原件回执路径：${artifact.packageName}@${artifact.artifactVersion}`,
      );
    }
    return {
      packageRoot: artifact.packageRoot,
      packageName: artifact.packageName,
      artifactVersion: artifact.artifactVersion,
      artifactPath: artifact.artifactPath,
      receiptPath: artifact.receiptPath,
      sha512: artifact.sha512,
    };
  });
  if (artifactOutputRoot !== undefined) {
    const portableArtifacts = artifacts.map((artifact) => ({
      ...artifact,
      packageRoot: relativePathInside(
        workspaceRoot,
        artifact.packageRoot,
        true,
      ),
      artifactPath: relativePathInside(
        artifactOutputRoot,
        artifact.artifactPath,
      ),
      receiptPath: relativePathInside(artifactOutputRoot, artifact.receiptPath),
    }));
    const acceptedListPath = path.join(
      artifactOutputRoot,
      "publication-accepted-artifacts.json",
    );
    const temporaryPath = `${acceptedListPath}.${process.pid}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ artifacts: portableArtifacts }, null, 2)}\n`,
      );
      await rename(temporaryPath, acceptedListPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  console.log(`npm 制品整批本地验收通过：${artifacts.length} 个目标`);
  console.log(`NPM_PUBLICATION_ACCEPTED_JSON:${JSON.stringify({ artifacts })}`);
}

await main();

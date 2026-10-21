import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDevelopmentContainerFixtureSession,
  type FixtureCommandRunner,
} from "@ykdz/template-checks/development-container-session";
import { execa } from "execa";

import { repositoryDevelopmentEnvironment } from "./repository-environment.ts";
import { readTemplateToolchainDeclarations } from "./template-toolchain-declarations.ts";

const localContextNames = new Set([
  "AGENTS.md",
  ".agents",
  "docs",
  ".scratch",
  ".codex",
  ".git",
]);
const runtimeDirectoryNames = new Set([
  "node_modules",
  "dist",
  "template-dist",
  "target",
  "coverage",
  ".turbo",
  ".pnpm-store",
  ".template",
  ".fixture-evidence",
  ".fixture-evidence-activity",
  ".fixture-native-cache",
  ".fixture-workspace",
  ".verified-packed-publication",
]);

function commandOutput(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
  )
    return result.stdout;
  throw new Error("源码容器验收命令没有返回 stdout");
}

async function dockerWorkspaceSource(
  projectDir: string,
  run: FixtureCommandRunner,
  cancelSignal: AbortSignal,
): Promise<string> {
  if (!existsSync("/.dockerenv")) return projectDir;
  const mounts = JSON.parse(
    commandOutput(
      await run(
        "docker",
        ["inspect", hostname(), "--format", "{{json .Mounts}}"],
        { cwd: projectDir, cancelSignal },
      ),
    ),
  ) as {
    readonly Type: string;
    readonly Source: string;
    readonly Destination: string;
  }[];
  const mount = mounts
    .filter(
      ({ Type, Destination }) =>
        Type === "bind" &&
        (projectDir === Destination ||
          projectDir.startsWith(`${Destination}/`)),
    )
    .sort(
      (left, right) => right.Destination.length - left.Destination.length,
    )[0];
  if (mount === undefined)
    throw new Error(
      `无法从当前容器的实际 bind mount 确定一次性工作区 ${projectDir} 的 Docker 宿主路径`,
    );
  return path.join(mount.Source, path.relative(mount.Destination, projectDir));
}

export async function checkRepositoryDevelopmentContainer(
  options: {
    readonly repositoryRoot?: string;
    readonly run?: FixtureCommandRunner;
    readonly cancelSignal?: AbortSignal;
  } = {},
): Promise<void> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const cancelSignal =
    options.cancelSignal ?? AbortSignal.timeout(60 * 60 * 1_000);
  const run: FixtureCommandRunner =
    options.run ??
    ((command, args, commandOptions) =>
      execa(command, [...args], {
        timeout: 60 * 60 * 1_000,
        ...commandOptions,
      }));
  const temporaryRoot = path.join(
    repositoryRoot,
    ".fixture-workspace",
    "repository-development-container",
  );
  await mkdir(temporaryRoot, { recursive: true });
  const projectDir = await mkdtemp(path.join(temporaryRoot, "source-"));
  let preserveWorkspace = false;
  try {
    const files = commandOutput(
      await run(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: repositoryRoot, cancelSignal },
      ),
    )
      .split("\0")
      .filter(Boolean);
    for (const file of new Set(files)) {
      cancelSignal.throwIfAborted();
      const segments = file.split("/");
      if (
        localContextNames.has(segments[0]!) ||
        /^GLOSSARY.*\.md$/u.test(segments[0]!) ||
        segments.some((segment) => runtimeDirectoryNames.has(segment))
      )
        continue;
      const destination = path.join(projectDir, file);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await cp(path.join(repositoryRoot, file), destination, {
          verbatimSymlinks: true,
        });
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    await run("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: projectDir,
      cancelSignal,
    });
    await run("git", ["add", "--all"], { cwd: projectDir, cancelSignal });
    await run(
      "git",
      [
        "-c",
        "user.name=Template container check",
        "-c",
        "user.email=template-container-check@localhost",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "当前源码容器验收快照",
      ],
      { cwd: projectDir, cancelSignal },
    );
    const environment = await repositoryDevelopmentEnvironment(
      await readTemplateToolchainDeclarations(projectDir),
    );
    const hostSource = await dockerWorkspaceSource(
      projectDir,
      run,
      cancelSignal,
    );
    if (hostSource.includes(","))
      throw new Error(
        `Docker bind mount 的源码路径不能包含逗号：${hostSource}`,
      );
    const session = createDevelopmentContainerFixtureSession({
      projectDir,
      probes: environment.probes,
      dependencyPreparation: "existing-lockfile",
      ownedVolumePrefix: `template-repository-check-${path.basename(projectDir)}`,
      workspaceMount: {
        source: hostSource,
        target: `/workspaces/${path.basename(projectDir)}`,
      },
      cancelSignal,
      environment: process.env,
      run,
    });
    await session.execute(async (execute) => {
      await execute("pnpm", ["run", "check"], {
        cwd: projectDir,
        stdio: "inherit",
      });
      await execute(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "test:browser",
          "@ykdz/reference-vue-app#test:e2e",
          "@ykdz/reference-vike-web#test:e2e",
          "@ykdz/preset-vue-hono-app#test:e2e",
          "--output-logs=errors-only",
        ],
        { cwd: projectDir, stdio: "inherit" },
      );
    });
  } catch (error) {
    preserveWorkspace = true;
    throw error;
  } finally {
    if (preserveWorkspace)
      console.error(`源码开发容器验收未完成，保留诊断工作区：${projectDir}`);
    else await rm(projectDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const controller = new AbortController();
  let exitCode = 1;
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`源码开发容器验收收到 ${signal}`));
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await checkRepositoryDevelopmentContainer({
      cancelSignal: controller.signal,
    });
  } catch (error) {
    console.error(error);
    process.exitCode = exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

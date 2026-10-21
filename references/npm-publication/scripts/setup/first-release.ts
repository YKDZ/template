import { spawn } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const artifactRelativePath = ".verified-packed-publication/first-release";
const acceptedListName = "publication-accepted-artifacts.json";

type AcceptedPublicationArtifact = {
  readonly packageRoot: string;
  readonly packageName: string;
  readonly artifactVersion: string;
  readonly artifactPath: string;
  readonly receiptPath: string;
  readonly sha512: string;
};

type RemoteCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RemoteCommandRunner = (
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<RemoteCommandResult>;

type PublicationOwnerApi = {
  readonly readAcceptedPublicationArtifacts: (options: {
    readonly repositoryRoot: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }) => Promise<readonly AcceptedPublicationArtifact[]>;
  readonly assertRemotePreparation: (options: {
    readonly repositoryRoot: string;
    readonly sourceSha: string;
    readonly defaultBranch: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly run: RemoteCommandRunner;
  }) => Promise<void>;
  readonly defaultRemoteCommand: RemoteCommandRunner;
  readonly isValidPublicationDistTag: (value: string) => Promise<boolean>;
};

async function publicationOwnerApi(
  environment: NodeJS.ProcessEnv,
): Promise<PublicationOwnerApi> {
  const toolName =
    environment.PUBLICATION_TOOL_NAME ?? "@ykdz/reference-npm-publication";
  const [accepted, remote, publish] = await Promise.all([
    import(`${toolName}/accepted-artifacts`),
    import(`${toolName}/remote-context`),
    import(`${toolName}/publish`),
  ]);
  return {
    ...(accepted as unknown as Pick<
      PublicationOwnerApi,
      "readAcceptedPublicationArtifacts"
    >),
    ...(remote as unknown as Pick<
      PublicationOwnerApi,
      "assertRemotePreparation" | "defaultRemoteCommand"
    >),
    ...(publish as unknown as Pick<
      PublicationOwnerApi,
      "isValidPublicationDistTag"
    >),
  };
}

export type FirstReleaseCommandRunner = (
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<number>;

export type FirstReleasePrompt = (message: string) => Promise<string>;

export type FirstReleaseOptions = {
  readonly repositoryRoot?: string;
  readonly arguments_?: readonly string[];
  readonly run?: RemoteCommandRunner;
  readonly runCommand?: FirstReleaseCommandRunner;
  readonly prompt?: FirstReleasePrompt;
  readonly write?: (message: string) => void;
};

function parseFilters(arguments_: readonly string[]): string[] {
  const filters: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--filter" || argument === "-F") {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("每个 --filter 都必须提供 pnpm 原生选择器。");
      }
      filters.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--filter=")) {
      const value = argument.slice("--filter=".length);
      if (value.length === 0) throw new Error("--filter 选择器不能为空。");
      filters.push(value);
      continue;
    }
    throw new Error(`首次发布只接收 pnpm 原生 --filter 选择器：${argument}`);
  }
  return filters;
}

async function spawnCommand(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) reject(new Error(`${command} 被 ${signal} 中断。`));
      else resolve(code ?? 1);
    });
  });
}

async function promptOnce(message: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("首次发布需要本地交互终端；没有执行任何外部写入。");
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return await terminal.question(message);
  } finally {
    terminal.close();
  }
}

async function checkedGit(options: {
  readonly run: RemoteCommandRunner;
  readonly repositoryRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly arguments_: readonly string[];
}): Promise<string> {
  const result = await options.run("git", options.arguments_, {
    cwd: options.repositoryRoot,
    env: options.environment,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${options.arguments_.join(" ")} 执行失败。`);
  }
  return result.stdout.trim();
}

async function sourceCommit(options: {
  readonly run: RemoteCommandRunner;
  readonly repositoryRoot: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<{ readonly sourceSha: string; readonly defaultBranch: string }> {
  const sourceSha = await checkedGit({
    ...options,
    arguments_: ["rev-parse", "HEAD"],
  });
  const defaultRef = await checkedGit({
    ...options,
    arguments_: ["ls-remote", "--symref", "origin", "HEAD"],
  });
  const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(defaultRef);
  const defaultBranch = match?.[1];
  if (!/^[0-9a-f]{40}$/u.test(sourceSha) || defaultBranch === undefined) {
    throw new Error("无法确定当前提交及公共 origin 的默认分支。");
  }
  return { sourceSha, defaultBranch };
}

function isPrerelease(version: string): boolean {
  return version.split("+", 1)[0]!.includes("-");
}

async function releaseTags(options: {
  readonly artifacts: readonly AcceptedPublicationArtifact[];
  readonly prompt: FirstReleasePrompt;
  readonly isValidPublicationDistTag: PublicationOwnerApi["isValidPublicationDistTag"];
}): Promise<Map<string, string>> {
  const tags = new Map<string, string>();
  for (const artifact of options.artifacts) {
    if (!isPrerelease(artifact.artifactVersion)) continue;
    const message = `${artifact.packageName}@${artifact.artifactVersion} 的 npm dist-tag（不可用 latest）：`;
    const tag = (await options.prompt(message)).trim();
    if (!(await options.isValidPublicationDistTag(tag))) {
      throw new Error(
        `预发布目标必须选择有效的非 latest dist-tag：${artifact.packageName}`,
      );
    }
    tags.set(artifact.packageName, tag);
  }
  return tags;
}

async function existingArtifacts(options: {
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly acceptedListPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly readAcceptedPublicationArtifacts: PublicationOwnerApi["readAcceptedPublicationArtifacts"];
}): Promise<readonly AcceptedPublicationArtifact[] | undefined> {
  try {
    await lstat(options.acceptedListPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let entries: string[];
    try {
      entries = await readdir(options.artifactRoot);
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw directoryError;
    }
    if (entries.length > 0) {
      throw new Error(
        `首发目录含未验收原件但没有 accepted 清单：${options.artifactRoot}。请先人工核实，不能重新打包替代。`,
      );
    }
    return undefined;
  }
  return await options.readAcceptedPublicationArtifacts({
    repositoryRoot: options.repositoryRoot,
    environment: {
      ...options.environment,
      PUBLICATION_ACCEPTED_ARTIFACTS_FILE: options.acceptedListPath,
    },
  });
}

async function prepareArtifacts(options: {
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly acceptedListPath: string;
  readonly filters: readonly string[];
  readonly sourceSha: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runCommand: FirstReleaseCommandRunner;
  readonly readAcceptedPublicationArtifacts: PublicationOwnerApi["readAcceptedPublicationArtifacts"];
}): Promise<readonly AcceptedPublicationArtifact[]> {
  await mkdir(options.artifactRoot, { recursive: true });
  const environment = { ...options.environment };
  delete environment.PUBLICATION_TARGET_FILTERS;
  delete environment.PUBLICATION_ACCEPTED_ARTIFACTS_FILE;
  delete environment.TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR;
  environment.PUBLICATION_SOURCE_SHA = options.sourceSha;
  environment.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY = options.artifactRoot;
  const arguments_ = options.filters.flatMap((filter) => ["--filter", filter]);
  const exitCode = await options.runCommand(
    "pnpm",
    ["run", "publication:artifact", "--", ...arguments_],
    { cwd: options.repositoryRoot, env: environment },
  );
  if (exitCode !== 0) {
    throw new Error(
      `npm 原件整批验收失败，退出状态 ${exitCode}；未执行外部写入。失败后请核实保留目录，不要自动重打包。`,
    );
  }
  return await options.readAcceptedPublicationArtifacts({
    repositoryRoot: options.repositoryRoot,
    environment: {
      ...environment,
      PUBLICATION_ACCEPTED_ARTIFACTS_FILE: options.acceptedListPath,
    },
  });
}

/** 显式运行的一次性首发向导；长期发布由持久发布拥有者负责。 */
export async function runPublicationSetup(
  options: FirstReleaseOptions = {},
): Promise<void> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const arguments_ =
    options.arguments_ ??
    process.argv.slice(process.execArgv.includes("--eval") ? 1 : 2);
  const filters = parseFilters(arguments_);
  const write = options.write ?? ((message: string) => console.log(message));
  const owner = await publicationOwnerApi(process.env);
  const run = options.run ?? owner.defaultRemoteCommand;
  const runCommand = options.runCommand ?? spawnCommand;
  const prompt = options.prompt ?? promptOnce;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (environment.GITHUB_ACTIONS === "true") {
    throw new Error(
      "首次交互发布只能在本地终端运行，不能从 GitHub Actions 启动。",
    );
  }
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "PUBLICATION_DIST_TAG",
    "PUBLICATION_DIST_TAGS",
  ]) {
    delete environment[key];
  }

  const artifactRoot = path.join(repositoryRoot, artifactRelativePath);
  const acceptedListPath = path.join(artifactRoot, acceptedListName);
  let artifacts = await existingArtifacts({
    repositoryRoot,
    artifactRoot,
    acceptedListPath,
    environment,
    readAcceptedPublicationArtifacts: owner.readAcceptedPublicationArtifacts,
  });
  if (artifacts === undefined) {
    if (filters.length === 0) {
      write(
        "一次性向导已就绪。首次验收并发布时，请传入一个或多个 pnpm 原生选择器：pnpm run publication:setup -- --filter <包名>。",
      );
      return;
    }
    const { sourceSha, defaultBranch } = await sourceCommit({
      run,
      repositoryRoot,
      environment,
    });
    await owner.assertRemotePreparation({
      repositoryRoot,
      sourceSha,
      defaultBranch,
      environment,
      run,
    });
    artifacts = await prepareArtifacts({
      repositoryRoot,
      artifactRoot,
      acceptedListPath,
      filters,
      sourceSha,
      environment,
      runCommand,
      readAcceptedPublicationArtifacts: owner.readAcceptedPublicationArtifacts,
    });
  } else if (filters.length > 0) {
    throw new Error(
      `已有首发 accepted 清单；请不带 --filter 重跑，以续办同一原件：${acceptedListPath}`,
    );
  }

  const tags = await releaseTags({
    artifacts,
    prompt,
    isValidPublicationDistTag: owner.isValidPublicationDistTag,
  });
  write("即将使用以下已验收原件进行外部发布：");
  for (const artifact of artifacts) {
    write(
      `- ${artifact.packageName}@${artifact.artifactVersion}  SHA-512 ${artifact.sha512}`,
    );
  }
  write("将按原生依赖顺序处理 npm，并为 npm 已就绪的目标创建 GitHub Release。");
  const confirmation = (await prompt("确认继续？输入 yes：")).trim();
  if (confirmation !== "yes") {
    write(`未执行外部写入；原件保留在 ${artifactRoot}`);
    return;
  }

  const publicationEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PUBLICATION_ACCEPTED_ARTIFACTS_FILE: acceptedListPath,
    PUBLICATION_REPOSITORY_ROOT: repositoryRoot,
    PUBLICATION_CREDENTIAL_MODE: "interactive",
    ...(tags.size === 0
      ? {}
      : { PUBLICATION_DIST_TAGS: JSON.stringify(Object.fromEntries(tags)) }),
  };
  const runPhase = async (
    arguments_: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly error?: string }> => {
    try {
      return {
        exitCode: await runCommand("pnpm", arguments_, {
          cwd: repositoryRoot,
          env: publicationEnvironment,
        }),
      };
    } catch (error) {
      return {
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const npm = await runPhase(["run", "publication:remote:npm"]);
  const release = await runPhase(["run", "publication:remote:release"]);
  if (npm.exitCode !== 0 || release.exitCode !== 0) {
    const details = [
      `npm ${npm.exitCode}${npm.error === undefined ? "" : `：${npm.error}`}`,
      `GitHub Release ${release.exitCode}${release.error === undefined ? "" : `：${release.error}`}`,
    ].join("；");
    throw new Error(
      `首发未全部完成（${details}）。原 accepted 清单与 tgz 保留在 ${artifactRoot}；请核实远端状态后不带 --filter 重跑。`,
    );
  }
  write("所选目标的 npm 发布与 GitHub Release 均已完成。");
  write(`现在可删除 scripts/npm-publication-setup/ 与 ${artifactRoot}。`);
}

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  readAcceptedArtifact,
  type PublicationManifest,
} from "./publication.ts";

const execFileAsync = promisify(execFile);

export type RemoteProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RemoteCommandRunner = (
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<RemoteProcessResult>;

export type AcceptedRemoteArtifact = {
  readonly artifactPath: string;
  readonly artifactName: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactVersion: string;
  readonly sourceSha: string;
  readonly sha512: string;
  readonly integrity: string;
  readonly size: number;
  readonly packedManifest: PublicationManifest;
  readonly sourceManifest: PublicationManifest;
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly checksumContent: string;
  readonly receiptPath: string;
  readonly npmPublicationAttempt?: {
    readonly artifactSha512: string;
    readonly distTag: string;
    readonly workflowRunId?: string;
    readonly workflowRunAttempt?: number;
  };
  readonly releaseNotes: string;
};

export async function defaultRemoteCommand(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<RemoteProcessResult> {
  try {
    const result = await execFileAsync(command, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const record =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : undefined;
    return {
      exitCode: typeof record?.code === "number" ? record.code : 1,
      stdout: typeof record?.stdout === "string" ? record.stdout : "",
      stderr: typeof record?.stderr === "string" ? record.stderr : "",
    };
  }
}

/** 新的远端候选必须来自干净且与公共默认分支同步的原提交。 */
export async function assertRemotePreparation(options: {
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly defaultBranch: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly run?: RemoteCommandRunner;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  const run = options.run ?? defaultRemoteCommand;
  if (
    !/^[0-9a-f]{40}$/u.test(options.sourceSha) ||
    !/^[A-Za-z0-9._/-]+$/u.test(options.defaultBranch) ||
    options.defaultBranch.startsWith("/") ||
    options.defaultBranch.endsWith("/") ||
    options.defaultBranch.includes("..")
  ) {
    throw new Error("远端候选必须绑定有效的默认分支及完整 sourceSha。");
  }
  if (
    environment.GITHUB_ACTIONS === "true" &&
    (environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      environment.GITHUB_DEFAULT_BRANCH !== options.defaultBranch ||
      environment.GITHUB_REF !== `refs/heads/${options.defaultBranch}` ||
      environment.GITHUB_SHA !== options.sourceSha)
  ) {
    throw new Error("远端候选只能从默认分支 workflow_dispatch 原提交准备。");
  }

  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  const git = async (...arguments_: string[]): Promise<string> => {
    const result = await run("git", arguments_, {
      cwd: options.repositoryRoot,
      env,
    });
    if (result.exitCode !== 0) {
      throw new Error("无法确认远端候选的 Git 源提交事实。");
    }
    return result.stdout.trim();
  };
  if ((await git("status", "--porcelain", "--untracked-files=normal")) !== "") {
    throw new Error("新远端候选要求工作区干净。");
  }
  if ((await git("rev-parse", "HEAD")) !== options.sourceSha) {
    throw new Error("新远端候选必须由当前 sourceSha 打包。");
  }
  if (
    environment.GITHUB_ACTIONS !== "true" &&
    (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !==
      options.defaultBranch
  ) {
    throw new Error("新远端候选必须从本地默认分支准备。");
  }
  const remote = await git(
    "ls-remote",
    "origin",
    `refs/heads/${options.defaultBranch}`,
  );
  const remoteFields = remote.split(/\s+/u);
  if (
    remoteFields.length !== 2 ||
    remoteFields[0] !== options.sourceSha ||
    remoteFields[1] !== `refs/heads/${options.defaultBranch}`
  ) {
    throw new Error("新远端候选 sourceSha 未与公共默认分支同步。");
  }
}

function canonicalGithubRepository(value: unknown): string | undefined {
  try {
    if (typeof value !== "string") return undefined;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
      return `https://github.com/${value}`;
    }
    const candidate = value
      .replace(/^git\+/u, "")
      .replace(/^git@github\.com:/u, "https://github.com/");
    const url = new URL(candidate);
    const pathname = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pathname)
    ) {
      return undefined;
    }
    return `https://github.com/${pathname}`;
  } catch {
    return undefined;
  }
}

async function sourceFile(options: {
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly relativePath: string;
  readonly run: RemoteCommandRunner;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  if (options.environment.PATH !== undefined)
    env.PATH = options.environment.PATH;
  const result = await options.run(
    "git",
    ["show", `${options.sourceSha}:${options.relativePath}`],
    { cwd: options.repositoryRoot, env },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `无法从原提交 ${options.sourceSha} 读取 ${options.relativePath}。`,
    );
  }
  return result.stdout;
}

function packageRelativePath(
  repositoryRoot: string,
  packageRoot: string,
): string {
  const relative = path.relative(repositoryRoot, packageRoot);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("发布包路径必须位于 Git 仓库内。 ");
  }
  if (relative.length === 0) return "";
  return relative.split(path.sep).join("/");
}

/** 只从既有回执和 tgz 还原原件身份；Git 文件始终按 receipt.sourceSha 读取。 */
export async function readAcceptedRemoteArtifact(options: {
  readonly repositoryRoot: string;
  readonly packageRoot: string;
  readonly artifactDirectory: string;
  readonly githubRepository?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly run?: RemoteCommandRunner;
}): Promise<AcceptedRemoteArtifact> {
  const environment = options.environment ?? process.env;
  const run = options.run ?? defaultRemoteCommand;
  const accepted = await readAcceptedArtifact({
    packageRoot: options.packageRoot,
    artifactDirectory: options.artifactDirectory,
    preserveReceiptTarget: true,
  });
  if (accepted.kind !== "prepared") {
    throw new Error("共享发布目标尚未通过身份、版本和消费命令诊断。");
  }
  const sourceSha = accepted.receipt.sourceSha;
  if (sourceSha === undefined || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("原始制品回执未绑定完整 sourceSha，不能执行远端写入。");
  }

  const relativePackage = packageRelativePath(
    options.repositoryRoot,
    options.packageRoot,
  );
  const [manifestSource, changelog] = await Promise.all([
    sourceFile({
      repositoryRoot: options.repositoryRoot,
      sourceSha,
      relativePath:
        relativePackage.length === 0
          ? "package.json"
          : `${relativePackage}/package.json`,
      run,
      environment,
    }),
    sourceFile({
      repositoryRoot: options.repositoryRoot,
      sourceSha,
      relativePath:
        relativePackage.length === 0
          ? "CHANGELOG.md"
          : `${relativePackage}/CHANGELOG.md`,
      run,
      environment,
    }),
  ]);
  let sourceManifest: PublicationManifest;
  try {
    sourceManifest = JSON.parse(manifestSource) as PublicationManifest;
  } catch {
    throw new Error(`原提交 ${sourceSha} 中的 package.json 不是有效 JSON。`);
  }
  if (
    sourceManifest.name !== accepted.packageName ||
    sourceManifest.version !== accepted.packageVersion
  ) {
    throw new Error("原提交清单与已验收 tgz 回执的包名或版本不一致。");
  }
  const repositoryUrl = canonicalGithubRepository(sourceManifest.repository);
  if (repositoryUrl === undefined) {
    throw new Error(
      "发布目标原提交 package.json 的 repository 必须指向 GitHub 仓库。",
    );
  }
  if (
    options.githubRepository !== undefined &&
    repositoryUrl !== canonicalGithubRepository(options.githubRepository)
  ) {
    throw new Error("发布目标原提交 repository 与当前 GitHub 仓库不一致。");
  }
  const { inspectPackageReleaseChangelog } = await import("./changelog.ts");
  const changelogResult = inspectPackageReleaseChangelog(
    changelog,
    accepted.packageVersion,
  );
  if (changelogResult.blockers.length > 0) {
    throw new Error(
      `原提交 CHANGELOG.md 未找到唯一非空的 ${accepted.packageVersion} 版本说明。`,
    );
  }
  if (changelogResult.releaseNotes === undefined) {
    throw new Error("原提交 CHANGELOG.md 的版本说明无法恢复。");
  }
  const artifactName = path.basename(accepted.artifactPath);
  const size = (await stat(accepted.artifactPath)).size;
  const repository = repositoryUrl.replace("https://github.com/", "");
  return {
    artifactPath: accepted.artifactPath,
    artifactName,
    packageName: accepted.packageName,
    packageVersion: accepted.packageVersion,
    artifactVersion: accepted.artifactVersion,
    sourceSha,
    sha512: accepted.sha512,
    integrity: `sha512-${Buffer.from(accepted.sha512, "hex").toString("base64")}`,
    size,
    packedManifest: accepted.packedManifest,
    sourceManifest,
    repository,
    repositoryUrl,
    checksumContent: `${accepted.sha512}  ${artifactName}\n`,
    receiptPath: accepted.receiptPath,
    ...(accepted.receipt.npmPublicationAttempt === undefined
      ? {}
      : { npmPublicationAttempt: accepted.receipt.npmPublicationAttempt }),
    releaseNotes: changelogResult.releaseNotes,
  };
}

/** 保留用于包本地诊断；远端续办必须调用 readAcceptedRemoteArtifact。 */
export async function readPackageReleaseNotes(options: {
  readonly repositoryRoot: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly sourceSha: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly run?: RemoteCommandRunner;
}): Promise<string> {
  const environment = options.environment ?? process.env;
  const relativePackage = packageRelativePath(
    options.repositoryRoot,
    options.packageRoot,
  );
  const changelog = await sourceFile({
    repositoryRoot: options.repositoryRoot,
    sourceSha: options.sourceSha,
    relativePath: `${relativePackage}/CHANGELOG.md`,
    run: options.run ?? defaultRemoteCommand,
    environment,
  });
  const { inspectPackageReleaseChangelog } = await import("./changelog.ts");
  const result = inspectPackageReleaseChangelog(
    changelog,
    options.packageVersion,
  );
  if (result.blockers.length > 0) {
    throw new Error(
      `原提交 CHANGELOG.md 未找到唯一非空的 ${options.packageVersion} 版本说明。`,
    );
  }
  if (result.releaseNotes === undefined) {
    throw new Error("原提交 CHANGELOG.md 的版本说明无法恢复。");
  }
  return result.releaseNotes;
}

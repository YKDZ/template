import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { readAcceptedArtifact } from "./publication.ts";
import {
  defaultRemoteCommand,
  type RemoteCommandRunner,
} from "./remote-context.ts";

export type AcceptedPublicationArtifact = {
  readonly packageRoot: string;
  readonly packageName: string;
  readonly artifactVersion: string;
  readonly artifactPath: string;
  readonly receiptPath: string;
  readonly sha512: string;
};

/** 远端批次写入前复核清单中的每份 tgz 与已验收回执。 */
export async function validateAcceptedPublicationArtifacts(
  artifacts: readonly AcceptedPublicationArtifact[],
): Promise<void> {
  await Promise.all(
    artifacts.map(async (artifact) => {
      const prepared = await readAcceptedArtifact({
        packageRoot: artifact.packageRoot,
        artifactPath: artifact.artifactPath,
        preserveReceiptTarget: true,
      });
      if (
        prepared.kind !== "prepared" ||
        prepared.packageName !== artifact.packageName ||
        prepared.artifactVersion !== artifact.artifactVersion ||
        prepared.sha512 !== artifact.sha512 ||
        path.resolve(prepared.receiptPath) !==
          path.resolve(artifact.receiptPath)
      ) {
        throw new Error(
          `已验收原件清单与 tgz 或回执不一致：${artifact.packageName}。`,
        );
      }
    }),
  );
}

/** 校验远端批次的原件和每个目标实际声明的阶段入口。 */
export async function validateRemotePublicationTargets(
  artifacts: readonly AcceptedPublicationArtifact[],
  scriptName: "publication:remote:npm" | "publication:remote:release",
): Promise<void> {
  await validateAcceptedPublicationArtifacts(artifacts);
  const missing = (
    await Promise.all(
      artifacts.map(async (artifact) => {
        const manifestPath = path.join(artifact.packageRoot, "package.json");
        const manifest = record(
          JSON.parse(await readFile(manifestPath, "utf8")),
        );
        const scripts = record(manifest?.scripts);
        const script = scripts?.[scriptName];
        return typeof script === "string" && script.trim().length > 0
          ? undefined
          : `- ${artifact.packageName}：${manifestPath}#/scripts/${scriptName} 缺失或为空。\n  处理方法：请在该目标 package.json 的 scripts 中声明共享发布入口后重新准备并验收原件。`;
      }),
    )
  ).filter((item): item is string => item !== undefined);
  if (missing.length > 0) {
    throw new Error(
      [
        "已停止本阶段所有远端写入：发布目标缺少必需的远端任务脚本。",
        ...missing,
      ].join("\n"),
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function childPath(root: string, relative: unknown): string {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    path.isAbsolute(relative)
  ) {
    throw new Error("已验收原件列表包含无效的相对路径。");
  }
  const resolved = path.resolve(root, relative);
  const difference = path.relative(root, resolved);
  if (
    difference === ".." ||
    difference.startsWith(`..${path.sep}`) ||
    path.isAbsolute(difference)
  ) {
    throw new Error("已验收原件列表中的路径超出所属目录。");
  }
  return resolved;
}

type SelectedPublicationTarget = {
  readonly name: string;
  readonly path: string;
};

async function selectedTargets(options: {
  readonly repositoryRoot: string;
  readonly filters: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly run: RemoteCommandRunner;
}): Promise<readonly SelectedPublicationTarget[]> {
  if (options.filters.length === 0) {
    throw new Error("恢复已验收原件必须提供原工作流的 pnpm 发布目标。 ");
  }
  const selected = await options.run(
    "pnpm",
    [
      "--recursive",
      "--workspace-concurrency=1",
      "--include-workspace-root",
      "--fail-if-no-match",
      ...options.filters.flatMap((filter) => ["--filter", filter]),
      "--sort",
      "exec",
      "node",
      "-e",
      'const project = JSON.parse(require("node:fs").readFileSync("package.json", "utf8")); console.log(JSON.stringify({ name: project.name, path: process.cwd() }));',
    ],
    { cwd: options.repositoryRoot, env: options.environment },
  );
  if (selected.exitCode !== 0) {
    throw new Error(
      `pnpm 原生选择已验收目标失败：${selected.stderr || selected.stdout}`,
    );
  }
  const targets = selected.stdout.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith("{") || !line.endsWith("}")) return [];
    const value = record(JSON.parse(line));
    return typeof value?.name === "string" && typeof value.path === "string"
      ? [{ name: value.name, path: path.resolve(value.path) }]
      : [];
  });
  if (targets.length === 0) {
    throw new Error("pnpm 原生选择没有返回已验收的 npm 发布目标。");
  }
  const identities = new Set<string>();
  for (const target of targets) {
    const identity = `${target.name}\0${target.path}`;
    if (identities.has(identity)) {
      throw new Error(`pnpm 原生选择重复返回发布目标：${target.name}。`);
    }
    identities.add(identity);
  }
  return targets;
}

/** 在同一 Actions run 中恢复已上传的验收原件；不会重新打包或消费。 */
export async function restoreAcceptedPublicationArtifacts(options: {
  readonly repositoryRoot: string;
  readonly artifactDirectory: string;
  readonly sourceSha: string;
  readonly filters: readonly string[];
  readonly runId: string;
  readonly runAttempt: number;
  readonly githubRepository: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly run?: RemoteCommandRunner;
}): Promise<boolean> {
  if (
    !/^[0-9a-f]{40}$/u.test(options.sourceSha) ||
    !/^\d+$/u.test(options.runId) ||
    !Number.isSafeInteger(options.runAttempt) ||
    options.runAttempt < 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.githubRepository)
  ) {
    throw new Error("恢复已验收原件所需的工作流身份无效。");
  }
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const artifactDirectory = path.resolve(options.artifactDirectory);
  const artifactName = `verified-packed-publication-${options.runId}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.environment,
  };
  const run = options.run ?? defaultRemoteCommand;
  const listingResult = await run(
    "gh",
    [
      "api",
      `repos/${options.githubRepository}/actions/runs/${options.runId}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
    ],
    { cwd: repositoryRoot, env: environment },
  );
  if (listingResult.exitCode !== 0) {
    throw new Error(
      `无法读取本次工作流的已验收原件记录：${listingResult.stderr || listingResult.stdout}`,
    );
  }
  const listing = record(JSON.parse(listingResult.stdout));
  if (!Array.isArray(listing?.artifacts)) {
    throw new Error("本次工作流的已验收原件列表格式无效。");
  }
  const matches = listing.artifacts.filter(
    (artifact) => record(artifact)?.name === artifactName,
  );
  if (matches.length === 0) {
    if (options.runAttempt > 1) {
      throw new Error(
        "本次工作流已进入续办，但原验收原件缺失或过期；请使用新工作流重新验收。",
      );
    }
    return false;
  }
  if (matches.length !== 1 || record(matches[0])?.expired === true) {
    throw new Error("本次工作流的已验收原件不唯一或已过期，已停止续办。");
  }

  await mkdir(artifactDirectory, { recursive: true });
  if ((await readdir(artifactDirectory)).length > 0) {
    throw new Error("已验收原件恢复目录并非空目录，已停止续办。");
  }
  const downloaded = await run(
    "gh",
    [
      "run",
      "download",
      options.runId,
      `--name=${artifactName}`,
      `--dir=${artifactDirectory}`,
    ],
    { cwd: repositoryRoot, env: environment },
  );
  if (downloaded.exitCode !== 0) {
    throw new Error(
      `无法下载本次工作流的已验收原件：${downloaded.stderr || downloaded.stdout}`,
    );
  }

  const listPath = path.join(
    artifactDirectory,
    "publication-accepted-artifacts.json",
  );
  const accepted = await readAcceptedPublicationArtifacts({
    repositoryRoot,
    environment: {
      ...environment,
      PUBLICATION_ACCEPTED_ARTIFACTS_FILE: listPath,
    },
  });
  const selected = await selectedTargets({
    repositoryRoot,
    filters: options.filters,
    environment,
    run,
  });
  if (accepted.length !== selected.length) {
    throw new Error("已验收原件目标与本次原生选择不一致，已停止续办。");
  }
  const selectedByIdentity = new Map(
    selected.map((target) => [`${target.name}\0${target.path}`, target]),
  );
  for (const artifact of accepted) {
    const identity = `${artifact.packageName}\0${artifact.packageRoot}`;
    if (!selectedByIdentity.has(identity)) {
      throw new Error(
        `已验收原件目标与本次原生选择不一致：${artifact.packageName}。`,
      );
    }
    const prepared = await readAcceptedArtifact({
      packageRoot: artifact.packageRoot,
      artifactPath: artifact.artifactPath,
      preserveReceiptTarget: true,
    });
    if (
      prepared.kind !== "prepared" ||
      prepared.packageName !== artifact.packageName ||
      prepared.artifactVersion !== artifact.artifactVersion ||
      prepared.sha512 !== artifact.sha512 ||
      prepared.receiptPath !== artifact.receiptPath ||
      prepared.receipt.sourceSha !== options.sourceSha
    ) {
      throw new Error(
        `已验收原件与原提交、清单或回执不一致：${artifact.packageName}。`,
      );
    }
    const manifest = record(
      JSON.parse(
        await readFile(path.join(artifact.packageRoot, "package.json"), "utf8"),
      ),
    );
    if (
      manifest?.name !== prepared.packageName ||
      manifest.version !== prepared.packageVersion
    ) {
      throw new Error(
        `已验收原件与当前原提交中的包清单不一致：${artifact.packageName}。`,
      );
    }
  }
  return true;
}

export async function readAcceptedPublicationArtifacts(
  options: {
    readonly repositoryRoot?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<readonly AcceptedPublicationArtifact[]> {
  const environment = options.environment ?? process.env;
  const acceptedListPath = environment.PUBLICATION_ACCEPTED_ARTIFACTS_FILE;
  if (acceptedListPath === undefined || !path.isAbsolute(acceptedListPath)) {
    throw new Error(
      "PUBLICATION_ACCEPTED_ARTIFACTS_FILE 必须指向下载后的原件列表文件。",
    );
  }
  const repositoryRoot = path.resolve(
    options.repositoryRoot ??
      environment.PUBLICATION_REPOSITORY_ROOT ??
      process.cwd(),
  );
  const artifactRoot = path.dirname(acceptedListPath);
  const parsed = record(JSON.parse(await readFile(acceptedListPath, "utf8")));
  if (!Array.isArray(parsed?.artifacts) || parsed.artifacts.length === 0) {
    throw new Error("已验收原件列表为空或格式无效。");
  }
  const names = new Set<string>();
  return parsed.artifacts.map((value): AcceptedPublicationArtifact => {
    const item = record(value);
    if (
      item === undefined ||
      typeof item.packageName !== "string" ||
      item.packageName.length === 0 ||
      names.has(item.packageName) ||
      typeof item.artifactVersion !== "string" ||
      item.artifactVersion.length === 0 ||
      typeof item.sha512 !== "string" ||
      !/^[0-9a-f]{128}$/u.test(item.sha512)
    ) {
      throw new Error("已验收原件列表包含无效或重复的包目标。");
    }
    names.add(item.packageName);
    const packageRoot = childPath(repositoryRoot, item.packageRoot);
    const artifactPath = childPath(artifactRoot, item.artifactPath);
    const receiptPath = childPath(artifactRoot, item.receiptPath);
    if (path.dirname(artifactPath) !== path.dirname(receiptPath)) {
      throw new Error("原件 tgz 与回执必须位于同一已验收目标目录。");
    }
    return {
      packageRoot,
      packageName: item.packageName,
      artifactVersion: item.artifactVersion,
      artifactPath,
      receiptPath,
      sha512: item.sha512,
    };
  });
}

export async function currentAcceptedPublicationArtifact(
  options: {
    readonly repositoryRoot?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly packageRoot?: string;
  } = {},
): Promise<AcceptedPublicationArtifact> {
  const artifacts = await readAcceptedPublicationArtifacts(options);
  const packageRoot = path.resolve(options.packageRoot ?? process.cwd());
  const matches = artifacts.filter(
    (artifact) => artifact.packageRoot === packageRoot,
  );
  if (matches.length !== 1) {
    throw new Error(
      `当前包 ${packageRoot} 不在本次已验收原件列表中，或出现重复目标。`,
    );
  }
  return matches[0]!;
}

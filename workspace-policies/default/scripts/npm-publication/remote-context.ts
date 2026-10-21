import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  readAcceptedArtifact,
  type PublicationManifest,
} from "@ykdz/reference-npm-publication";

export type AcceptedRemoteArtifact = {
  readonly artifactPath: string;
  readonly artifactName: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactVersion: string;
  readonly sha512: string;
  readonly integrity: string;
  readonly size: number;
  readonly packedManifest: PublicationManifest;
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly checksumContent: string;
  readonly receiptPath: string;
};

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

/** 为仍待迁移的远端消费者读取原件绑定事实，不生产或改写回执。 */
export async function readAcceptedRemoteArtifact(options: {
  readonly packageRoot: string;
  readonly artifactDirectory: string;
  readonly githubRepository?: string;
}): Promise<AcceptedRemoteArtifact> {
  const accepted = await readAcceptedArtifact({
    packageRoot: options.packageRoot,
    artifactDirectory: options.artifactDirectory,
  });
  if (accepted.kind !== "prepared") {
    throw new Error("共享发布目标尚未通过身份、版本和消费命令诊断。");
  }

  const sourceManifest = JSON.parse(
    await readFile(path.join(options.packageRoot, "package.json"), "utf8"),
  ) as PublicationManifest;
  const repositoryUrl = canonicalGithubRepository(sourceManifest.repository);
  if (repositoryUrl === undefined) {
    throw new Error(
      "发布目标 package.json 的 repository 必须指向 GitHub 仓库。",
    );
  }
  if (
    options.githubRepository !== undefined &&
    repositoryUrl !== canonicalGithubRepository(options.githubRepository)
  ) {
    throw new Error("发布目标 repository 与当前 GitHub 仓库不一致。");
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
    sha512: accepted.sha512,
    integrity: `sha512-${Buffer.from(accepted.sha512, "hex").toString("base64")}`,
    size,
    packedManifest: accepted.packedManifest,
    repository,
    repositoryUrl,
    checksumContent: `${accepted.sha512}  ${artifactName}\n`,
    receiptPath: accepted.receiptPath,
  };
}

/** 读取包自有的当前版本发布正文；npm 上传本身不依赖此信息。 */
export async function readPackageReleaseNotes(options: {
  readonly packageRoot: string;
  readonly packageVersion: string;
}): Promise<string> {
  const { inspectPackageReleaseChangelog } = await import("./changelog.ts");
  const changelog = await readFile(
    path.join(options.packageRoot, "CHANGELOG.md"),
    "utf8",
  );
  const result = inspectPackageReleaseChangelog(
    changelog,
    options.packageVersion,
  );
  if (result.blockers.length > 0 || !("releaseNotes" in result)) {
    throw new Error(
      `发布说明尚未通过当前远端流程检查：${result.blockers.map((item) => item.code).join("、")}。`,
    );
  }
  return result.releaseNotes;
}

#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  planToolchainBaselineUpdate,
  type ToolchainBaseline,
  type ToolchainUpdateCandidate,
} from "@ykdz/template-core/toolchain-baseline-update";
import {
  resolveToolchainVersions,
  type ResolvedToolchainVersions,
} from "@ykdz/template-core/toolchain-resolution";
import { execa } from "execa";

export const toolchainAutomationBranch = "automation/toolchain-baseline";

export type ToolchainBaselineUpdateRepository = {
  readonly readBaseline: () => Promise<ToolchainBaseline>;
  readonly findCandidate: () => Promise<ToolchainUpdateCandidate>;
  readonly cleanupCandidate: (pullRequestNumber?: number) => Promise<void>;
  readonly refreshFromDefaultBranch: () => Promise<void>;
  readonly writeBaseline: (baseline: ToolchainBaseline) => Promise<void>;
  readonly provisionToolchain: (baseline: ToolchainBaseline) => Promise<void>;
  readonly refreshLockfile: () => Promise<void>;
  readonly runChecks: () => Promise<void>;
  readonly commitAndGuardedForcePush: () => Promise<void>;
  readonly createCandidate: () => Promise<void>;
  readonly refreshCandidate: (pullRequestNumber: number) => Promise<void>;
};

type RunToolchainBaselineUpdateOptions = {
  readonly repository: ToolchainBaselineUpdateRepository;
  readonly resolve?: () => Promise<ResolvedToolchainVersions>;
};

export async function runToolchainBaselineUpdate(
  options: RunToolchainBaselineUpdateOptions,
) {
  const [current, candidate, resolution] = await Promise.all([
    options.repository.readBaseline(),
    options.repository.findCandidate(),
    (options.resolve ?? resolveToolchainVersions)(),
  ]);
  if (resolution.source !== "online") {
    throw new Error(
      `Refusing to update the Toolchain Baseline from ${resolution.source} metadata: ${resolution.diagnostics.join("; ")}`,
    );
  }

  const plan = planToolchainBaselineUpdate({
    current,
    candidate,
    desired: {
      nodeLtsMajor: resolution.nodeLtsMajor.value,
      packageManagerPin: resolution.packageManagerPin.value,
    },
  });

  if (plan.kind === "no-drift") {
    return plan;
  }

  if (plan.kind === "cleanup-stale") {
    await options.repository.cleanupCandidate(plan.pullRequestNumber);
    return plan;
  }

  await options.repository.refreshFromDefaultBranch();
  await options.repository.writeBaseline(plan.desired);
  await options.repository.provisionToolchain(plan.desired);
  await options.repository.refreshLockfile();
  await options.repository.runChecks();
  await options.repository.commitAndGuardedForcePush();
  if (plan.mode === "create") {
    await options.repository.createCandidate();
  } else {
    await options.repository.refreshCandidate(plan.pullRequestNumber);
  }

  return plan;
}

type GitHubRepositoryOptions = {
  readonly root: string;
  readonly defaultBranch: string;
  readonly repositoryOwner: string;
  readonly pullRequests?: ToolchainPullRequestApi;
};

export type ToolchainPullRequestMetadata = {
  readonly number: number;
  readonly headRefName: string;
  readonly headRepositoryOwner: string;
  readonly baseRefName: string;
  readonly isCrossRepository: boolean;
};

export type ToolchainPullRequestApi = {
  readonly findOpen: (options: {
    owner: string;
    head: string;
    base: string;
  }) => Promise<readonly ToolchainPullRequestMetadata[]>;
  readonly close: (number: number, comment: string) => Promise<void>;
  readonly create: (options: {
    base: string;
    head: string;
    title: string;
    body: string;
  }) => Promise<void>;
  readonly update: (
    number: number,
    options: { title: string; body: string },
  ) => Promise<void>;
};

export class GitHubToolchainBaselineUpdateRepository implements ToolchainBaselineUpdateRepository {
  readonly #root: string;
  readonly #defaultBranch: string;
  readonly #repositoryOwner: string;
  readonly #pullRequests: ToolchainPullRequestApi;
  #remoteCandidateSha = "";
  #desiredPnpmPin = "";

  constructor(options: GitHubRepositoryOptions) {
    this.#root = options.root;
    this.#defaultBranch = options.defaultBranch;
    this.#repositoryOwner = options.repositoryOwner;
    this.#pullRequests =
      options.pullRequests ?? new GhPullRequestApi(options.root);
  }

  async readBaseline(): Promise<
    ToolchainBaseline & { materialConsistent: boolean }
  > {
    await this.#command("git", ["fetch", "origin", this.#defaultBranch]);
    const packageJson = JSON.parse(
      (
        await this.#command("git", [
          "show",
          `origin/${this.#defaultBranch}:package.json`,
        ])
      ).stdout,
    ) as { engines?: { node?: string }; packageManager?: string };
    const nodeMatch = packageJson.engines?.node?.match(/^>=(\d+)\.0\.0$/);
    const packageManagerPin = packageJson.packageManager;
    if (!nodeMatch || !packageManagerPin?.match(/^pnpm@\d+\.\d+\.\d+$/)) {
      throw new Error("Repository Toolchain Baseline is malformed");
    }

    const fallback = (
      await this.#command("git", [
        "show",
        `origin/${this.#defaultBranch}:packages/core/src/toolchain-resolution.ts`,
      ])
    ).stdout;
    const fallbackNode = fallback.match(
      /bundledFallbackToolchain = \{[\s\S]*?nodeLtsMajor: nodeLtsMajor\("(\d+)"\),/,
    )?.[1];
    const fallbackPnpm = fallback.match(
      /bundledFallbackToolchain = \{[\s\S]*?packageManagerPin: packageManagerPin\("(\d+\.\d+\.\d+)"\),/,
    )?.[1];

    return {
      nodeLtsMajor: nodeMatch[1]!,
      packageManagerPin: packageManagerPin as `pnpm@${string}`,
      materialConsistent:
        fallbackNode === nodeMatch[1] &&
        fallbackPnpm === packageManagerPin.slice("pnpm@".length),
    };
  }

  async findCandidate(): Promise<ToolchainUpdateCandidate> {
    const [candidates, remote] = await Promise.all([
      this.#pullRequests.findOpen({
        owner: this.#repositoryOwner,
        head: toolchainAutomationBranch,
        base: this.#defaultBranch,
      }),
      this.#command("git", [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${toolchainAutomationBranch}`,
      ]),
    ]);
    if (candidates.length > 1) {
      throw new Error("More than one Toolchain Baseline candidate is open");
    }
    const candidate = candidates[0];
    if (candidate !== undefined) {
      if (
        candidate.headRefName !== toolchainAutomationBranch ||
        candidate.baseRefName !== this.#defaultBranch ||
        candidate.headRepositoryOwner !== this.#repositoryOwner ||
        candidate.isCrossRepository
      ) {
        throw new Error("Toolchain Baseline candidate metadata is unexpected");
      }
    }
    this.#remoteCandidateSha = remote.stdout.trim().split(/\s+/)[0] ?? "";

    return {
      pullRequest:
        candidate === undefined
          ? { kind: "absent" }
          : { kind: "open", pullRequestNumber: candidate.number },
      remoteBranch: this.#remoteCandidateSha
        ? { kind: "present", sha: this.#remoteCandidateSha }
        : { kind: "absent" },
    };
  }

  async cleanupCandidate(pullRequestNumber?: number): Promise<void> {
    if (pullRequestNumber !== undefined) {
      await this.#pullRequests.close(
        pullRequestNumber,
        "Closing because the default branch no longer has Toolchain Baseline drift.",
      );
    }
    if (this.#remoteCandidateSha) {
      await this.#command("git", [
        "push",
        `--force-with-lease=refs/heads/${toolchainAutomationBranch}:${this.#remoteCandidateSha}`,
        "origin",
        `:refs/heads/${toolchainAutomationBranch}`,
      ]);
    }
  }

  async refreshFromDefaultBranch(): Promise<void> {
    await this.#command("git", ["fetch", "origin", this.#defaultBranch]);
    const remote = await this.#command("git", [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${toolchainAutomationBranch}`,
    ]);
    this.#remoteCandidateSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
    await this.#command("git", [
      "checkout",
      "-B",
      toolchainAutomationBranch,
      `origin/${this.#defaultBranch}`,
    ]);
    await this.#command("git", [
      "reset",
      "--hard",
      `origin/${this.#defaultBranch}`,
    ]);
  }

  async writeBaseline(baseline: ToolchainBaseline): Promise<void> {
    const packageJsonPath = path.join(this.#root, "package.json");
    const packageJson = JSON.parse(
      await readFile(packageJsonPath, "utf8"),
    ) as Record<string, unknown> & { engines?: Record<string, string> };
    packageJson.packageManager = baseline.packageManagerPin;
    packageJson.engines = {
      ...packageJson.engines,
      node: `>=${baseline.nodeLtsMajor}.0.0`,
    };
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );

    const fallbackPath = path.join(
      this.#root,
      "packages/core/src/toolchain-resolution.ts",
    );
    const fallback = await readFile(fallbackPath, "utf8");
    const nodePattern =
      /(bundledFallbackToolchain = \{[\s\S]*?nodeLtsMajor: nodeLtsMajor\(")\d+("\),)/;
    const pnpmPattern =
      /(bundledFallbackToolchain = \{[\s\S]*?packageManagerPin: packageManagerPin\(")\d+\.\d+\.\d+("\),)/;
    if (!nodePattern.test(fallback) || !pnpmPattern.test(fallback)) {
      throw new Error("Bundled fallback Toolchain Baseline is malformed");
    }
    await writeFile(
      fallbackPath,
      fallback
        .replace(nodePattern, `$1${baseline.nodeLtsMajor}$2`)
        .replace(pnpmPattern, `$1${baseline.packageManagerPin.slice(5)}$2`),
    );
  }

  async provisionToolchain(baseline: ToolchainBaseline): Promise<void> {
    const actualNodeMajor = process.versions.node.split(".")[0];
    if (actualNodeMajor !== baseline.nodeLtsMajor) {
      throw new Error(
        `Updater requires Node ${baseline.nodeLtsMajor}, but is running on Node ${process.versions.node}`,
      );
    }
    await this.#command("corepack", [
      "install",
      "--global",
      baseline.packageManagerPin,
    ]);
    const pnpmVersion = await this.#command("corepack", [
      baseline.packageManagerPin,
      "--version",
    ]);
    const expected = baseline.packageManagerPin.slice("pnpm@".length);
    if (pnpmVersion.stdout.trim() !== expected) {
      throw new Error(
        `Corepack provisioned pnpm ${pnpmVersion.stdout.trim()}, expected ${expected}`,
      );
    }
    this.#desiredPnpmPin = baseline.packageManagerPin;
  }

  async refreshLockfile(): Promise<void> {
    await this.#pnpm(["install", "--lockfile-only"]);
  }

  async runChecks(): Promise<void> {
    await this.#pnpm(["check"]);
  }

  async commitAndGuardedForcePush(): Promise<void> {
    await this.#command("git", ["config", "user.name", "github-actions[bot]"]);
    await this.#command("git", [
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
    await this.#command("git", [
      "add",
      "package.json",
      "pnpm-lock.yaml",
      "packages/core/src/toolchain-resolution.ts",
    ]);
    await this.#command("git", [
      "commit",
      "-m",
      "chore: update toolchain baseline",
    ]);
    await this.#command("git", [
      "push",
      `--force-with-lease=refs/heads/${toolchainAutomationBranch}:${this.#remoteCandidateSha}`,
      "origin",
      `HEAD:refs/heads/${toolchainAutomationBranch}`,
    ]);
  }

  async createCandidate(): Promise<void> {
    await this.#pullRequests.create({
      base: this.#defaultBranch,
      head: toolchainAutomationBranch,
      title: "chore: update toolchain baseline",
      body: "Updates the Node LTS and mature compatible pnpm baselines together. This automation never auto-merges.",
    });
  }

  async refreshCandidate(pullRequestNumber: number): Promise<void> {
    await this.#pullRequests.update(pullRequestNumber, {
      title: "chore: update toolchain baseline",
      body: "Updates the Node LTS and mature compatible pnpm baselines together. This candidate was rebuilt from the latest default branch and never auto-merges.",
    });
  }

  #command(command: string, arguments_: readonly string[]) {
    return execa(command, arguments_, { cwd: this.#root });
  }

  #pnpm(arguments_: readonly string[]) {
    if (!this.#desiredPnpmPin) {
      throw new Error("Toolchain must be provisioned before pnpm is used");
    }
    return this.#command("corepack", [this.#desiredPnpmPin, ...arguments_]);
  }
}

class GhPullRequestApi implements ToolchainPullRequestApi {
  readonly #root: string;
  constructor(root: string) {
    this.#root = root;
  }
  async findOpen(options: { owner: string; head: string; base: string }) {
    const result = await execa(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        `${options.owner}:${options.head}`,
        "--base",
        options.base,
        "--json",
        "number,headRefName,headRepositoryOwner,baseRefName,isCrossRepository",
        "--limit",
        "2",
      ],
      { cwd: this.#root },
    );
    const values = JSON.parse(result.stdout) as Array<
      Omit<ToolchainPullRequestMetadata, "headRepositoryOwner"> & {
        headRepositoryOwner: { login: string } | string;
      }
    >;
    return values.map((value) => ({
      ...value,
      headRepositoryOwner:
        typeof value.headRepositoryOwner === "string"
          ? value.headRepositoryOwner
          : value.headRepositoryOwner.login,
    }));
  }
  async close(number: number, comment: string) {
    await execa("gh", ["pr", "close", String(number), "--comment", comment], {
      cwd: this.#root,
    });
  }
  async create(options: {
    base: string;
    head: string;
    title: string;
    body: string;
  }) {
    await execa(
      "gh",
      [
        "pr",
        "create",
        "--base",
        options.base,
        "--head",
        options.head,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      { cwd: this.#root },
    );
  }
  async update(number: number, options: { title: string; body: string }) {
    await execa(
      "gh",
      [
        "pr",
        "edit",
        String(number),
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      { cwd: this.#root },
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--print-workflow-outputs")) {
    const resolution = await resolveToolchainVersions();
    if (resolution.source !== "online") {
      throw new Error(
        `Cannot provision updater toolchain from ${resolution.source} metadata`,
      );
    }
    console.log(`node-major=${resolution.nodeLtsMajor.value}`);
    console.log(`pnpm-pin=${resolution.packageManagerPin.value}`);
    return;
  }
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const repository = new GitHubToolchainBaselineUpdateRepository({
    root,
    defaultBranch: process.env["DEFAULT_BRANCH"] ?? "main",
    repositoryOwner:
      process.env["REPOSITORY_OWNER"] ??
      process.env["GITHUB_REPOSITORY_OWNER"] ??
      "",
  });
  const plan = await runToolchainBaselineUpdate({ repository });
  console.log(`Toolchain Baseline update result: ${plan.kind}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GitHubToolchainBaselineUpdateRepository,
  runToolchainBaselineUpdate,
  toolchainAutomationBranch,
  type ToolchainPullRequestApi,
  type ToolchainPullRequestMetadata,
} from "@ykdz/template-checks/update-toolchain-baseline";
import { execa } from "execa";

const owner = "example-owner";

describe("Toolchain Baseline real Git lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("fetches and hard-resets from the current default branch while constraining PR lookup", async () => {
    const fixture = await repositoryFixture(roots);
    const queries: unknown[] = [];
    const api = fakePullRequests({ queries });
    const repository = fixture.repository(api);
    await writeFile(path.join(fixture.work, "package.json"), "dirty\n");

    expect(await repository.findCandidate()).toEqual({
      pullRequest: { kind: "absent" },
      remoteBranch: { kind: "absent" },
    });
    await repository.refreshFromDefaultBranch();

    expect(queries).toEqual([
      { owner, head: toolchainAutomationBranch, base: "main" },
    ]);
    expect(
      await readFile(path.join(fixture.work, "package.json"), "utf8"),
    ).toContain('"packageManager": "pnpm@11.11.0"');
  });

  it("stages only baseline material and guarded-force-pushes it", async () => {
    const fixture = await repositoryFixture(roots);
    const repository = fixture.repository(fakePullRequests());
    await repository.findCandidate();
    await repository.refreshFromDefaultBranch();
    await repository.writeBaseline({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.12.0",
    });
    await writeFile(path.join(fixture.work, "unrelated.txt"), "do not stage\n");
    await repository.commitAndGuardedForcePush();

    const tree = await git(
      fixture.work,
      "ls-tree",
      "-r",
      "--name-only",
      `origin/${toolchainAutomationBranch}`,
    );
    expect(tree.stdout).not.toContain("unrelated.txt");
    expect(tree.stdout).toContain("package.json");
  });

  it("rejects a replacement when the remote automation branch races its lease", async () => {
    const fixture = await repositoryFixture(roots, true);
    const repository = fixture.repository(fakePullRequests());
    await repository.findCandidate();
    await repository.refreshFromDefaultBranch();
    await repository.writeBaseline({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.12.0",
    });
    await advanceRemoteBranch(fixture, roots);

    await expect(repository.commitAndGuardedForcePush()).rejects.toThrow();
  });

  it("guardedly deletes a stale remote branch without requiring an open PR", async () => {
    const fixture = await repositoryFixture(roots, true);
    const repository = fixture.repository(fakePullRequests());
    expect((await repository.findCandidate()).remoteBranch.kind).toBe(
      "present",
    );

    await repository.cleanupCandidate();

    const remote = await git(
      fixture.work,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${toolchainAutomationBranch}`,
    );
    expect(remote.stdout).toBe("");
  });

  it("does not push a candidate when full validation fails", async () => {
    const fixture = await repositoryFixture(roots, false, "exit 17");
    const repository = fixture.repository(fakePullRequests());

    await expect(
      runToolchainBaselineUpdate({
        repository,
        resolve: async () => ({
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.12.0",
          },
          source: "online",
          diagnostics: [],
        }),
      }),
    ).rejects.toThrow();
    const remote = await git(
      fixture.work,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${toolchainAutomationBranch}`,
    );
    expect(remote.stdout).toBe("");
  }, 30_000);

  it("rejects PR metadata outside the fixed owner, head, and base", async () => {
    const fixture = await repositoryFixture(roots);
    const metadata: ToolchainPullRequestMetadata = {
      number: 9,
      headRefName: toolchainAutomationBranch,
      headRepositoryOwner: "fork-owner",
      baseRefName: "main",
      isCrossRepository: true,
    };
    const repository = fixture.repository(
      fakePullRequests({ candidates: [metadata] }),
    );

    await expect(repository.findCandidate()).rejects.toThrow(
      "candidate metadata is unexpected",
    );
  });
});

function fakePullRequests(
  options: {
    candidates?: readonly ToolchainPullRequestMetadata[];
    queries?: unknown[];
  } = {},
): ToolchainPullRequestApi {
  return {
    findOpen: async (query) => {
      options.queries?.push(query);
      return options.candidates ?? [];
    },
    close: async () => undefined,
    create: async () => undefined,
    update: async () => undefined,
  };
}

async function repositoryFixture(
  roots: string[],
  automationBranch = false,
  check = "exit 0",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolchain-git-"));
  roots.push(root);
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  await git(root, "init", "--bare", bare);
  await git(root, "init", "-b", "main", seed);
  await git(seed, "config", "user.name", "Fixture");
  await git(seed, "config", "user.email", "fixture@example.test");
  await writeFile(
    path.join(seed, "package.json"),
    `${JSON.stringify({ scripts: { check }, engines: { node: ">=24.0.0" }, packageManager: "pnpm@11.11.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(seed, "pnpm-lock.yaml"),
    "lockfileVersion: '11.0'\n",
  );
  await execa("mkdir", ["-p", "packages/core/src"], { cwd: seed });
  await writeFile(
    path.join(seed, "packages/core/src/toolchain-resolution.ts"),
    'const bundledFallbackToolchain = {\n  nodeLtsMajor: nodeLtsMajor("24"),\n  packageManagerPin: packageManagerPin("11.11.0"),\n};\n',
  );
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "remote", "add", "origin", bare);
  await git(seed, "push", "-u", "origin", "main");
  if (automationBranch) {
    await git(
      seed,
      "push",
      "origin",
      `main:refs/heads/${toolchainAutomationBranch}`,
    );
  }
  await git(root, "clone", "--branch", "main", bare, work);
  return {
    bare,
    seed,
    work,
    repository: (pullRequests: ToolchainPullRequestApi) =>
      new GitHubToolchainBaselineUpdateRepository({
        root: work,
        defaultBranch: "main",
        repositoryOwner: owner,
        pullRequests,
      }),
  };
}

async function advanceRemoteBranch(fixture: { bare: string }, roots: string[]) {
  const racer = await mkdtemp(path.join(os.tmpdir(), "toolchain-racer-"));
  roots.push(racer);
  await git(
    racer,
    "clone",
    "--branch",
    toolchainAutomationBranch,
    fixture.bare,
    ".",
  );
  await git(racer, "config", "user.name", "Racer");
  await git(racer, "config", "user.email", "racer@example.test");
  await writeFile(path.join(racer, "race.txt"), "race\n");
  await git(racer, "add", "race.txt");
  await git(racer, "commit", "-m", "race");
  await git(racer, "push", "origin", toolchainAutomationBranch);
}

function git(cwd: string, ...arguments_: string[]) {
  return execa("git", arguments_, { cwd });
}

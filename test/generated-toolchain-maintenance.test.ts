import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import {
  blueprintForPresetSourcePreset,
  projectPresetSourcePreset,
} from "@ykdz/template-core/projection-capabilities";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { execa } from "execa";
import { parse } from "yaml";

import {
  checkEnvironmentNeedsForPackageManifests,
  type GithubEffects,
  resolveToolchainBaseline,
  runToolchainBaselineMaintenance,
  updateToolchainBaselineMaterials,
} from "../packages/builtin-source/templates/shared/toolchain-maintenance/update-toolchain-baseline.ts";

describe("Generated Repository Toolchain Baseline maintenance", () => {
  it("derives ShellCheck preparation only from a Package Boundary that owns shell validation", () => {
    expect(
      checkEnvironmentNeedsForPackageManifests([
        {
          scripts: {
            lint: "shellcheck scripts/container-entrypoint.sh && oxlint .",
          },
        },
      ]),
    ).toEqual(["shellcheck"]);
    expect(
      checkEnvironmentNeedsForPackageManifests([
        { scripts: { lint: "oxlint ." } },
      ]),
    ).toEqual([]);
  });

  it("selects the latest official LTS with the newest compatible pnpm older than 24 hours", async () => {
    const resolved = await resolveToolchainBaseline(
      [
        { version: "v25.2.0", lts: false },
        { version: "v24.4.0", lts: "Krypton" },
        { version: "v22.9.0", lts: "Jod" },
      ],
      {
        versions: {
          "11.9.0": { engines: { node: ">=20" } },
          "11.10.0": { engines: { node: ">=24" } },
          "11.11.0": { engines: { node: ">=24" } },
          "12.0.0": { engines: { node: ">=26" } },
        },
        time: {
          "11.9.0": "2026-07-08T00:00:00.000Z",
          "11.10.0": "2026-07-09T11:59:59.999Z",
          "11.11.0": "2026-07-09T12:00:00.001Z",
          "12.0.0": "2026-07-08T00:00:00.000Z",
        },
      },
      new Date("2026-07-10T12:00:00.000Z"),
    );

    expect(resolved).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.10.0",
    });
  });

  it("projects one offline-testable single-flight updater into every maintained Project Shape", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const maintainedPresets = manifest.presets.filter(
      (preset) =>
        preset.generation === "supported" &&
        preset.features.includes("github-actions"),
    );

    expect(maintainedPresets.length).toBeGreaterThan(0);

    for (const preset of maintainedPresets) {
      const targetDir = await mkdtemp(
        path.join(tmpdir(), `generated-toolchain-${preset.name}-`),
      );
      const blueprint = blueprintForPresetSourcePreset(preset, { targetDir });
      const context = assembleGenerationContext({
        blueprint,
        targetDir,
        toolchain: {
          diagnostics: [],
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.11.0",
          },
          source: "online",
        },
      });
      const plan = projectPresetSourcePreset({
        preset,
        context,
        sourceRoots: builtInPresetProjectionSourceRoots(),
      });
      await renderNewProject({
        sourceRoot: plan.sourceRoot,
        sourceRoots: plan.sourceRoots,
        targetRoot: targetDir,
        operations: [...plan.operations],
      });

      const workflow = parse(
        await readFile(
          path.join(
            targetDir,
            ".github/workflows/toolchain-baseline-update.yml",
          ),
          "utf8",
        ),
      ) as {
        permissions: Record<string, string>;
        concurrency: { group: string; "cancel-in-progress": boolean };
        jobs: { update: { steps: Array<{ run?: string }> } };
      };
      expect(workflow.permissions).toEqual({
        contents: "write",
        "pull-requests": "write",
      });
      expect(workflow.concurrency).toEqual({
        group: "toolchain-baseline-update",
        "cancel-in-progress": false,
      });
      expect(JSON.stringify(workflow)).not.toContain("merge");

      const rootPackageJson = JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as {
        devDependencies: Record<string, string>;
      };
      expect(rootPackageJson.devDependencies).toMatchObject({
        "@types/semver": "catalog:",
        semver: "catalog:",
      });
      expect(
        await readFile(path.join(targetDir, "tsconfig.config.json"), "utf8"),
      ).toContain('"scripts/**/*.ts"');
      const dependabot = await readFile(
        path.join(targetDir, ".github/dependabot.yml"),
        "utf8",
      );
      expect(dependabot).toContain("package-ecosystem: npm");
      expect(dependabot).toContain("package-ecosystem: github-actions");
      expect(dependabot).toContain('dependency-name: "pnpm"');

      const fixturePath = path.join(targetDir, "toolchain-fixture.json");
      await writeFile(
        fixturePath,
        `${JSON.stringify({
          current: {
            nodeLtsMajor: "24",
            packageManagerPin: "pnpm@11.11.0",
          },
          desired: {
            nodeLtsMajor: "26",
            packageManagerPin: "pnpm@12.1.0",
          },
          candidate: {
            pullRequest: { kind: "absent" },
            remoteBranch: { kind: "absent" },
          },
        })}\n`,
      );
      const result = await execa(
        "node",
        ["scripts/update-toolchain-baseline.ts", "--plan-fixture", fixturePath],
        { cwd: targetDir },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        kind: "update",
        mode: "create",
        desired: {
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@12.1.0",
        },
      });

      if (preset.name === "vike-app") {
        await updateToolchainBaselineMaterials(targetDir, {
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@12.1.0",
        });
        for (const manifestPath of [
          "package.json",
          "apps/web/package.json",
          "packages/db/package.json",
        ]) {
          const manifest = JSON.parse(
            await readFile(path.join(targetDir, manifestPath), "utf8"),
          ) as { engines: { node: string }; packageManager?: string };
          expect(manifest.engines.node).toBe("26");
          expect(manifest.packageManager).toBe(
            manifestPath === "packages/db/package.json"
              ? undefined
              : "pnpm@12.1.0",
          );
        }
        const devcontainer = JSON.parse(
          await readFile(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ) as { build: { args: Record<string, string> } };
        expect(devcontainer.build.args).toMatchObject({
          NODE_VERSION: "26",
          PACKAGE_MANAGER_PIN: "pnpm@12.1.0",
        });
        const generationRecord = JSON.parse(
          await readFile(
            path.join(targetDir, ".template/generated-by.json"),
            "utf8",
          ),
        ) as { toolchain: Record<string, string> };
        expect(generationRecord.toolchain).toMatchObject({
          nodeLtsMajor: "26",
          packageManagerPin: "pnpm@12.1.0",
        });
        const dockerfile = await readFile(
          path.join(targetDir, "apps/web/Dockerfile"),
          "utf8",
        );
        expect(dockerfile).toContain("FROM node:26-bookworm-slim");
        expect(dockerfile).toContain('ARG PACKAGE_MANAGER_PIN="pnpm@12.1.0"');
        expect(dockerfile).not.toContain("FROM node:24-");
      }
    }
  });

  it("rejects a Node projection when its required maintenance source is absent", () => {
    const preset = loadBuiltInPresetSourceManifest().presets.find(
      (candidate) => candidate.name === "ts-lib",
    )!;
    const targetDir = path.join(tmpdir(), "missing-toolchain-maintenance");
    const blueprint = blueprintForPresetSourcePreset(preset, { targetDir });
    const context = assembleGenerationContext({
      blueprint,
      targetDir,
      toolchain: {
        diagnostics: [],
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.11.0" },
        source: "online",
      },
    });
    const sourceRoots = builtInPresetProjectionSourceRoots();
    expect(() =>
      projectPresetSourcePreset({
        preset,
        context,
        sourceRoots: {
          ...sourceRoots,
          sharedResource(resourceId) {
            return resourceId === "shared-toolchain-maintenance"
              ? undefined
              : sourceRoots.sharedResource(resourceId);
          },
        },
      }),
    ).toThrow(
      "Toolchain Baseline maintenance requires Shared Resource: shared-toolchain-maintenance",
    );
  });

  it("creates a checked candidate in an isolated origin without auto-merging", async () => {
    const fixture = await createGitFixture();
    const github = fakeGithub();
    const sequence: string[] = [];
    await runToolchainBaselineMaintenance({
      rootDirectory: fixture.checkout,
      desired: desiredBaseline,
      defaultBranch: "main",
      owner: "example",
      github: github.effects,
      hooks: successfulHooks(fixture.checkout, sequence),
    });
    expect(
      await remoteSha(fixture.origin, "automation/toolchain-baseline"),
    ).toMatch(/^[0-9a-f]{40}$/);
    expect(sequence).toEqual([
      "package-manager",
      "lockfile",
      "prepare",
      "check",
    ]);
    expect(github.events).toEqual(["create"]);
  });

  it("replaces an open candidate from an advanced default branch", async () => {
    const fixture = await createGitFixture();
    await pushAutomationCandidate(fixture);
    const github = fakeGithub([7]);
    let advanced = false;
    const hooks = successfulHooks(fixture.checkout, []);
    await runToolchainBaselineMaintenance({
      rootDirectory: fixture.checkout,
      desired: desiredBaseline,
      defaultBranch: "main",
      owner: "example",
      github: github.effects,
      hooks: {
        ...hooks,
        async beforePush() {
          if (!advanced) {
            advanced = true;
            await advanceDefaultBranch(fixture);
          }
        },
      },
    });
    const candidate = await remoteSha(
      fixture.origin,
      "automation/toolchain-baseline",
    );
    const parent = (
      await execa("git", [
        "--git-dir",
        fixture.origin,
        "rev-parse",
        `${candidate}^`,
      ])
    ).stdout;
    expect(parent).toBe(await remoteSha(fixture.origin, "main"));
    expect(github.events).toEqual(["update:7"]);
  });

  it("refuses a concurrent candidate replacement instead of overwriting it", async () => {
    const fixture = await createGitFixture();
    await pushAutomationCandidate(fixture);
    const github = fakeGithub([7]);
    const hooks = successfulHooks(fixture.checkout, []);
    await expect(
      runToolchainBaselineMaintenance({
        rootDirectory: fixture.checkout,
        desired: desiredBaseline,
        defaultBranch: "main",
        owner: "example",
        github: github.effects,
        hooks: {
          ...hooks,
          async beforePush() {
            await replaceAutomationCandidate(fixture);
          },
        },
      }),
    ).rejects.toThrow("candidate changed while checks ran");
    expect(github.events).toEqual([]);
  });

  it("does not push or open a pull request when the full check fails", async () => {
    const fixture = await createGitFixture();
    const github = fakeGithub();
    const hooks = successfulHooks(fixture.checkout, []);
    await expect(
      runToolchainBaselineMaintenance({
        rootDirectory: fixture.checkout,
        desired: desiredBaseline,
        defaultBranch: "main",
        owner: "example",
        github: github.effects,
        hooks: {
          ...hooks,
          async runChecks() {
            throw new Error("check failed");
          },
        },
      }),
    ).rejects.toThrow("check failed");
    expect(
      await remoteSha(fixture.origin, "automation/toolchain-baseline"),
    ).toBe("");
    expect(github.events).toEqual([]);
  });

  it("closes and deletes stale single-flight state when drift disappears", async () => {
    const fixture = await createGitFixture();
    await pushAutomationCandidate(fixture);
    const github = fakeGithub([7]);
    await runToolchainBaselineMaintenance({
      rootDirectory: fixture.checkout,
      desired: currentBaseline,
      defaultBranch: "main",
      owner: "example",
      github: github.effects,
    });
    expect(
      await remoteSha(fixture.origin, "automation/toolchain-baseline"),
    ).toBe("");
    expect(github.events).toEqual(["close:7"]);
  });

  it("fails clearly when an owned material is present but malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "malformed-toolchain-"));
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ engines: { node: "24" }, packageManager: "pnpm@11.11.0" })}\n`,
    );
    await writeFile(path.join(root, ".devcontainer.json"), "{}\n");
    await expect(
      updateToolchainBaselineMaterials(root, desiredBaseline),
    ).resolves.toBeUndefined();
    const devcontainer = path.join(root, ".devcontainer");
    await execa("mkdir", ["-p", devcontainer]);
    await writeFile(
      path.join(devcontainer, "devcontainer.json"),
      `${JSON.stringify({ build: {} })}\n`,
    );
    await expect(
      updateToolchainBaselineMaterials(root, desiredBaseline),
    ).rejects.toThrow("build.args must be an object");
  });
});

const currentBaseline = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.11.0",
} as const;
const desiredBaseline = {
  nodeLtsMajor: "26",
  packageManagerPin: "pnpm@12.1.0",
} as const;

async function createGitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolchain-origin-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  await execa("git", ["init", "--bare", origin]);
  await execa("git", ["init", "--initial-branch=main", seed]);
  await execa("git", ["config", "user.name", "Fixture"], { cwd: seed });
  await execa("git", ["config", "user.email", "fixture@example.test"], {
    cwd: seed,
  });
  await writeFile(
    path.join(seed, "package.json"),
    `${JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' }, engines: { node: "24" }, packageManager: "pnpm@11.11.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(seed, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
  await execa("git", ["add", "."], { cwd: seed });
  await execa("git", ["commit", "-m", "initial"], { cwd: seed });
  await execa("git", ["remote", "add", "origin", origin], { cwd: seed });
  await execa("git", ["push", "-u", "origin", "main"], { cwd: seed });
  await execa("git", ["clone", origin, checkout]);
  return { root, origin, seed, checkout };
}

function fakeGithub(initialPulls: number[] = []): {
  effects: GithubEffects;
  events: string[];
} {
  const pulls = [...initialPulls];
  const events: string[] = [];
  return {
    events,
    effects: {
      async findPullRequests() {
        return pulls;
      },
      async closePullRequest(number) {
        events.push(`close:${number}`);
        pulls.splice(0);
      },
      async createPullRequest() {
        events.push("create");
        pulls.push(1);
      },
      async updatePullRequest(number) {
        events.push(`update:${number}`);
      },
    },
  };
}

function successfulHooks(root: string, sequence: string[]) {
  return {
    async installPackageManager() {
      sequence.push("package-manager");
    },
    async updateLockfile() {
      sequence.push("lockfile");
      await writeFile(
        path.join(root, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n# updated\n",
      );
    },
    async prepareChecks() {
      sequence.push("prepare");
    },
    async runChecks() {
      sequence.push("check");
    },
  };
}

async function remoteSha(origin: string, branch: string): Promise<string> {
  const result = await execa(
    "git",
    ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
    { reject: false },
  );
  return result.exitCode === 0 ? result.stdout : "";
}

async function pushAutomationCandidate(
  fixture: Awaited<ReturnType<typeof createGitFixture>>,
) {
  await execa("git", ["checkout", "-B", "automation/toolchain-baseline"], {
    cwd: fixture.seed,
  });
  await writeFile(path.join(fixture.seed, "candidate.txt"), "old\n");
  await execa("git", ["add", "."], { cwd: fixture.seed });
  await execa("git", ["commit", "-m", "old candidate"], { cwd: fixture.seed });
  await execa("git", ["push", "origin", "HEAD:automation/toolchain-baseline"], {
    cwd: fixture.seed,
  });
  await execa("git", ["checkout", "main"], { cwd: fixture.seed });
}

async function advanceDefaultBranch(
  fixture: Awaited<ReturnType<typeof createGitFixture>>,
) {
  await writeFile(path.join(fixture.seed, "advanced.txt"), `${Date.now()}\n`);
  await execa("git", ["add", "."], { cwd: fixture.seed });
  await execa("git", ["commit", "-m", "advance default"], {
    cwd: fixture.seed,
  });
  await execa("git", ["push", "origin", "main"], { cwd: fixture.seed });
}

async function replaceAutomationCandidate(
  fixture: Awaited<ReturnType<typeof createGitFixture>>,
) {
  await execa("git", ["checkout", "automation/toolchain-baseline"], {
    cwd: fixture.seed,
  });
  await writeFile(path.join(fixture.seed, "candidate.txt"), `${Date.now()}\n`);
  await execa("git", ["add", "."], { cwd: fixture.seed });
  await execa("git", ["commit", "-m", "replace candidate"], {
    cwd: fixture.seed,
  });
  await execa(
    "git",
    ["push", "--force", "origin", "HEAD:automation/toolchain-baseline"],
    { cwd: fixture.seed },
  );
  await execa("git", ["checkout", "main"], { cwd: fixture.seed });
}

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { execa } from "execa";

import { runGeneratedScenarioSet } from "../src/check-generated-registry.ts";
import { executeFocusedPackageLink } from "../src/fixture-evidence/gates/focused-package-link/index.ts";
import { fixtureDependencyInstallationPlan } from "../src/fixture-evidence/kernel/index.ts";
void describe("registry-derived Package Addition Fixture Matrix", () => {
  type GeneratedDevelopmentContainerConfig = {
    build: { args: Record<string, string> };
    mounts: Record<string, unknown>[];
  };

  void it("isolates generated installs from the repository pnpm store", () => {
    assert.deepStrictEqual(fixtureDependencyInstallationPlan("/pnpm/store"), {
      storeDir: "/pnpm/store",
      commands: [
        {
          command: "pnpm",
          args: ["install", "--lockfile-only", "--store-dir", "/pnpm/store"],
        },
        {
          command: "pnpm",
          args: ["fetch", "--store-dir", "/pnpm/store"],
        },
        {
          command: "pnpm",
          args: [
            "install",
            "--offline",
            "--frozen-lockfile",
            "--store-dir",
            "/pnpm/store",
          ],
        },
      ],
    });
  });

  for (const testCase of [
    {
      protectedField: "build argument",
      mutate: (config: GeneratedDevelopmentContainerConfig) => {
        config.build.args.NODE_VERSION = "999";
      },
      expectedError: "build arguments do not match the final Tool Layer plan",
    },
    {
      protectedField: "mount",
      mutate: (config: GeneratedDevelopmentContainerConfig) => {
        const mount = config.mounts.find(
          (candidate) => candidate.target === "/pnpm/store",
        );
        if (mount === undefined) {
          throw new Error("Expected projected pnpm store mount");
        }
        mount.source = "user-overlap";
      },
      expectedError:
        "mount pnpm-store does not match the final Tool Layer plan",
    },
  ] as const) {
    const { mutate, expectedError, protectedField } = testCase;
    void it(`rejects a protected Development Container ${protectedField} mismatch before evidence lookup`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "fixture-final-projection-validation-"),
      );
      const evidenceEvents: Array<{ readonly type: string }> = [];

      try {
        await assert.rejects(
          runGeneratedScenarioSet("init", {
            workspace,
            evidence: {
              writeEnabled: false,
              recordLifecycle: (event) => {
                evidenceEvents.push(event);
              },
            },
            run: async (command, args, options) => {
              if (command !== "git") {
                throw new Error(
                  `Development Container execution started before projection validation: ${command}`,
                );
              }
              const result = await execa(command, [...args], options);
              if (args[0] === "init") {
                const configPath = path.join(
                  options.cwd,
                  ".devcontainer/devcontainer.json",
                );
                const config = JSON.parse(
                  await readFile(configPath, "utf8"),
                ) as GeneratedDevelopmentContainerConfig;
                mutate(config);
                await writeFile(
                  configPath,
                  `${JSON.stringify(config, null, 2)}\n`,
                );
              }
              return result;
            },
          }),
          (error: unknown) =>
            error instanceof Error && error.message.includes(expectedError),
        );
        assert.deepStrictEqual(evidenceEvents, []);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  for (const manifestOwner of ["root", "package"] as const) {
    void it(`rejects an accidentally public ${manifestOwner} manifest before container-backed fixture gates`, async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "fixture-manifest-publication-"),
      );

      try {
        const expectedError =
          manifestOwner === "root"
            ? "Generated Repository Node manifest package.json must remain private"
            : /Generated Repository Node manifest packages\/.+\/package\.json must remain private/u;
        await assert.rejects(
          runGeneratedScenarioSet("init", {
            workspace,
            run: async (command, args, options) => {
              if (command !== "git") {
                throw new Error(
                  `Container-backed fixture command started before manifest policy validation: ${command}`,
                );
              }
              const result = await execa(command, [...args], options);
              if (args[0] !== "init") return result;

              const manifestPaths = ["package.json"];
              if (manifestOwner === "package") {
                const blueprint = JSON.parse(
                  await readFile(
                    path.join(options.cwd, ".template/blueprint.json"),
                    "utf8",
                  ),
                ) as {
                  packages: readonly { readonly path: string }[];
                };
                manifestPaths.splice(
                  0,
                  1,
                  ...blueprint.packages.map(
                    (definition) => `${definition.path}/package.json`,
                  ),
                );
              }

              for (const manifestPath of manifestPaths) {
                const filePath = path.join(options.cwd, manifestPath);
                const manifest = JSON.parse(
                  await readFile(filePath, "utf8"),
                ) as Record<string, unknown>;
                if (manifest.private !== true) continue;
                await writeFile(
                  filePath,
                  `${JSON.stringify({ ...manifest, private: false }, null, 2)}\n`,
                );
                return result;
              }
              throw new Error(
                `Expected a private ${manifestOwner} manifest in ${options.cwd}`,
              );
            },
          }),
          (error: unknown) =>
            error instanceof Error &&
            (typeof expectedError === "string"
              ? error.message.includes(expectedError)
              : expectedError.test(error.message)),
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  void it("consumes manifest-derived provider source and distribution exports by package name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "focused-provider-probe-"));
    const consumerPackagePath = "apps/unusual-consumer";
    const providerPackagePath = "tools/unusual-provider";
    const consumerRoot = path.join(root, consumerPackagePath);
    const providerRoot = path.join(root, providerPackagePath);
    const providerName = "@fixture/unusual-provider";
    const sourceTarget = "implementation/current-entry.ts";
    const defaultTarget = "output/default-entry.js";
    const calls: { command: string; args: readonly string[] }[] = [];

    try {
      await Promise.all([
        mkdir(path.join(consumerRoot, "node_modules/@fixture"), {
          recursive: true,
        }),
        mkdir(path.join(providerRoot, path.dirname(sourceTarget)), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(consumerRoot, "package.json"),
          `${JSON.stringify({ name: "@fixture/unusual-consumer" })}\n`,
        ),
        writeFile(
          path.join(providerRoot, "package.json"),
          `${JSON.stringify({
            name: providerName,
            type: "module",
            exports: {
              ".": {
                source: `./${sourceTarget}`,
                default: `./${defaultTarget}`,
              },
            },
          })}\n`,
        ),
        writeFile(
          path.join(providerRoot, sourceTarget),
          "export const existing = true;\n",
        ),
      ]);
      await symlink(
        providerRoot,
        path.join(consumerRoot, "node_modules/@fixture/unusual-provider"),
        "dir",
      );

      await executeFocusedPackageLink({
        scenarioLabel: "dynamic provider fixture",
        projectDir: root,
        fixtureWorkspace: root,
        consumerPackagePath,
        providerPackagePath,
        run: async (command, args, options) => {
          calls.push({ command, args });
          if (args[0] === "install") return {};
          if (command === "pnpm") {
            assert.deepStrictEqual(args, [
              "exec",
              "turbo",
              "run",
              "build",
              "--filter=@fixture/unusual-consumer",
              `--filter=${providerName}`,
              "--force",
            ]);
            const builtSource = await readFile(
              path.join(providerRoot, sourceTarget),
              "utf8",
            );
            await mkdir(path.join(providerRoot, path.dirname(defaultTarget)), {
              recursive: true,
            });
            await writeFile(
              path.join(providerRoot, defaultTarget),
              builtSource,
            );
            return {};
          }
          return await execa(command, [...args], options);
        },
      });

      await assert.rejects(
        readFile(path.join(providerRoot, sourceTarget), "utf8"),
        (error) => {
          return (
            typeof error === "object" &&
            error !== null &&
            Object.hasOwn(error, "code") &&
            (error as { readonly code?: unknown }).code === "ENOENT"
          );
        },
      );
      assert.ok(
        (
          await readFile(path.join(providerRoot, defaultTarget), "utf8")
        ).includes("templateFocusedExport"),
      );
      const nodeCalls = calls
        .filter(({ command }) => command === "node")
        .map(({ args }) => args);
      assert.strictEqual(nodeCalls.length, 2);
      assert.ok(nodeCalls[0]?.includes("--conditions=source"));
      assert.ok(!nodeCalls[1]?.includes("--conditions=source"));
      assert.deepStrictEqual(
        (await readdir(consumerRoot)).filter((entry) =>
          entry.includes("focused-provider-probe"),
        ),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("derives the real run fixture toolchain from the release snapshot, not historical pins", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "fixture-runtime-snapshot-"),
    );
    const captured = new Map<
      string,
      {
        packageManager: string;
        node: string;
        rustChannel?: string;
      }
    >();
    const stopSentinel = "container execution stopped after runtime capture";

    try {
      // 真实初始化先渲染再调用 Git，因此可在 Git 接缝观察各场景的根 manifest。
      // 在首个容器命令处停止；本测试证明运行夹具输入，不把它作为 Docker 成功结果。
      await assert.rejects(
        runGeneratedScenarioSet("init", {
          workspace,
          run: async (command, args, options) => {
            if (command !== "git") {
              throw new Error(stopSentinel);
            }
            const result = await execa(command, [...args], options);
            if (args[0] !== "init") return result;
            const manifest = JSON.parse(
              await readFile(path.join(options.cwd, "package.json"), "utf8"),
            ) as { packageManager: string; engines: { node: string } };
            let rustChannel: string | undefined;
            try {
              const toml = await readFile(
                path.join(options.cwd, "rust-toolchain.toml"),
                "utf8",
              );
              rustChannel = /channel\s*=\s*"([^"]+)"/u.exec(toml)?.[1];
            } catch {
              rustChannel = undefined;
            }
            captured.set(path.basename(options.cwd), {
              packageManager: manifest.packageManager,
              node: manifest.engines.node,
              ...(rustChannel === undefined ? {} : { rustChannel }),
            });
            return result;
          },
        }),
        (error: unknown) =>
          error instanceof Error && error.message.includes(stopSentinel),
      );

      assert.ok(captured.size > 0);
      for (const [id, observed] of captured) {
        assert.strictEqual(
          observed.packageManager,
          releaseToolchainSnapshot.packageManagerPin,
          `root manifest for ${id} must consume the release snapshot pnpm pin`,
        );
        assert.strictEqual(
          observed.node,
          releaseToolchainSnapshot.nodeVersion,
          `root manifest for ${id} must consume the release snapshot Node version`,
        );
      }

      const rustScenarios = [...captured.values()].filter(
        (observed) => observed.rustChannel !== undefined,
      );
      assert.ok(rustScenarios.length > 0);
      for (const observed of rustScenarios) {
        assert.strictEqual(
          observed.rustChannel,
          releaseToolchainSnapshot.rustVersion,
          "a Rust scenario must observe the exact release snapshot Rust version",
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

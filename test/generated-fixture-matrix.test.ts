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

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";

import { assertGeneratedTaskDiscovery } from "../packages/checks/src/check-generated-registry.ts";
import { executeFocusedPackageLink } from "../packages/checks/src/fixture-evidence/gates/focused-package-link/index.ts";
import { fixtureDependencyInstallationPlan } from "../packages/checks/src/fixture-evidence/kernel/index.ts";

describe("registry-derived Package Addition Fixture Matrix", () => {
  const definition = builtInPresetRegistry.all()[0]!;
  const plan = planGeneratedRepositoryInitialization({
    definition,
    context: createGenerationContext({
      targetDir: path.join("generated-repository", "fixture-dry-run"),
      scope: "fixture",
      toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
    }),
  });

  it("fails the matrix when Turbo dry-run omits a generated task despite a successful command", async () => {
    await expect(
      assertGeneratedTaskDiscovery({
        plan,
        projectDir: "/tmp/generated-fixture-matrix",
        taskNames: ["lint", "typecheck"],
        run: async () => ({ stdout: JSON.stringify({ tasks: [] }) }),
      }),
    ).rejects.toThrow("Turbo dry-run omitted generated task(s)");
  });

  it("fails the matrix when a successful command does not produce Turbo dry-run JSON", async () => {
    await expect(
      assertGeneratedTaskDiscovery({
        plan,
        projectDir: "/tmp/generated-fixture-matrix",
        taskNames: ["lint", "typecheck"],
        run: async () => ({ stdout: "completed successfully" }),
      }),
    ).rejects.toThrow("Turbo dry-run did not return a task graph");
  });

  it("isolates generated installs from the repository pnpm store", () => {
    expect(
      fixtureDependencyInstallationPlan("/tmp/generated-scenarios"),
    ).toEqual({
      command: "pnpm",
      args: ["install", "--store-dir", "/tmp/generated-scenarios/.pnpm-store"],
    });
  });

  it("consumes manifest-derived provider source and distribution exports by package name", async () => {
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
            expect(args).toEqual([
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

      await expect(
        readFile(path.join(providerRoot, sourceTarget), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(providerRoot, defaultTarget), "utf8"),
      ).resolves.toContain("templateFocusedExport");
      expect(
        calls
          .filter(({ command }) => command === "node")
          .map(({ args }) => args),
      ).toEqual([
        expect.arrayContaining(["--conditions=source"]),
        expect.not.arrayContaining(["--conditions=source"]),
      ]);
      expect(
        (await readdir(consumerRoot)).filter((entry) =>
          entry.includes("focused-provider-probe"),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

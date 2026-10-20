import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { execa } from "execa";

import {
  preserveInstalledGeneratedRepositoryFailure,
  removeWithRetry,
  type InstalledGeneratedRepository,
} from "../../test-support/installed-generated-repository.ts";
import {
  installedIntegrationSignal,
  throwIfInstalledIntegrationWasCancelled,
} from "../../test-support/installed-integration-signal.ts";

const runtimeToolchain = {
  nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
    0,
    releaseToolchainSnapshot.nodeVersion.indexOf("."),
  ),
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
};

void describe("vike-app Built-in Preset Definition behavior", () => {
  void it(
    "resolves the database package export under default and source conditions",
    { timeout: 180_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-vike-db-export-"),
      );
      const targetDir = path.join(workspace, "demo-vike");
      const repository: InstalledGeneratedRepository = { workspace, targetDir };
      try {
        const plan = planGeneratedRepositoryInitialization({
          definition: builtInPresetRegistry.require("vike-app"),
          context: createGenerationContext({
            targetDir,
            defaultPackageScope: "demo",
            toolchain: runtimeToolchain,
          }),
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });

        throwIfInstalledIntegrationWasCancelled();
        const cancelSignal = installedIntegrationSignal(testContext.signal);
        await execa("pnpm", ["install"], {
          cwd: targetDir,
          cancelSignal,
        });

        await execa("pnpm", ["--filter", "./packages/db", "run", "typecheck"], {
          cwd: targetDir,
          cancelSignal,
        });
        for (const packagePath of [
          "apps/web",
          "packages/db-migrations",
        ] as const) {
          await assert.rejects(
            execa(
              "pnpm",
              ["--filter", `./${packagePath}`, "run", "typecheck"],
              {
                cwd: targetDir,
                cancelSignal,
              },
            ),
            (error) => {
              assert.ok(
                typeof error === "object" &&
                  error !== null &&
                  Object.hasOwn(error, "stdout"),
              );
              const stdout = (error as { readonly stdout: unknown }).stdout;
              assert.ok(
                typeof stdout === "string" && stdout.includes("TS2307"),
              );
              return true;
            },
          );
        }

        await execa("pnpm", ["exec", "turbo", "run", "typecheck"], {
          cwd: targetDir,
          cancelSignal,
        });
        const resolveDatabaseStorage = (args: readonly string[] = []) =>
          execa(
            "node",
            [
              ...args,
              "--input-type=module",
              "--eval",
              'console.log(import.meta.resolve("@demo/db/storage"));',
            ],
            {
              cwd: path.join(targetDir, "apps/web"),
              cancelSignal,
            },
          ).then(({ stdout }) => stdout);
        assert.match(await resolveDatabaseStorage(), /\/dist\/storage\.js$/u);
        assert.match(
          await resolveDatabaseStorage(["--conditions=source"]),
          /\/src\/storage\.ts$/u,
        );
      } catch (cause) {
        const retained = await preserveInstalledGeneratedRepositoryFailure({
          label: "Vike",
          scenario: "vike-database-export-resolution",
          repository,
          cause,
        });
        if (retained !== undefined) {
          try {
            await removeWithRetry(workspace);
          } catch (cleanupCause) {
            throw new AggregateError(
              [cause, cleanupCause],
              "Vike export scenario failed and its workspace could not be removed",
              { cause },
            );
          }
        }
        throw cause;
      }
      await removeWithRetry(workspace);
    },
  );
});

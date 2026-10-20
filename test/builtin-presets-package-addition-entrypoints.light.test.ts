import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  loadLocalTemplateMetadata,
  planGeneratedRepositoryInitialization,
  planGeneratedRepositoryPackageAddition,
} from "@ykdz/template-builtin-presets";
import { reconcileAndApplyProjectProjections } from "@ykdz/template-core/project-projection";
import { renderNewProject } from "@ykdz/template-core/renderer";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

void describe("Built-in Preset Package Addition universality", () => {
  void it("keeps default-root task entrypoints stable while Turbo discovers added scripts", async (testContext) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-natural-addition-"),
    );
    testContext.after(async () =>
      rm(workspace, { recursive: true, force: true }),
    );
    const targetDir = path.join(workspace, "demo");
    const toolchain = {
      nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
        0,
        releaseToolchainSnapshot.nodeVersion.indexOf("."),
      ),
      packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    };
    const context = createGenerationContext({
      targetDir,
      defaultPackageScope: "demo",
      toolchain,
    });
    const definition = builtInPresetRegistry
      .all()
      .find((candidate) => candidate.planPackageAddition !== undefined);
    assert.ok(definition !== undefined);

    const initialization = planGeneratedRepositoryInitialization({
      definition,
      context,
    });
    await renderNewProject({
      targetRoot: targetDir,
      operations: [...initialization.operations],
    });
    const rootScriptsBefore = (
      JSON.parse(
        await readFile(path.join(targetDir, "package.json"), "utf8"),
      ) as {
        scripts: Record<string, string | undefined>;
      }
    ).scripts;

    for (const packageLeafName of ["natural", "natural-repeat"] as const) {
      const packageAddition = planGeneratedRepositoryPackageAddition({
        definition,
        localTemplateMetadata: loadLocalTemplateMetadata(context.targetDir),
        packageLeafName,
      });
      await reconcileAndApplyProjectProjections({
        targetRoot: targetDir,
        ...packageAddition.projectProjections,
      });
      const rootScriptsAfter = (
        JSON.parse(
          await readFile(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          scripts: Record<string, string | undefined>;
        }
      ).scripts;

      for (const script of [
        "check",
        "check:heavy",
        "check:full",
        "fix",
        "deployment",
      ] as const) {
        assert.strictEqual(rootScriptsAfter[script], rootScriptsBefore[script]);
      }
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  builtInPresetRegistry,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import type { GenerationContext } from "@ykdz/template-workspace-authoring/preset-definition";
import { renderGeneratedPnpmWorkspaceYaml } from "@ykdz/template-workspace/dependency-catalog";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";
import { execa } from "execa";

const packageManagerPin = "pnpm@11.11.0";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function definitionForPnpmPolicy(context: GenerationContext) {
  const definition = builtInPresetRegistry.all().find((candidate) => {
    const contributions = planGeneratedRepositoryInitialization({
      definition: candidate,
      context,
    }).packageContributions;
    return contributions.every(
      (contribution) => contribution.foundation.toolchains.rust === undefined,
    );
  });
  if (definition === undefined) {
    throw new Error(
      "The pnpm Workspace Policy check requires a Node-only Built-in Preset Definition",
    );
  }
  return definition;
}

async function generateNodeOnlyProject(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(workspace, "demo-lib");
  const context = {
    targetDir: projectDir,
    repositoryName: "demo-lib",
    defaultPackageScope: "demo-lib",
    foundationPackages: {
      typescriptConfiguration: { name: "@demo-lib/typescript-config" },
    },
    toolchain: {
      nodeLtsMajor: "24",
      packageManagerPin,
      // 直接规划新建初始化会派生新建公开 ts-cli 候选，需要发版快照的精确三段版本。
      nodeVersion: releaseToolchainSnapshot.nodeVersion,
    },
  } satisfies GenerationContext;

  await execa(
    "node",
    [
      "--conditions=source",
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "init",
      projectDir,
      "--preset",
      definitionForPnpmPolicy(context).metadata.name,
    ],
    { cwd: repoRoot },
  );
  return projectDir;
}

void describe("pnpm Workspace Policy", () => {
  void it("renders only explicitly requested dependency overrides", () => {
    const workspace = renderGeneratedPnpmWorkspaceYaml({
      dependencies: [],
      overrides: { "example>peer": "-" },
    });

    assert.ok(workspace.includes('"example>peer": "-"'));
    assert.ok(
      workspace.includes('minimumReleaseAgeExclude:\n  - "@ykdz/template"'),
    );
    assert.ok(workspace.includes("injectWorkspacePackages: false"));
    assert.ok(!workspace.includes("valibot>typescript"));
    assert.ok(!workspace.includes("pnpmfile"));
  });

  void it("keeps the template CLI out of generated repository maturity delays", async () => {
    const projectDir = await generateNodeOnlyProject("pnpm-template-cli-age-");
    const workspace = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8",
    );

    assert.ok(
      workspace.includes('minimumReleaseAgeExclude:\n  - "@ykdz/template"'),
    );
    assert.ok(workspace.includes("preferSymlinkedExecutables: true"));
  });

  void it("selects a Node-only Definition by contribution semantics", () => {
    const context = {
      targetDir: "/tmp/pnpm-policy-definition",
      repositoryName: "pnpm-policy-definition",
      defaultPackageScope: "pnpm-policy-definition",
      foundationPackages: {
        typescriptConfiguration: {
          name: "@pnpm-policy-definition/typescript-config",
        },
      },
      toolchain: {
        nodeLtsMajor: "24",
        packageManagerPin,
        nodeVersion: releaseToolchainSnapshot.nodeVersion,
      },
    } satisfies GenerationContext;
    const definition = definitionForPnpmPolicy(context);
    const contributions = planGeneratedRepositoryInitialization({
      definition,
      context,
    }).packageContributions;

    assert.strictEqual(
      contributions.every(
        (contribution) => contribution.foundation.toolchains.rust === undefined,
      ),
      true,
    );
  });
});

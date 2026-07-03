import { readFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "../src/generation-context.js";
import { loadBuiltInPresetSourceManifest } from "../src/preset-source.js";
import {
  interpretPresetProjectionDeclaration,
  type PresetProjectionDeclaration,
  validateProjectionCapabilities,
} from "../src/projection-capabilities.js";
import { renderNewProject } from "../src/renderer.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

const syntheticTsLibDeclaration: PresetProjectionDeclaration = {
  capabilities: [
    {
      kind: "workspace-library-package",
      workspacePackageGlob: "packages/*",
      packageRole: "shared-library",
      packageSourcePreset: "ts-lib",
      sourceFiles: ["src/index.ts", "src/name-schema.ts"],
    },
    { kind: "strict-typescript-root" },
    { kind: "oxc-format-lint" },
    { kind: "node-pnpm-devcontainer" },
    { kind: "github-maintenance" },
  ],
};

async function tsLibContext() {
  const legacyProjection = findBuiltInPresetProjection("ts-lib");
  expect(legacyProjection).toBeDefined();

  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-projection-capabilities-"),
  );
  const targetDir = path.join(workspace, "demo-lib");
  const blueprint = legacyProjection!.blueprint({ targetDir });

  return {
    legacyProjection: legacyProjection!,
    targetDir,
    context: assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    }),
  };
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function expectFile(pathName: string): Promise<void> {
  await expect(stat(pathName)).resolves.toMatchObject({
    size: expect.any(Number),
  });
}

describe("Projection Capability declarations", () => {
  it("interprets a synthetic ts-lib declaration into Generated Repository behavior", async () => {
    const { legacyProjection, context } = await tsLibContext();

    const plan = interpretPresetProjectionDeclaration({
      preset: legacyProjection.metadata,
      declaration: syntheticTsLibDeclaration,
      context,
    });

    expect(
      plan.checkPlan.components.map((component) => component.kind),
    ).toEqual([
      "oxc-format-check",
      "oxc-lint",
      "typescript-typecheck",
      "turbo-package-typecheck",
      "turbo-package-check",
    ]);
    expect(plan.fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
      "turbo-package-fix",
    ]);
    expect(plan.dependencyMaintenancePolicy.ecosystems).toEqual([
      "npm",
      "github-actions",
      "docker",
    ]);
    expect(plan.packageScripts.check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './packages/*' && turbo run check --filter './packages/*'",
    );
    expect(plan.capabilities).toEqual({
      rootCheck: true,
      fixCommand: true,
      githubActions: true,
      dependabot: true,
      devcontainer: true,
    });
  });

  it("renders the ts-lib built-in declaration into expected public generated files", async () => {
    const manifest = loadBuiltInPresetSourceManifest();
    const preset = manifest.presets.find(
      (candidate) => candidate.name === "ts-lib",
    );
    expect(preset?.projection).toBeDefined();
    const { context, targetDir } = await tsLibContext();

    const plan = interpretPresetProjectionDeclaration({
      preset: preset!,
      declaration: preset!.projection!,
      context,
    });
    await renderNewProject({
      sourceRoot: plan.sourceRoot,
      sourceRoots: plan.sourceRoots,
      targetRoot: targetDir,
      operations: [...plan.operations],
    });

    const rootPackageJson = await readJson(
      path.join(targetDir, "package.json"),
    );
    const packageJson = await readJson(
      path.join(targetDir, "packages", "demo-lib", "package.json"),
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const generatedByJson = await readJson(
      path.join(targetDir, ".template/generated-by.json"),
    );

    expect(rootPackageJson).toMatchObject({
      name: "demo-lib",
      private: true,
      type: "module",
      scripts: {
        check:
          "pnpm run format:check && pnpm run lint && pnpm run typecheck && turbo run typecheck --filter './packages/*' && turbo run check --filter './packages/*'",
        fix: "pnpm run format:write && pnpm run lint:fix && turbo run fix --filter './packages/*'",
      },
      devDependencies: {
        oxfmt: "catalog:",
        oxlint: "catalog:",
        turbo: "catalog:",
        typescript: "catalog:",
      },
      packageManager: "pnpm@11.2.3",
    });
    expect(packageJson).toMatchObject({
      name: "@demo-lib/demo-lib",
      dependencies: {
        valibot: "catalog:",
      },
      scripts: {
        check: "pnpm run typecheck && pnpm run lint && pnpm run format:check",
        fix: "pnpm run format:write && pnpm run lint:fix",
      },
      devDependencies: {
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        typescript: "catalog:",
      },
    });
    expect(workspaceYaml).toContain("packages/*");
    expect(workspaceYaml).toContain("valibot:");
    expect(generatedByJson).toMatchObject({
      command: "template init --preset ts-lib",
    });
    await expectFile(path.join(targetDir, "packages/demo-lib/src/index.ts"));
    await expectFile(path.join(targetDir, ".github/workflows/check.yml"));
    await expectFile(path.join(targetDir, ".devcontainer/Dockerfile"));
  });

  it("rejects unknown Projection Capability kinds with semantic diagnostics", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "write-my-private-file",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities[0].kind",
          message: "Unknown Projection Capability kind: write-my-private-file",
        },
      ],
    });
  });

  it("rejects missing Projection Capabilities with semantic diagnostics", () => {
    expect(
      validateProjectionCapabilities({
        capabilities: [
          {
            kind: "workspace-library-package",
            workspacePackageGlob: "packages/*",
            packageRole: "shared-library",
            packageSourcePreset: "ts-lib",
            sourceFiles: ["src/index.ts", "src/name-schema.ts"],
          },
          { kind: "strict-typescript-root" },
          { kind: "oxc-format-lint" },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "$.capabilities",
          message:
            "Projection Capability composition must include github-maintenance to provide GitHub Actions maintenance",
        },
        {
          path: "$.capabilities",
          message:
            "Projection Capability composition must include github-maintenance to provide Dependabot maintenance",
        },
        {
          path: "$.capabilities",
          message:
            "Projection Capability composition must include node-pnpm-devcontainer to provide development container support",
        },
      ],
    });
  });
});

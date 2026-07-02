import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assembleGenerationContext } from "../src/generation-context.js";
import type { PresetProjectionPlan } from "../src/preset-projection.js";
import {
  checkTemplateSourceBoundary,
  templateBoundaryDebtAllowlist,
} from "../src/template-boundary-check.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function minimalPlan(
  operations: PresetProjectionPlan["operations"],
): PresetProjectionPlan {
  return {
    sourceRoot: ".",
    operations,
    checkPlan: { components: [], environmentNeeds: [] },
    fixPlan: { components: [] },
    dependencyMaintenancePolicy: { ecosystems: [], interval: "weekly" },
    packageScripts: {},
    capabilities: {
      rootCheck: true,
      fixCommand: true,
      githubActions: true,
      dependabot: true,
      devcontainer: true,
    },
  };
}

describe("Template Boundary Check", () => {
  it("fails unlisted protected Generated Repository outputs with path and owning function diagnostics", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectSyntheticPreset() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: ".github/dependabot.yml",
              text: "version: 2\n",
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        generatedPath: ".github/dependabot.yml",
        owningFunction: "projectSyntheticPreset",
      }),
    ]);
  });

  it("fails unlisted inline package-local tool configuration outputs", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectRustPreset() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: "packages/cli/rustfmt.toml",',
        '        text: "edition = \\"2024\\"\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic-rust",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: "packages/cli/rustfmt.toml",
              text: 'edition = "2024"\n',
            },
          ]),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: "packages/cli/rustfmt.toml",
        owningFunction: "projectRustPreset",
      }),
    );
  });

  it("does not let duplicate protected paths inherit another owner's allowlist entry", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function allowedLegacyProjection() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
        "function newUnlistedProjection() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        '        to: ".github/dependabot.yml",',
        '        text: "version: 2\\nupdates: []\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: ".github/dependabot.yml",
              text: "version: 2\nupdates: []\n",
            },
          ]),
        },
      ],
      allowlist: [
        {
          preset: "synthetic",
          generatedPath: ".github/dependabot.yml",
          owningFunction: "allowedLegacyProjection",
          reason: "existing debt",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: ".github/dependabot.yml",
        owningFunction: "newUnlistedProjection",
      }),
    );
    expect(result.allowlistedDebt).toEqual([]);
  });

  it("attributes protected outputs whose generated path comes from a template literal", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectRustPreset() {",
        '  const packagePath = "packages/cli";',
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "writeText",',
        "        to: `${packagePath}/rustfmt.toml`,",
        '        text: "edition = \\"2024\\"\\n",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic-rust",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "writeText",
              to: "packages/cli/rustfmt.toml",
              text: 'edition = "2024"\n',
            },
          ]),
        },
      ],
    });

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        generatedPath: "packages/cli/rustfmt.toml",
        owningFunction: "projectRustPreset",
      }),
    );
  });

  it("rejects unused allowlist entries for checked projections", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectCopiedTemplateSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "github/dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "copyFile",
              from: "github/dependabot.yml",
              to: ".github/dependabot.yml",
            },
          ]),
        },
      ],
      allowlist: [
        {
          preset: "synthetic",
          generatedPath: ".github/dependabot.yml",
          owningFunction: "projectCopiedTemplateSource",
          reason: "stale debt entry",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.unusedAllowlistEntries).toEqual([
      {
        preset: "synthetic",
        generatedPath: ".github/dependabot.yml",
        owningFunction: "projectCopiedTemplateSource",
        reason: "stale debt entry",
      },
    ]);
  });

  it("accepts allowlisted current boundary debt while reporting it explicitly", async () => {
    const targetDir = path.join(tmpdir(), "demo-ts-lib");
    const projection = findBuiltInPresetProjection("ts-lib")!;
    const blueprint = projection.blueprint({ targetDir });
    const plan = projection.project(
      assembleGenerationContext({
        targetDir,
        blueprint,
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@11.2.3",
          },
          source: "online",
          diagnostics: [],
        },
      }),
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "ts-lib",
          sourceFilePath: path.join(repoRoot, "templates/ts-lib/projection.ts"),
          plan,
        },
      ],
      allowlist: templateBoundaryDebtAllowlist,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.allowlistedDebt).not.toContainEqual(
      expect.objectContaining({
        preset: "ts-lib",
        generatedPath: ".devcontainer/Dockerfile",
      }),
    );
  });

  it("accepts protected Generated Repository outputs copied from template source", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-boundary-check-"),
    );
    const projectionPath = path.join(workspace, "projection.ts");
    await writeFile(
      projectionPath,
      [
        "function projectCopiedTemplateSource() {",
        "  return {",
        "    operations: [",
        "      {",
        '        kind: "copyFile",',
        '        from: "github/dependabot.yml",',
        '        to: ".github/dependabot.yml",',
        "      },",
        "    ],",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkTemplateSourceBoundary({
      projections: [
        {
          name: "synthetic",
          sourceFilePath: projectionPath,
          plan: minimalPlan([
            {
              kind: "copyFile",
              from: "github/dependabot.yml",
              to: ".github/dependabot.yml",
            },
          ]),
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      violations: [],
      allowlistedDebt: [],
    });
  });
});

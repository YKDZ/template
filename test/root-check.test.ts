import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import { checkTemplateGithubYaml } from "../scripts/check-template-github-yaml.js";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "../src/project-github.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("Project Kit Root Check", () => {
  it("invokes built-in preset fixture checks", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toHaveProperty("check:fixtures");
    expect(packageJson.scripts.check).toContain("pnpm run check:fixtures");
  });

  it("keeps ordinary checks separate from npm publishing", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    const ordinaryCheckScripts = [
      packageJson.scripts.check,
      packageJson.scripts["check:fixtures"],
    ];

    for (const script of ordinaryCheckScripts) {
      expect(script).not.toMatch(/\bnpm\s+publish\b/);
      expect(script).not.toContain("NPM_TOKEN");
      expect(script).not.toContain("NODE_AUTH_TOKEN");
    }
  });

  it("keeps the online toolchain contract check explicit and outside the default Root Check", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toHaveProperty("check:toolchain:online");
    expect(packageJson.scripts["check:toolchain:online"]).toBe(
      "tsx scripts/check-online-toolchain-resolution-contract.ts",
    );
    expect(packageJson.scripts.check).not.toContain("check:toolchain:online");
  });

  it("exposes the online toolchain contract check as an explicit CI workflow", async () => {
    const workflow = await readFile(
      path.join(
        repoRoot,
        ".github/workflows/toolchain-resolution-contract.yml",
      ),
      "utf8",
    );

    expect(workflow).toContain("name: Toolchain Resolution Contract");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("run: pnpm run check:toolchain:online");
    expect(workflow).not.toContain("pnpm run check\n");
  });

  it("runs direct shared OXC template source checks from Root Check", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:shared-oxc",
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:shared-oxc",
    );
    expect(rootPackageJson.scripts["check:templates:shared-oxc"]).toBe(
      "pnpm run check:templates:shared-oxc:format && pnpm run check:templates:shared-oxc:lint && pnpm run check:templates:shared-oxc:typecheck",
    );
    expect(rootPackageJson.scripts["check:templates:shared-oxc"]).not.toContain(
      "pnpm --dir templates/shared/oxc",
    );
    expect(rootPackageJson.scripts).toMatchObject({
      "check:templates:shared-oxc:format":
        "oxfmt --check templates/shared/oxc",
      "check:templates:shared-oxc:lint":
        "oxlint templates/shared/oxc --deny-warnings",
      "check:templates:shared-oxc:typecheck":
        "tsc -p templates/shared/oxc/tsconfig.json --noEmit",
    });

    const workspaceYaml = await readFile(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(workspaceYaml).not.toContain("templates/shared/oxc");
    await expect(
      readFile(path.join(repoRoot, "templates/shared/oxc/package.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await execa("pnpm", ["run", "check:templates:shared-oxc"], {
      cwd: repoRoot,
    });
  });

  it("runs direct template source checks before Fixture Checks", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty("check:templates");
    expect(rootPackageJson.scripts.check).toContain("pnpm run check:templates");
    expect(
      rootPackageJson.scripts.check.indexOf("pnpm run check:templates"),
    ).toBeLessThan(
      rootPackageJson.scripts.check.indexOf("pnpm run check:fixtures"),
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:shared-oxc",
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:github-yaml",
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:static-source",
    );
  });

  it("runs direct static template source format checks from Root Check", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:static-source",
    );
    expect(rootPackageJson.scripts["check:templates:static-source"]).toBe(
      "oxfmt --check --config templates/shared/oxc/oxfmt.config.ts templates && rustfmt --check templates/rust-bin/src/main.rs",
    );

    await execa("pnpm", ["run", "check:templates:static-source"], {
      cwd: repoRoot,
    });
  });

  it("runs direct GitHub YAML template source checks from Root Check", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:github-yaml",
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:github-yaml",
    );
    expect(rootPackageJson.scripts["check:templates:github-yaml"]).toBe(
      "tsx scripts/check-template-github-yaml.ts",
    );

    await execa("pnpm", ["run", "check:templates:github-yaml"], {
      cwd: repoRoot,
    });
  });

  it("directly validates workflow and Dependabot template source contracts", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts["check:templates:github-yaml"]).toBe(
      "tsx scripts/check-template-github-yaml.ts",
    );

    await execa("pnpm", ["run", "check:templates:github-yaml"], {
      cwd: repoRoot,
    });
  });

  it("fails when a supported preset is missing checked GitHub YAML template source", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeValidGithubTemplatePair(workspace, "ts-lib", "npm");

    await expect(
      checkTemplateGithubYaml({
        templatesRoot: workspace,
        supportedPresetNames: ["ts-lib", "rust-bin"],
      }),
    ).rejects.toThrow(
      "templates/rust-bin/.github/workflows/check.yml: expected checked template source file",
    );
  });

  it("fails when workflow jobs are not maps", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeTemplateFile(
      workspace,
      "ts-lib/.github/workflows/check.yml",
      [
        "name: Check",
        "on:",
        "  push:",
        "jobs:",
        "  check: ubuntu-latest",
        "",
      ].join("\n"),
    );
    await writeTemplateFile(
      workspace,
      "ts-lib/.github/dependabot.yml",
      validDependabotTemplate("npm"),
    );

    await expect(
      checkTemplateGithubYaml({
        templatesRoot: workspace,
        supportedPresetNames: ["ts-lib"],
      }),
    ).rejects.toThrow(
      "templates/ts-lib/.github/workflows/check.yml: expected workflow job check to be a map",
    );
  });

  it("fails when the check workflow job lacks a runner or steps", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeTemplateFile(
      workspace,
      "ts-lib/.github/workflows/check.yml",
      [
        "name: Check",
        "on:",
        "  push:",
        "jobs:",
        "  check:",
        "    steps: []",
        "",
      ].join("\n"),
    );
    await writeTemplateFile(
      workspace,
      "ts-lib/.github/dependabot.yml",
      validDependabotTemplate("npm"),
    );

    await expect(
      checkTemplateGithubYaml({
        templatesRoot: workspace,
        supportedPresetNames: ["ts-lib"],
      }),
    ).rejects.toThrow(
      "templates/ts-lib/.github/workflows/check.yml: expected check workflow job to declare runs-on",
    );
  });

  it("fails when check workflow steps are not maps", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeTemplateFile(
      workspace,
      "ts-lib/.github/workflows/check.yml",
      [
        "name: Check",
        "on:",
        "  push:",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - pnpm install",
        "",
      ].join("\n"),
    );
    await writeTemplateFile(
      workspace,
      "ts-lib/.github/dependabot.yml",
      validDependabotTemplate("npm"),
    );

    await expect(
      checkTemplateGithubYaml({
        templatesRoot: workspace,
        supportedPresetNames: ["ts-lib"],
      }),
    ).rejects.toThrow(
      "templates/ts-lib/.github/workflows/check.yml: expected every check workflow step to be a map",
    );
  });

  it("discovers checked GitHub YAML template source with .yaml extensions", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeTemplateFile(
      workspace,
      "ts-lib/.github/workflows/check.yaml",
      validWorkflowTemplate(),
    );
    await writeTemplateFile(
      workspace,
      "ts-lib/.github/dependabot.yaml",
      validDependabotTemplate("npm"),
    );

    await expect(
      checkTemplateGithubYaml({
        templatesRoot: workspace,
        supportedPresetNames: ["ts-lib"],
      }),
    ).resolves.toBe(2);
  });

  it("fails when checked GitHub YAML template source diverges from plan projections", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeValidGithubTemplatePair(workspace, "ts-lib", "npm");
    await writeTemplateFile(
      workspace,
      "ts-lib/.github/workflows/check.yml",
      validWorkflowTemplateForPreset("ts-lib").replace(
        "      - run: pnpm run check",
        "      - run: pnpm test",
      ),
    );

    await expect(
      checkTemplateGithubYaml({
        templatesRoot: workspace,
        supportedPresetNames: ["ts-lib"],
      }),
    ).rejects.toThrow(
      "templates/ts-lib/.github/workflows/check.yml: expected checked template source to match GitHub check workflow projection",
    );
  });
});

async function mkdirTempTemplateWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "template-root-check-"));
}

async function writeTemplateFile(
  workspace: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = path.join(workspace, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeValidGithubTemplatePair(
  workspace: string,
  presetName: "ts-lib" | "rust-bin",
  ecosystem: "npm" | "cargo",
): Promise<void> {
  await writeTemplateFile(
    workspace,
    `${presetName}/.github/workflows/check.yml`,
    validWorkflowTemplateForPreset(presetName),
  );
  await writeTemplateFile(
    workspace,
    `${presetName}/.github/dependabot.yml`,
    validDependabotTemplateForPreset(presetName),
  );
}

function validWorkflowTemplate(): string {
  return validWorkflowTemplateForPreset("ts-lib");
}

function validDependabotTemplate(ecosystem: "npm" | "cargo"): string {
  return ecosystem === "cargo"
    ? validDependabotTemplateForPreset("rust-bin")
    : validDependabotTemplateForPreset("ts-lib");
}

function validWorkflowTemplateForPreset(
  presetName: "ts-lib" | "rust-bin",
): string {
  const projectionPlan = projectThroughPresetProjection(presetName);
  const projectedWorkflow = projectionPlan?.operations.find(
    (operation) =>
      operation.kind === "writeText" &&
      operation.to === ".github/workflows/check.yml",
  );

  return projectedWorkflow?.kind === "writeText"
    ? projectedWorkflow.text
    : missingProjectedGithubTemplate(presetName, "workflow");
}

function validDependabotTemplateForPreset(
  presetName: "ts-lib" | "rust-bin",
): string {
  const projectionPlan = projectThroughPresetProjection(presetName);
  const projectedDependabot = projectionPlan?.operations.find(
    (operation) =>
      operation.kind === "writeText" &&
      operation.to === ".github/dependabot.yml",
  );

  return projectedDependabot?.kind === "writeText"
    ? projectedDependabot.text
    : missingProjectedGithubTemplate(presetName, "dependabot");
}

function missingProjectedGithubTemplate(
  presetName: "ts-lib" | "rust-bin",
  kind: "workflow" | "dependabot",
): never {
  throw new Error(
    `Preset Projection ${presetName} did not project ${kind} template source`,
  );
}

function projectThroughPresetProjection(presetName: "ts-lib" | "rust-bin") {
  const projection = findBuiltInPresetProjection(presetName);

  if (!projection) {
    return undefined;
  }

  return projection.project({
    projectName: { kind: "ProjectName", value: "generated-repository" },
    preset: presetName,
    packageManager: { kind: "PackageManager", value: "pnpm" },
    blueprint: projection.blueprint({ targetDir: "generated-repository" }),
    toolchain: {
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "22" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.0.0" },
      source: "bundled-fallback",
      diagnostics: [],
    },
  });
}

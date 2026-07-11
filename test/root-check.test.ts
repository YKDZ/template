import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { checkTemplateGithubYaml } from "@ykdz/template-checks/check-template-github-yaml";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "@ykdz/template-core/project-github";
import { execa } from "execa";
import ts from "typescript";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const packageJsonWithScriptsSchema = v.object({
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  scripts: v.record(v.string(), v.string()),
});
const turboConfigSchema = v.object({
  boundaries: v.object({
    tags: v.record(v.string(), v.unknown()),
  }),
  tasks: v.record(v.string(), v.unknown()),
});
const workflowWithCheckStepsSchema = v.object({
  jobs: v.object({
    check: v.object({
      steps: v.array(
        v.object({
          name: v.optional(v.string()),
          run: v.optional(v.string()),
        }),
      ),
    }),
  }),
});

function parseJsonWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, JSON.parse(text) as unknown);
}

async function readJsonWithSchema<const Schema extends v.GenericSchema>(
  filePath: string,
  schema: Schema,
): Promise<v.InferOutput<Schema>> {
  return parseJsonWithSchema(await readFile(filePath, "utf8"), schema);
}

function parseYamlWithSchema<const Schema extends v.GenericSchema>(
  text: string,
  schema: Schema,
): v.InferOutput<Schema> {
  return v.parse(schema, parseYaml(text) as unknown);
}

describe("Project Kit Root Check", () => {
  it("rejects production source imports from template modules", async () => {
    const sourceFiles = [
      ...(await listTypeScriptSourceFiles(
        path.join(repoRoot, "packages/core/src"),
      )),
      ...(await listTypeScriptSourceFiles(
        path.join(repoRoot, "packages/cli/src"),
      )),
      ...(await listTypeScriptSourceFiles(
        path.join(repoRoot, "packages/builtin-source/src"),
      )),
      ...(await listTypeScriptSourceFiles(
        path.join(repoRoot, "packages/checks/src"),
      )),
    ];
    const violations: string[] = [];

    for (const sourceFile of sourceFiles) {
      const sourceText = await readFile(sourceFile, "utf8");

      violations.push(
        ...templateModuleReferenceDiagnostics({
          sourceFilePath: sourceFile,
          sourceText,
        }),
      );
    }

    expect(violations).toEqual([]);
  });

  it("detects import, export, and dynamic production references to template modules", () => {
    expect(
      templateModuleReferenceDiagnostics({
        sourceFilePath: path.join(repoRoot, "src/synthetic.ts"),
        sourceText: [
          'import { a } from "@ykdz/template-builtin-source/registry";',
          'export { b } from "@ykdz/template-builtin-source/projection-plans";',
          'const c = await import("@ykdz/template-builtin-source/templates/ts-lib/projection");',
          "",
        ].join("\n"),
      }),
    ).toEqual([
      "src/synthetic.ts imports @ykdz/template-builtin-source/registry",
      "src/synthetic.ts exports from @ykdz/template-builtin-source/projection-plans",
      "src/synthetic.ts dynamically imports @ykdz/template-builtin-source/templates/ts-lib/projection",
    ]);
  });

  it("runs Single Preset Generated Check from the default Root Check", async () => {
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(packageJson.scripts).toHaveProperty("check:generated");
    expect(packageJson.scripts["check:generated"]).toBe(
      "turbo run check:generated --output-logs=errors-only --log-order=grouped",
    );
    expect(packageJson.scripts.check).toContain("check:generated");
  });

  it("keeps Fixture Matrix checks explicit and outside the default Root Check", async () => {
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(packageJson.scripts).toHaveProperty("check:fixtures");
    expect(packageJson.scripts["check:fixtures"]).toBe(
      "turbo run check:fixtures --output-logs=errors-only --log-order=grouped",
    );
    expect(packageJson.scripts.check).not.toContain("check:fixtures");
  });

  it("runs Fixture Matrix checks from the reusable check workflow", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/check.yml"),
      "utf8",
    );

    expect(workflow).toContain("name: Check");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("run: pnpm run check");
    expect(workflow).toContain("run: pnpm run check:fixtures");
    expect(workflow.indexOf("run: pnpm run check\n")).toBeLessThan(
      workflow.indexOf("run: pnpm run check:fixtures"),
    );
    const parsedWorkflow = parseYamlWithSchema(
      workflow,
      workflowWithCheckStepsSchema,
    );
    const runSteps = parsedWorkflow.jobs.check.steps.filter((step) =>
      Boolean(step.run),
    );
    const packageCheckIndex = runSteps.findIndex(
      (step) => step.name === "Check package" && step.run === "pnpm run check",
    );
    const browserPreparationIndex = runSteps.findIndex(
      (step) =>
        step.name === "Prepare browser checks" &&
        step.run ===
          "pnpm --filter @ykdz/template-builtin-source exec playwright install --with-deps chromium",
    );
    const fixtureMatrixCheckIndex = runSteps.findIndex(
      (step) =>
        step.name === "Check fixture matrix" &&
        step.run === "pnpm run check:fixtures",
    );

    expect(browserPreparationIndex).toBeGreaterThanOrEqual(0);
    expect(packageCheckIndex).toBeGreaterThan(browserPreparationIndex);
    expect(packageCheckIndex).toBeGreaterThanOrEqual(0);
    expect(fixtureMatrixCheckIndex).toBeGreaterThan(packageCheckIndex);
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("pnpm publish");
  });

  it("reuses the check workflow before release publishing", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("uses: ./.github/workflows/check.yml");
    expect(workflow).toContain("needs: check");
    expect(workflow).not.toContain("run: pnpm run check\n");
    expect(workflow).not.toContain("run: pnpm run check:fixtures");
  });

  it("keeps ordinary checks separate from npm publishing", async () => {
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

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
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(packageJson.scripts).toHaveProperty("check:toolchain:online");
    expect(packageJson.scripts["check:toolchain:online"]).toBe(
      "turbo run check:toolchain:online --output-logs=errors-only --log-order=grouped",
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
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/builtin-source/package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:shared-oxc",
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "turbo run check:templates --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts["check:templates:shared-oxc"]).toBe(
      "turbo run check:templates:shared-oxc --output-logs=errors-only --log-order=grouped",
    );
    expect(packageJson.scripts["check:templates:shared-oxc"]).toBe(
      "pnpm run check:templates:shared-oxc:format && pnpm run check:templates:shared-oxc:lint && pnpm run check:templates:shared-oxc:typecheck",
    );
    expect(packageJson.scripts["check:templates:shared-oxc"]).not.toContain(
      "pnpm --dir templates/shared/oxc",
    );
    expect(packageJson.scripts).toMatchObject({
      "check:templates:shared-oxc:format":
        "oxfmt --list-different templates/shared/oxc",
      "check:templates:shared-oxc:lint":
        "oxlint --quiet --format=unix --config templates/shared/oxc/node/oxlint.config.ts templates/shared/oxc",
      "check:templates:shared-oxc:typecheck":
        "tsc -p templates/shared/oxc/tsconfig.json --noEmit --pretty false",
    });

    const workspaceYaml = await readFile(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(workspaceYaml).not.toContain("templates/shared/oxc");
    await expect(
      readFile(
        path.join(
          repoRoot,
          "packages/builtin-source/templates/shared/oxc/package.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await execa("pnpm", ["run", "check:templates:shared-oxc"], {
      cwd: repoRoot,
    });
  });

  it("runs direct template source checks from Root Check", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );
    const builtinSourcePackageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/builtin-source/package.json"),
      packageJsonWithScriptsSchema,
    );
    const checksPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "packages/checks/package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(rootPackageJson.scripts).toHaveProperty("check:templates");
    expect(rootPackageJson.scripts.check).toContain("check:templates");
    expect(rootPackageJson.scripts.check).not.toContain("check:fixtures");
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "turbo run check:templates --output-logs=errors-only --log-order=grouped",
    );
    expect(builtinSourcePackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:shared-oxc",
    );
    expect(builtinSourcePackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:static-source",
    );
    expect(checksPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:github-yaml",
    );
    expect(checksPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:boundary",
    );
  });

  it("runs whole-repository format checks from Root Check", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(rootPackageJson.scripts).toHaveProperty("check:format");
    expect(rootPackageJson.scripts.check).toContain("format:check");
    expect(rootPackageJson.scripts.check).not.toContain("check:fixtures");
    expect(rootPackageJson.scripts["check:format"]).toBe(
      "pnpm run format:check",
    );
    expect(rootPackageJson.scripts["format:check"]).toBe(
      "turbo run format:check format:check:root --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts["format:check:root"]).toBe(
      "oxfmt --list-different --config oxfmt.config.ts package.json pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.build.json tsconfig.json vitest.config.ts oxfmt.config.ts oxlint.config.ts test packages/builtin-source/templates/*/behavior.test.ts",
    );
  });

  it("runs whole-repository lint checks from the root OXC config", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    const rootOxlintConfig = await readFile(
      path.join(repoRoot, "oxlint.config.ts"),
      "utf8",
    );
    expect(rootOxlintConfig).toContain("typeAware: true");
    expect(rootOxlintConfig).toContain('correctness: "error"');
    expect(rootOxlintConfig).toContain('suspicious: "warn"');
    expect(rootOxlintConfig).not.toContain('"no-unused-vars"');
    await expect(
      readFile(path.join(repoRoot, "oxfmt.config.ts"), "utf8"),
    ).resolves.toContain("sortImports: true");

    expect(rootPackageJson.scripts).toHaveProperty("check:lint");
    expect(rootPackageJson.scripts.check).toContain("lint");
    expect(rootPackageJson.scripts["check:lint"]).toBe("pnpm run lint");
    expect(rootPackageJson.scripts.lint).toBe(
      "turbo run lint lint:root --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts["lint:root"]).toBe(
      "oxlint --quiet --format=unix --config oxlint.config.ts oxlint.config.ts oxfmt.config.ts vitest.config.ts test packages/builtin-source/templates/*/behavior.test.ts",
    );
  });

  it("models repository checks as Turbo tasks", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );
    const turboConfig = await readJsonWithSchema(
      path.join(repoRoot, "turbo.json"),
      turboConfigSchema,
    );

    expect(rootPackageJson.scripts.check).toBe(
      "pnpm run build && pnpm run check:boundaries && turbo run format:check lint typecheck test check:generated check:templates format:check:root lint:root typecheck:root --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts["check:boundaries"]).toBe(
      "turbo boundaries --no-color",
    );
    expect(rootPackageJson.scripts.build).toBe(
      "turbo run build --output-logs=errors-only --log-order=grouped",
    );
    expect(turboConfig.boundaries.tags).toMatchObject({
      "template-checks": {
        dependencies: {
          allow: ["template-core", "template-preset-source", "template-shared"],
        },
      },
      "template-cli": {
        dependencies: {
          allow: [
            "template-checks",
            "template-core",
            "template-preset-source",
            "template-shared",
          ],
        },
      },
      "template-core": {
        dependencies: {
          allow: [
            "template-checks",
            "template-cli",
            "template-preset-source",
            "template-shared",
          ],
        },
      },
      "template-preset-source": {
        dependencies: {
          allow: [
            "template-checks",
            "template-cli",
            "template-core",
            "template-preset-source",
            "template-shared",
          ],
        },
      },
      "template-shared": {
        dependencies: {
          allow: [
            "template-checks",
            "template-cli",
            "template-core",
            "template-preset-source",
          ],
        },
      },
    });
    expect(turboConfig.tasks).toHaveProperty("build");
    expect(turboConfig.tasks).toHaveProperty("format:check");
    expect(turboConfig.tasks).toHaveProperty("lint");
    expect(turboConfig.tasks).toHaveProperty("typecheck");
    expect(turboConfig.tasks).toHaveProperty("//#format:check:root");
    expect(turboConfig.tasks).toHaveProperty("//#lint:root");
    expect(turboConfig.tasks).toHaveProperty("//#typecheck:root");
  });

  it("keeps every internal package covered by format, lint, and typecheck", async () => {
    await expect(
      readFile(path.join(repoRoot, "oxlint.config.ts"), "utf8"),
    ).resolves.toContain("typeAware: true");

    for (const packageName of [
      "builtin-source",
      "checks",
      "cli",
      "core",
      "shared",
    ]) {
      const packageJson = await readJsonWithSchema(
        path.join(repoRoot, "packages", packageName, "package.json"),
        packageJsonWithScriptsSchema,
      );

      expect(packageJson.scripts["format:check"]).toContain(
        "oxfmt --list-different",
      );
      expect(packageJson.scripts.lint).toContain("oxlint");
      expect(packageJson.scripts.typecheck).toBe(
        "tsc -p tsconfig.json --noEmit --pretty false",
      );
      expect(packageJson.devDependencies).toMatchObject({
        "typescript-7": "catalog:template-typescript",
      });
    }
  });

  it("keeps the root TypeScript command owned by the Workspace Orchestration Package", async () => {
    const packageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(packageJson.scripts["typecheck:root"]).toBe(
      "tsc -p tsconfig.json --noEmit --pretty false",
    );
    expect(packageJson.devDependencies).toMatchObject({
      "typescript-7": "catalog:template-typescript",
    });
  });

  it("keeps compiler identities within their template Repository owners", async () => {
    const packageJsonFiles = [
      "package.json",
      "packages/builtin-source/package.json",
      "packages/checks/package.json",
      "packages/cli/package.json",
      "packages/core/package.json",
      "packages/shared/package.json",
    ];

    for (const packageJsonFile of packageJsonFiles) {
      const packageJson = await readJsonWithSchema(
        path.join(repoRoot, packageJsonFile),
        packageJsonWithScriptsSchema,
      );
      const allDependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      if (
        packageJsonFile !== "package.json" &&
        packageJsonFile !== "packages/builtin-source/package.json" &&
        packageJsonFile !== "packages/cli/package.json" &&
        packageJsonFile !== "packages/core/package.json"
      ) {
        expect(allDependencies).not.toHaveProperty("typescript");
      }

      expect(allDependencies).not.toHaveProperty("@typescript/native");
      expect(allDependencies).not.toHaveProperty("@typescript/typescript6");
    }
  });

  it("executes TypeScript 7 through the selected native compiler", async () => {
    const packageNames = [
      "@ykdz/template-repository",
      "@ykdz/template-builtin-source",
      "@ykdz/template-checks",
      "@ykdz/template",
      "@ykdz/template-core",
      "@ykdz/template-shared",
    ];

    for (const packageName of packageNames) {
      const result = await execa(
        "pnpm",
        ["--filter", packageName, "exec", "tsc", "--version"],
        { cwd: repoRoot },
      );
      const versionMatch = /^Version (?<major>\d+)\./.exec(result.stdout);

      expect({ major: versionMatch?.groups?.major, packageName }).toEqual({
        major: "7",
        packageName,
      });
    }
  });

  it("builds compiled Package Exposures before repository checks", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );
    const turboConfig = await readJsonWithSchema(
      path.join(repoRoot, "turbo.json"),
      turboConfigSchema,
    );

    expect(rootPackageJson.scripts.check).toMatch(/^pnpm run build && /);
    expect(turboConfig.tasks.build).toMatchObject({ dependsOn: ["^build"] });

    for (const packageName of ["shared", "core", "builtin-source", "checks"]) {
      const packageJsonSource = await readFile(
        path.join(repoRoot, "packages", packageName, "package.json"),
        "utf8",
      );

      expect(packageJsonSource).not.toContain('"source":');
    }
  });

  it("keeps repository format scripts free of non-standard oxfmt ignore files", async () => {
    const packageJsonFiles = [
      "package.json",
      "packages/cli/package.json",
      "packages/core/package.json",
      "packages/shared/package.json",
      "packages/builtin-source/package.json",
      "packages/checks/package.json",
    ];

    for (const packageJsonFile of packageJsonFiles) {
      const packageJson = await readJsonWithSchema(
        path.join(repoRoot, packageJsonFile),
        packageJsonWithScriptsSchema,
      );

      expect(packageJson.scripts["format:check"]).not.toContain(
        "--ignore-path",
      );
      expect(packageJson.scripts["format:write"]).not.toContain(
        "--ignore-path",
      );
      expect(packageJson.scripts["format:check"]).not.toContain(".oxfmtignore");
      expect(packageJson.scripts["format:write"]).not.toContain(".oxfmtignore");
    }
  });

  it("runs direct Rust template source format checks from Root Check", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:static-source",
    );
    expect(rootPackageJson.scripts["check:templates:static-source"]).toBe(
      "turbo run check:templates:static-source --output-logs=errors-only --log-order=grouped",
    );

    await execa("pnpm", ["run", "check:templates:static-source"], {
      cwd: repoRoot,
    });
  });

  it("runs direct GitHub YAML template source checks from Root Check", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(rootPackageJson.scripts).toHaveProperty(
      "check:templates:github-yaml",
    );
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "turbo run check:templates --output-logs=errors-only --log-order=grouped",
    );
    expect(rootPackageJson.scripts["check:templates:github-yaml"]).toBe(
      "turbo run check:templates:github-yaml --output-logs=errors-only --log-order=grouped",
    );

    await execa("pnpm", ["run", "check:templates:github-yaml"], {
      cwd: repoRoot,
    });
  });

  it("directly validates workflow and Dependabot template source contracts", async () => {
    const rootPackageJson = await readJsonWithSchema(
      path.join(repoRoot, "package.json"),
      packageJsonWithScriptsSchema,
    );

    expect(rootPackageJson.scripts["check:templates:github-yaml"]).toBe(
      "turbo run check:templates:github-yaml --output-logs=errors-only --log-order=grouped",
    );

    await execa("pnpm", ["run", "check:templates:github-yaml"], {
      cwd: repoRoot,
    });
  });

  it("fails when a supported preset is missing checked GitHub YAML template source", async () => {
    const workspace = await mkdirTempTemplateWorkspace();

    await writeValidGithubTemplatePair(workspace, "ts-lib");

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

    await writeValidGithubTemplatePair(workspace, "ts-lib");
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

  return projectionPlan
    ? projectCheckWorkflow({
        checkPlan: projectionPlan.checkPlan,
        environmentPreparation:
          presetName === "rust-bin" ? { rustToolchain: true } : undefined,
      })
    : missingProjectedGithubTemplate(presetName, "workflow");
}

function validDependabotTemplateForPreset(
  presetName: "ts-lib" | "rust-bin",
): string {
  const projectionPlan = projectThroughPresetProjection(presetName);

  return projectionPlan
    ? projectDependabotConfig(projectionPlan.dependencyMaintenancePolicy)
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
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.34.4" },
      source: "bundled-fallback",
      diagnostics: [],
    },
  });
}

async function listTypeScriptSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptSourceFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files.toSorted();
}

type TemplateModuleReference = {
  readonly specifier: string;
  readonly verb: "imports" | "exports from" | "dynamically imports";
};

function templateModuleReferenceDiagnostics(options: {
  readonly sourceFilePath: string;
  readonly sourceText: string;
}): string[] {
  return templateModuleReferences(options.sourceText)
    .filter((reference) =>
      resolvesToTemplateModule(options.sourceFilePath, reference.specifier),
    )
    .map(
      (reference) =>
        `${path.relative(repoRoot, options.sourceFilePath)} ${reference.verb} ${reference.specifier}`,
    );
}

function templateModuleReferences(
  sourceText: string,
): TemplateModuleReference[] {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const references: TemplateModuleReference[] = [];

  function addModuleSpecifier(
    specifier: ts.Expression | undefined,
    verb: TemplateModuleReference["verb"],
  ): void {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      references.push({ specifier: specifier.text, verb });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier, "imports");
    }

    if (ts.isExportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier, "exports from");
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      addModuleSpecifier(node.arguments[0], "dynamically imports");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return references;
}

function resolvesToTemplateModule(
  sourceFilePath: string,
  specifier: string,
): boolean {
  if (
    specifier === "@ykdz/template-builtin-source/registry" ||
    specifier === "@ykdz/template-builtin-source/projection-plans" ||
    specifier.startsWith("@ykdz/template-builtin-source/templates/")
  ) {
    return true;
  }

  if (!specifier.startsWith(".")) {
    return false;
  }

  const resolved = path.resolve(path.dirname(sourceFilePath), specifier);
  const relative = path.relative(repoRoot, resolved).split(path.sep).join("/");

  return (
    relative === "packages/builtin-source/templates" ||
    relative.startsWith("packages/builtin-source/templates/")
  );
}

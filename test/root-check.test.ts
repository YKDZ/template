import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { checkTemplateGithubYaml } from "../scripts/check-template-github-yaml.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Project Kit Root Check", () => {
  it("invokes built-in preset fixture checks", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toHaveProperty("check:fixtures");
    expect(packageJson.scripts.check).toContain("pnpm run check:fixtures");
  });

  it("keeps ordinary checks separate from npm publishing", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    const ordinaryCheckScripts = [packageJson.scripts.check, packageJson.scripts["check:fixtures"]];

    for (const script of ordinaryCheckScripts) {
      expect(script).not.toMatch(/\bnpm\s+publish\b/);
      expect(script).not.toContain("NPM_TOKEN");
      expect(script).not.toContain("NODE_AUTH_TOKEN");
    }
  });

  it("runs direct shared OXC template source checks from Root Check", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const sharedOxcPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "templates/shared/oxc/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty("check:templates:shared-oxc");
    expect(rootPackageJson.scripts["check:templates"]).toContain(
      "pnpm run check:templates:shared-oxc",
    );
    expect(rootPackageJson.scripts["check:templates:shared-oxc"]).toBe(
      "pnpm --dir templates/shared/oxc run check",
    );
    expect(sharedOxcPackageJson.scripts.check).toContain("pnpm run format:check");
    expect(sharedOxcPackageJson.scripts.check).toContain("pnpm run lint");
    expect(sharedOxcPackageJson.scripts.check).toContain("pnpm run typecheck");

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
    expect(rootPackageJson.scripts.check.indexOf("pnpm run check:templates")).toBeLessThan(
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

    expect(rootPackageJson.scripts).toHaveProperty("check:templates:static-source");
    expect(rootPackageJson.scripts["check:templates:static-source"]).toBe(
      "oxfmt --check templates && rustfmt --check templates/rust-bin/src/main.rs",
    );

    await execa("pnpm", ["run", "check:templates:static-source"], {
      cwd: repoRoot,
    });
  });

  it("runs direct GitHub YAML template source checks from Root Check", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackageJson.scripts).toHaveProperty("check:templates:github-yaml");
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
      ["name: Check", "on:", "  push:", "jobs:", "  check: ubuntu-latest", ""].join("\n"),
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
      ["name: Check", "on:", "  push:", "jobs:", "  check:", "    steps: []", ""].join("\n"),
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
});

async function mkdirTempTemplateWorkspace(): Promise<string> {
  return await mkdtemp(path.join(repoRoot, ".scratch/root-check-test-"));
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
  presetName: string,
  ecosystem: "npm" | "cargo",
): Promise<void> {
  await writeTemplateFile(
    workspace,
    `${presetName}/.github/workflows/check.yml`,
    validWorkflowTemplate(),
  );
  await writeTemplateFile(
    workspace,
    `${presetName}/.github/dependabot.yml`,
    validDependabotTemplate(ecosystem),
  );
}

function validWorkflowTemplate(): string {
  return [
    "name: Check",
    "on:",
    "  push:",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "",
  ].join("\n");
}

function validDependabotTemplate(ecosystem: "npm" | "cargo"): string {
  return [
    "version: 2",
    "updates:",
    "  - package-ecosystem: github-actions",
    "    directory: /",
    "    schedule:",
    "      interval: weekly",
    `  - package-ecosystem: ${ecosystem}`,
    "    directory: /",
    "    schedule:",
    "      interval: weekly",
    "",
  ].join("\n");
}

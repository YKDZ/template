import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { vueHonoAppPresetProjection } from "./projection.ts";

const playwrightCliPackage = `@playwright/test@${
  loadTemplateDependencyCatalog()["@playwright/test"]
}`;
const packageJsonSchema = v.looseObject({
  name: v.string(),
  engines: v.object({ node: v.string() }),
  packageManager: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  scripts: v.record(v.string(), v.string()),
});
const devcontainerSchema = v.looseObject({
  build: v.object({
    dockerfile: v.string(),
    args: v.record(v.string(), v.string()),
  }),
  customizations: v.object({
    vscode: v.object({
      extensions: v.array(v.string()),
      settings: v.record(v.string(), v.unknown()),
    }),
  }),
  features: v.optional(v.unknown()),
  postCreateCommand: v.optional(v.string()),
});

async function readJsonWithSchema<const Schema extends v.GenericSchema>(
  filePath: string,
  schema: Schema,
): Promise<v.InferOutput<Schema>> {
  return v.parse(
    schema,
    JSON.parse(await readFile(filePath, "utf8")) as unknown,
  );
}

async function generatedFilePaths(
  root: string,
  current = ".",
): Promise<string[]> {
  const entries = await readdir(path.join(root, current), {
    withFileTypes: true,
  });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return generatedFilePaths(root, relativePath);
      }

      return [relativePath.replaceAll(path.sep, "/")];
    }),
  );

  return paths.flat().toSorted();
}

async function renderVueHonoProject(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "vue-hono-behavior-"));
  const targetDir = path.join(workspace, "demo-stack");
  const blueprint = vueHonoAppPresetProjection.blueprint({
    targetDir,
    scope: "acme",
  });
  const context = assembleGenerationContext({
    blueprint,
    targetDir,
    toolchain: {
      diagnostics: [],
      nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
      packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
      source: "online",
    },
  });

  const plan = vueHonoAppPresetProjection.project(context);
  await vueHonoAppPresetProjection.render({ plan, targetDir });

  return targetDir;
}

describe("vue-hono-app Preset Source behavior", () => {
  it("projects separated API and web packages with browser-scoped checks", async () => {
    const targetDir = await renderVueHonoProject();
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const apiPackageJson = await readJsonWithSchema(
      path.join(targetDir, "apps/api/package.json"),
      packageJsonSchema,
    );
    const webPackageJson = await readJsonWithSchema(
      path.join(targetDir, "apps/web/package.json"),
      packageJsonSchema,
    );
    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainer = v.parse(
      devcontainerSchema,
      JSON.parse(devcontainerText) as unknown,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const files = await generatedFilePaths(targetDir);
    const apiServerSource = await readFile(
      path.join(targetDir, "apps/api/src/server.ts"),
      "utf8",
    );
    const apiTsconfig = await readJsonWithSchema(
      path.join(targetDir, "apps/api/tsconfig.json"),
      v.object({
        compilerOptions: v.record(v.string(), v.unknown()),
        include: v.array(v.string()),
      }),
    );

    expect(rootPackageJson).toMatchObject({
      name: "demo-stack",
      engines: { node: "24" },
      packageManager: "pnpm@11.2.3",
    });
    expect(rootPackageJson.scripts).toMatchObject({
      check:
        "pnpm run check:boundaries && turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
      dev: "turbo run dev --parallel",
    });
    expect(rootPackageJson.devDependencies?.turbo).toBe("catalog:");
    expect(rootPackageJson.devDependencies).toHaveProperty(
      "typescript-7",
      "catalog:",
    );
    expect(rootPackageJson.devDependencies).not.toHaveProperty("typescript");
    expect(workspaceYaml).toContain("packages:\n  - apps/*\n");
    expect(workspaceYaml).toContain("allowBuilds:\n  esbuild: true\n");
    expect(workspaceYaml).toContain('"@hono/node-server":');
    expect(workspaceYaml).toContain('"@playwright/test":');
    expect(workspaceYaml).toContain("vue:");
    expect(apiPackageJson).toMatchObject({
      name: "@acme/api",
      engines: { node: "24" },
    });
    expect(apiPackageJson).not.toHaveProperty("packageManager");
    expect(apiPackageJson.scripts).not.toHaveProperty("check");
    expect(apiPackageJson.scripts.dev).toBe("node --watch src/server.ts");
    expect(apiPackageJson.devDependencies).toHaveProperty(
      "typescript-7",
      "catalog:",
    );
    expect(apiPackageJson.devDependencies).not.toHaveProperty("typescript");
    expect(apiPackageJson.devDependencies).not.toHaveProperty("tsx");
    expect(apiServerSource).toContain('from "./runtime.ts"');
    expect(apiServerSource).not.toContain('from "./runtime.js"');
    expect(apiTsconfig.compilerOptions).toHaveProperty(
      "rewriteRelativeImportExtensions",
      true,
    );
    expect(apiPackageJson.scripts["build:run"]).toBe(
      "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    );
    expect(webPackageJson).toMatchObject({
      name: "@acme/web",
      engines: { node: "24" },
    });
    expect(webPackageJson).not.toHaveProperty("packageManager");
    expect(webPackageJson.scripts).not.toHaveProperty("check");
    expect(webPackageJson.scripts["test:e2e:run"]).toBe(
      "node scripts/run-playwright.ts",
    );
    expect(webPackageJson.scripts["typecheck:run"]).toBe(
      "node scripts/run-vue-tsc.ts --build --pretty false",
    );
    expect(webPackageJson.devDependencies).toHaveProperty(
      "typescript",
      "catalog:",
    );
    expect(webPackageJson.devDependencies).not.toHaveProperty("typescript-7");

    expect(Object.keys(devcontainer).toSorted()).toEqual([
      "build",
      "customizations",
      "name",
    ]);
    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
        PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage,
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer).not.toHaveProperty("postCreateCommand");
    expect(devcontainer.customizations.vscode.extensions).toContain(
      "Vue.volar",
    );
    expect(devcontainer.customizations.vscode.settings).toHaveProperty(
      "oxc.configPath",
      "./oxlint.config.ts",
    );
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "demo-stack",\n  "build": \{/,
    );
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(dockerfile).toContain(
      'npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium',
    );
    expect(dockerfile).not.toContain(
      "npx --yes playwright install-deps chromium",
    );
    expect(dockerfile).not.toContain("typescript-node");
    expect(dockerfile).not.toContain("shellcheck");
    expect(dockerfile).not.toMatch(/\b(?:npm|pnpm|corepack)\s+.*-g\s+turbo\b/);
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
    expect(checkWorkflow).not.toMatch(/\bpnpm exec playwright install\b/);
    expect(checkWorkflow).not.toContain("shellcheck");
    expect(files).not.toContain("behavior.test.ts");
    expect(files).not.toContain("apps/api/behavior.test.ts");
    expect(files).not.toContain("apps/web/behavior.test.ts");
  });
});

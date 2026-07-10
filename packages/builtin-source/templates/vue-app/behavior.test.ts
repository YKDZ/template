import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { vueAppPresetProjection } from "./projection.js";

const playwrightCliPackage = `@playwright/test@${
  loadTemplateDependencyCatalog()["@playwright/test"]
}`;
const devcontainerSchema = v.looseObject({
  build: v.object({
    args: v.record(v.string(), v.string()),
    dockerfile: v.string(),
  }),
  customizations: v.object({
    vscode: v.object({
      extensions: v.array(v.string()),
      settings: v.record(v.string(), v.unknown()),
    }),
  }),
  features: v.optional(v.unknown()),
  name: v.string(),
});
const packageJsonSchema = v.looseObject({
  name: v.string(),
  exports: v.optional(v.unknown()),
  packageManager: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
  scripts: v.record(v.string(), v.string()),
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

describe("vue-app Preset Source behavior", () => {
  async function renderVueAppProject(): Promise<string> {
    const targetDir = await mkdtemp(
      path.join(tmpdir(), "template-vue-app-behavior-"),
    );
    const blueprint = vueAppPresetProjection.blueprint({ targetDir });
    const context = assembleGenerationContext({
      blueprint,
      targetDir,
      toolchain: {
        diagnostics: [],
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: {
          kind: "PackageManagerPin",
          value: "pnpm@11.2.3",
        },
        source: "online",
      },
    });

    const plan = vueAppPresetProjection.project(context);
    await vueAppPresetProjection.render({ plan, targetDir });

    return targetDir;
  }

  it("projects browser-check development container behavior without projecting Preset Source Tests", async () => {
    const targetDir = await renderVueAppProject();
    const devcontainerText = await readFile(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      "utf8",
    );
    const devcontainerRaw = JSON.parse(devcontainerText) as Record<
      string,
      unknown
    >;
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const files = await generatedFilePaths(targetDir);

    expect(Object.keys(devcontainerRaw)).toEqual([
      "name",
      "build",
      "customizations",
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
    expect(devcontainer.customizations.vscode.extensions).toContain(
      "Vue.volar",
    );
    expect(devcontainer.customizations.vscode.settings).toHaveProperty(
      "oxc.enable",
      true,
    );
    expect(devcontainerText).toMatch(
      /^\{\n  "name": "template-vue-app-behavior-[\w-]+",\n  "build": \{/,
    );
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(dockerfile).toContain(
      'npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium',
    );
    expect(dockerfile).not.toContain(
      "npx --yes playwright install-deps chromium",
    );
    expect(dockerfile).toContain(
      'corepack enable --install-directory "$PNPM_HOME"',
    );
    expect(dockerfile).not.toContain("libnss3");
    expect(dockerfile).not.toContain("libgbm1");
    expect(dockerfile).not.toContain("xvfb");
    expect(dockerfile).not.toContain("npm install -g");
    expect(files).not.toContain("behavior.test.ts");
    expect(files).not.toContain("apps/web/behavior.test.ts");
  });

  it("projects a Vue workspace app with browser test package ownership", async () => {
    const targetDir = await renderVueAppProject();
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const webPackageJson = await readJsonWithSchema(
      path.join(targetDir, "apps/web/package.json"),
      packageJsonSchema,
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const rootTsconfig = await readJsonWithSchema(
      path.join(targetDir, "tsconfig.json"),
      v.object({
        files: v.array(v.string()),
        references: v.array(v.object({ path: v.string() })),
      }),
    );
    const appSource = await readFile(
      path.join(targetDir, "apps/web/src/App.vue"),
      "utf8",
    );

    expect(rootPackageJson.name).toMatch(/^template-vue-app-behavior-/);
    expect(rootPackageJson).not.toHaveProperty("exports");
    expect(rootPackageJson.devDependencies).toEqual({
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      turbo: "catalog:",
      typescript: "catalog:",
    });
    expect(rootPackageJson.scripts.check).toContain("turbo run");
    expect(rootPackageJson.scripts.fix).toContain("turbo run");

    expect(webPackageJson.name).toMatch(
      /^@template-vue-app-behavior-[\w-]+\/web$/,
    );
    expect(webPackageJson).not.toHaveProperty("packageManager");
    expect(webPackageJson.scripts).not.toHaveProperty("check");
    expect(webPackageJson.scripts["test:e2e:run"]).toBe(
      "node --experimental-strip-types scripts/run-playwright.ts",
    );
    expect(webPackageJson.scripts["typecheck:run"]).toBe(
      "vue-tsc --build --noEmit --pretty false",
    );
    expect(webPackageJson.dependencies).toMatchObject({
      pinia: "catalog:",
      vue: "catalog:",
    });
    expect(webPackageJson.devDependencies).toMatchObject({
      "@playwright/test": "catalog:",
      "@types/web-bluetooth": "catalog:",
      "@vitejs/plugin-vue": "catalog:",
      "@vue/tsconfig": "catalog:",
      vite: "catalog:",
      vitest: "catalog:",
    });
    expect(webPackageJson.imports).toEqual({
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    });
    expect(webPackageJson.dependencies).not.toHaveProperty("vue-router");
    expect(webPackageJson.dependencies).not.toHaveProperty("shadcn-vue");
    expect(workspaceYaml).toContain("packages:\n  - apps/*\n");
    expect(workspaceYaml).toContain("allowBuilds:\n  esbuild: true\n");
    expect(workspaceYaml).toContain('"@playwright/test":');
    expect(workspaceYaml).toContain("vue:");
    expect(rootTsconfig.files).toEqual([]);
    expect(rootTsconfig.references).toEqual([
      { path: "./apps/web/tsconfig.app.json" },
      { path: "./apps/web/tsconfig.test.json" },
      { path: "./apps/web/tsconfig.node.json" },
    ]);
    expect(appSource).toContain('from "#/stores/counter"');
  });
});

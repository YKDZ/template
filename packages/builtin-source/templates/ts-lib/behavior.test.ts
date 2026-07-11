import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { tsLibPresetProjection } from "./projection.ts";

const packageJsonSchema = v.looseObject({
  name: v.string(),
  private: v.boolean(),
  type: v.optional(v.string()),
  imports: v.optional(v.unknown()),
  exports: v.optional(v.unknown()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.record(v.string(), v.string()),
  engines: v.object({ node: v.string() }),
  packageManager: v.optional(v.string()),
  scripts: v.record(v.string(), v.string()),
});
const workspaceCatalogSchema = v.object({
  packages: v.array(v.string()),
  catalog: v.record(v.string(), v.string()),
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

async function renderTsLibProject(): Promise<string> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-ts-lib-behavior-"),
  );
  const targetDir = path.join(workspace, "demo-lib");
  const blueprint = tsLibPresetProjection.blueprint({ targetDir });
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

  const plan = tsLibPresetProjection.project(context);
  await tsLibPresetProjection.render({ plan, targetDir });

  return targetDir;
}

function catalogReferences(packageJson: {
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
}): string[] {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ].toSorted();
}

describe("ts-lib Preset Source behavior", () => {
  it("projects a strict TypeScript library workspace without Preset Source Tests", async () => {
    const targetDir = await renderTsLibProject();
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const libraryPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/demo-lib/package.json"),
      packageJsonSchema,
    );
    const workspaceYaml = await readFile(
      path.join(targetDir, "pnpm-workspace.yaml"),
      "utf8",
    );
    const workspace = v.parse(
      workspaceCatalogSchema,
      parseYaml(workspaceYaml) as unknown,
    );
    const tsconfig = await readJsonWithSchema(
      path.join(targetDir, "packages/demo-lib/tsconfig.json"),
      v.object({
        compilerOptions: v.record(v.string(), v.unknown()),
        include: v.array(v.string()),
      }),
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const files = await generatedFilePaths(targetDir);

    expect(rootPackageJson).toMatchObject({
      name: "demo-lib",
      private: true,
      engines: { node: "24" },
      packageManager: "pnpm@11.2.3",
    });
    expect(rootPackageJson.devDependencies).toEqual({
      "@types/node": "catalog:",
      "@types/semver": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      semver: "catalog:",
      turbo: "catalog:",
      "typescript-7": "catalog:",
    });
    expect(rootPackageJson.scripts.check).toContain("turbo run");
    expect(rootPackageJson.scripts["typecheck:run"]).toBe(
      "tsc -p tsconfig.config.json --noEmit --pretty false",
    );

    expect(libraryPackageJson).toMatchObject({
      name: "@demo-lib/demo-lib",
      private: true,
      type: "module",
      engines: { node: "24" },
    });
    expect(libraryPackageJson.packageManager).toBeUndefined();
    expect(libraryPackageJson.dependencies).toEqual({
      valibot: "catalog:",
    });
    expect(libraryPackageJson.devDependencies).toEqual({
      "@types/node": "catalog:",
      oxfmt: "catalog:",
      oxlint: "catalog:",
      "oxlint-tsgolint": "catalog:",
      "typescript-7": "catalog:",
    });
    expect(libraryPackageJson.devDependencies).not.toHaveProperty("tsc-alias");
    expect(libraryPackageJson.exports).toEqual({
      ".": {
        default: "./src/index.ts",
        types: "./src/index.ts",
      },
    });
    expect(libraryPackageJson.imports).toEqual({
      "#/*": {
        default: "./src/*.ts",
        types: "./src/*.ts",
      },
    });
    expect(libraryPackageJson.scripts).not.toHaveProperty("build");
    expect(libraryPackageJson.scripts["typecheck:run"]).toBe(
      "tsc -p tsconfig.json --noEmit --pretty false",
    );
    expect(tsconfig.compilerOptions).not.toHaveProperty("paths");
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);

    expect(workspace.packages).toEqual(["packages/*"]);
    expect(workspace.catalog).toMatchObject({
      "typescript-7": "npm:typescript@^7.0.2",
    });
    expect(workspace.catalog).not.toHaveProperty("typescript");
    expect(Object.keys(workspace.catalog).toSorted()).toEqual(
      [
        ...new Set([
          ...catalogReferences(rootPackageJson),
          ...catalogReferences(libraryPackageJson),
        ]),
      ].toSorted(),
    );
    expect(Object.values(rootPackageJson.devDependencies)).toEqual(
      expect.arrayContaining(["catalog:"]),
    );
    expect(Object.values(libraryPackageJson.devDependencies)).toEqual(
      expect.arrayContaining(["catalog:"]),
    );

    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(devcontainer.customizations.vscode.extensions).toContain(
      "oxc.oxc-vscode",
    );
    expect(devcontainer.customizations.vscode.extensions).not.toContain(
      "dbaeumer.vscode-eslint",
    );
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain(
      'corepack enable --install-directory "$PNPM_HOME"',
    );
    expect(dockerfile).not.toContain("PLAYWRIGHT_CLI_PACKAGE");
    expect(dockerfile).not.toContain("shellcheck");
    expect(dockerfile).not.toContain("typescript-node");
    expect(dockerfile).not.toMatch(
      /npm install -g|pnpm add -g|corepack prepare (?!"?\$\{PACKAGE_MANAGER_PIN\}"?)/,
    );
    expect(files).not.toContain("behavior.test.ts");
    expect(files).not.toContain("packages/demo-lib/behavior.test.ts");
  });
});

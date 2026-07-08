import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTemplateDependencyCatalog } from "@ykdz/template-core/dependency-catalog";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { vikeAppPresetProjection } from "./projection.js";

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

async function renderVikeProject(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "vike-behavior-"));
  const targetDir = path.join(workspace, "demo-vike");
  const blueprint = vikeAppPresetProjection.blueprint({ targetDir });
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

  const plan = vikeAppPresetProjection.project(context);
  await vikeAppPresetProjection.render({ plan, targetDir });

  return targetDir;
}

describe("vike-app Preset Source behavior", () => {
  it("projects a Vike web app with a linked database workspace package", async () => {
    const targetDir = await renderVikeProject();
    const rootPackageJson = await readJsonWithSchema(
      path.join(targetDir, "package.json"),
      packageJsonSchema,
    );
    const webPackageJson = await readJsonWithSchema(
      path.join(targetDir, "apps/web/package.json"),
      packageJsonSchema,
    );
    const dbPackageJson = await readJsonWithSchema(
      path.join(targetDir, "packages/db/package.json"),
      packageJsonSchema,
    );
    const appTsconfig = await readJsonWithSchema(
      path.join(targetDir, "apps/web/tsconfig.app.json"),
      v.object({ include: v.array(v.string()) }),
    );
    const webTsconfig = await readJsonWithSchema(
      path.join(targetDir, "apps/web/tsconfig.json"),
      v.object({ references: v.array(v.object({ path: v.string() })) }),
    );
    const devcontainer = await readJsonWithSchema(
      path.join(targetDir, ".devcontainer/devcontainer.json"),
      devcontainerSchema,
    );
    const dockerfile = await readFile(
      path.join(targetDir, ".devcontainer/Dockerfile"),
      "utf8",
    );
    const checkWorkflow = await readFile(
      path.join(targetDir, ".github/workflows/check.yml"),
      "utf8",
    );
    const files = await generatedFilePaths(targetDir);

    expect(rootPackageJson).toMatchObject({
      name: "demo-vike",
      engines: { node: "24" },
      packageManager: "pnpm@11.2.3",
    });
    expect(webPackageJson).toMatchObject({
      name: "@demo-vike/web",
      engines: { node: "24" },
    });
    expect(webPackageJson.dependencies).toHaveProperty(
      "@demo-vike/db",
      "workspace:*",
    );
    expect(webPackageJson.scripts["lint:run"]).toBe(
      "oxlint --quiet --format=unix --type-aware --config ../../oxlint.config.ts .",
    );
    expect(webPackageJson.scripts["lint:fix:run"]).toBe(
      "oxlint --type-aware --format=unix --config ../../oxlint.config.ts . --fix",
    );
    expect(dbPackageJson).toMatchObject({
      name: "@demo-vike/db",
      engines: { node: "24" },
      dependencies: { "drizzle-orm": "catalog:" },
    });
    expect(dbPackageJson.scripts["typecheck:run"]).toBe(
      "tsc -p tsconfig.json --noEmit --pretty false",
    );
    expect(appTsconfig.include).toContain("types/**/*.d.ts");
    expect(webTsconfig.references).toEqual(
      expect.arrayContaining([{ path: "../../packages/db" }]),
    );
    expect(files).toContain("apps/web/types/env.d.ts");
    expect(files).toContain("apps/web/types/global.d.ts");
    expect(files).not.toContain("env.d.ts");
    expect(files).not.toContain("global.d.ts");
    expect(files).not.toContain("behavior.test.ts");
    expect(files).not.toContain("apps/web/behavior.test.ts");
    expect(files).not.toContain("packages/db/behavior.test.ts");

    expect(devcontainer.build).toEqual({
      dockerfile: "Dockerfile",
      args: {
        NODE_VERSION: "24",
        PACKAGE_MANAGER_PIN: "pnpm@11.2.3",
        PLAYWRIGHT_CLI_PACKAGE: playwrightCliPackage,
      },
    });
    expect(devcontainer).not.toHaveProperty("features");
    expect(dockerfile).toContain("FROM node:${NODE_VERSION}-bookworm-slim");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_CLI_PACKAGE");
    expect(checkWorkflow).toContain(
      "pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
  });
});

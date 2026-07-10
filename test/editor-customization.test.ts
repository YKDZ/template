import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  builtInPresetProjectionSourceRoots,
  loadBuiltInPresetSourceManifest,
} from "@ykdz/template-builtin-source";
import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import {
  editorCustomizationForCapabilities,
  loadEditorCustomizationDeclarations,
  type EditorCustomizationCapability,
  type EditorCustomizationOptions,
} from "@ykdz/template-core/editor-customization";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import { interpretPresetProjectionDeclaration } from "@ykdz/template-core/projection-capabilities";
import { renderProject } from "@ykdz/template-core/renderer";
import * as v from "valibot";

const settingsSchema = v.record(v.string(), v.unknown());
const devcontainerEditorCustomizationSchema = v.object({
  customizations: v.object({
    vscode: v.object({
      extensions: v.array(v.string()),
      settings: settingsSchema,
    }),
  }),
});
const workspaceExtensionsSchema = v.object({
  recommendations: v.array(v.string()),
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

async function readDevcontainerEditorCustomization(filePath: string) {
  return readJsonWithSchema(filePath, devcontainerEditorCustomizationSchema);
}

async function readWorkspaceExtensions(filePath: string) {
  return readJsonWithSchema(filePath, workspaceExtensionsSchema);
}

async function readWorkspaceSettings(filePath: string) {
  return readJsonWithSchema(filePath, settingsSchema);
}

async function renderPresetProject(preset: string): Promise<string> {
  const projection = findBuiltInPresetProjection(preset);
  if (!projection) {
    throw new Error(`Unknown built-in preset: ${preset}`);
  }

  const targetRoot = await mkdtemp(
    path.join(tmpdir(), "editor-customization-"),
  );
  const blueprint = projection.blueprint({ targetDir: targetRoot });
  const plan = projection.project(
    assembleGenerationContext({
      targetDir: targetRoot,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@10.34.4" },
        source: "bundled-fallback",
        diagnostics: [],
      },
    }),
  );

  await renderProject({
    sourceRoot: plan.sourceRoot,
    sourceRoots: plan.sourceRoots,
    targetRoot,
    operations: [...plan.operations],
  });

  return targetRoot;
}

function oxcConfigPathSettings(
  settings: Record<string, unknown>,
): { key: string; value: string }[] {
  return Object.entries(settings)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("oxc.") &&
        entry[0].endsWith("configPath") &&
        typeof entry[1] === "string",
    )
    .map(([key, value]) => ({ key, value }));
}

const forbiddenOptionalExtensions = [
  "vadimcn.vscode-lldb",
  "serayuzgur.crates",
  "redhat.vscode-yaml",
  "fill-labs.dependi",
  "selemondev.shadcn-vue",
] as const;

function builtInEditorCustomizationResourcePath(): string {
  const resourcePath = builtInPresetProjectionSourceRoots().sharedResource(
    "shared-editor-customization",
  );

  if (resourcePath === undefined) {
    throw new Error("Missing built-in Editor Customization Shared Resource");
  }

  return resourcePath;
}

const builtInEditorCustomizationDeclarations =
  loadEditorCustomizationDeclarations(builtInEditorCustomizationResourcePath());

function builtInEditorCustomizationForCapabilities(
  capabilities: readonly EditorCustomizationCapability[],
  options?: EditorCustomizationOptions,
) {
  return editorCustomizationForCapabilities(
    capabilities,
    builtInEditorCustomizationDeclarations,
    options,
  );
}

function expectForbiddenOptionalExtensionsAbsent(
  extensions: readonly string[],
): void {
  for (const extension of forbiddenOptionalExtensions) {
    expect(extensions).not.toContain(extension);
  }
}

function supportedPresetNamesWithOxcFormatLint(): string[] {
  return loadBuiltInPresetSourceManifest()
    .presets.filter(
      (preset) =>
        preset.generation === "supported" &&
        (preset.projection?.capabilities ?? []).some(
          (capability) => capability.kind === "oxc-format-lint",
        ),
    )
    .map((preset) => preset.name);
}

describe("editor customization", () => {
  it("projects editor settings from a Preset Source-local Shared Resource id", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "editor-customization-resource-boundary-"),
    );
    const devcontainerResource = path.join(workspace, "local-devcontainer");
    const editorResource = path.join(workspace, "local-capabilities.json");

    await mkdir(devcontainerResource, { recursive: true });
    await writeFile(
      path.join(devcontainerResource, "node-pnpm.Dockerfile"),
      [
        "ARG NODE_VERSION",
        "FROM node:${NODE_VERSION}-bookworm-slim",
        "ARG PACKAGE_MANAGER_PIN",
        'corepack enable --install-directory "$PNPM_HOME"',
        "",
      ].join("\n"),
    );
    await writeFile(
      editorResource,
      `${JSON.stringify(
        {
          capabilities: {
            "oxc-format-lint": {
              extensions: ["acme.local-oxc"],
              settings: { "acme.localOxc": true },
            },
            vue: { extensions: [], settings: {} },
            tailwind: { extensions: [], settings: {} },
            "rust-tooling": { extensions: [], settings: {} },
            vitest: { extensions: [], settings: {} },
          },
        },
        null,
        2,
      )}\n`,
    );

    const plan = interpretPresetProjectionDeclaration({
      preset: {
        name: "custom-lib",
        title: "Custom library",
        description: "Custom library.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: "unsupported",
        features: [
          "strict-typescript",
          "oxc-format-lint",
          "devcontainer",
          "github-actions",
          "dependabot",
        ],
      },
      declaration: {
        capabilities: [
          {
            kind: "workspace-library-package",
            workspacePackageGlob: "packages/*",
            packageRole: "shared-library",
            packageSourcePreset: "ts-lib",
            sourceFiles: ["src/index.ts"],
          },
          { kind: "strict-typescript-root" },
          {
            kind: "oxc-format-lint",
            editorCustomizationResourceId: "local-editor-resource",
          },
          {
            kind: "node-pnpm-devcontainer",
            devcontainerResourceId: "local-devcontainer",
          },
          { kind: "github-maintenance" },
        ],
      },
      context: assembleGenerationContext({
        targetDir: path.join(workspace, "generated"),
        blueprint: {
          schemaVersion: 1,
          preset: "custom-lib",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: [],
        },
        toolchain: {
          nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
          packageManagerPin: {
            kind: "PackageManagerPin",
            value: "pnpm@10.34.4",
          },
          source: "bundled-fallback",
          diagnostics: [],
        },
      }),
      sourceRoots: {
        preset: () => workspace,
        sharedOxc: () => workspace,
        sharedResource: (resourceId) =>
          resourceId === "local-editor-resource"
            ? editorResource
            : resourceId === "local-devcontainer"
              ? devcontainerResource
              : undefined,
      },
    });
    const extensionsOperation = plan.operations.find(
      (operation) =>
        operation.kind === "writeJson" &&
        operation.to === ".vscode/extensions.json",
    );
    const settingsOperation = plan.operations.find(
      (operation) =>
        operation.kind === "writeJson" &&
        operation.to === ".vscode/settings.json",
    );

    expect(extensionsOperation).toMatchObject({
      value: { recommendations: ["acme.local-oxc"] },
    });
    expect(settingsOperation).toMatchObject({
      value: {
        "acme.localOxc": true,
      },
    });
  });

  it("reports invalid JSON in Editor Customization Shared Resource declarations", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "editor-customization-invalid-json-"),
    );
    const resourcePath = path.join(workspace, "capabilities.json");
    await writeFile(resourcePath, "{");

    expect(() => loadEditorCustomizationDeclarations(resourcePath)).toThrow(
      `Editor Customization Shared Resource ${resourcePath} is invalid: invalid JSON:`,
    );
  });

  it("reports unreadable Editor Customization Shared Resource declarations", async () => {
    const resourcePath = await mkdtemp(
      path.join(tmpdir(), "editor-customization-directory-resource-"),
    );

    expect(() => loadEditorCustomizationDeclarations(resourcePath)).toThrow(
      `Editor Customization Shared Resource ${resourcePath} is unreadable:`,
    );
  });

  it("composes OXC and Vitest VS Code configuration once in stable order", () => {
    const capabilities: EditorCustomizationCapability[] = [
      "vitest",
      "oxc-format-lint",
      "vitest",
      "oxc-format-lint",
    ];

    const customization =
      builtInEditorCustomizationForCapabilities(capabilities);

    expect(customization.extensions).toEqual([
      "oxc.oxc-vscode",
      "vitest.explorer",
    ]);
    expect(customization.settings).toMatchObject({
      "editor.codeActionsOnSave": {
        "source.fixAll.oxc": "always",
        "source.format.oxc": "always",
      },
      "editor.defaultFormatter": "oxc.oxc-vscode",
      "editor.formatOnPaste": true,
      "editor.formatOnSave": true,
      "editor.formatOnSaveMode": "file",
      "oxc.enable": true,
      "oxc.configPath": "./oxlint.config.ts",
      "oxc.fmt.configPath": "./oxfmt.config.ts",
      "[javascript]": {
        "editor.defaultFormatter": "oxc.oxc-vscode",
      },
      "[json]": {
        "editor.defaultFormatter": "oxc.oxc-vscode",
      },
      "[markdown]": {
        "editor.defaultFormatter": "oxc.oxc-vscode",
      },
      "[typescript]": {
        "editor.defaultFormatter": "oxc.oxc-vscode",
      },
    });
    expect(customization.settings).not.toHaveProperty("editor.fontFamily");
    expect(customization.settings).not.toHaveProperty("oxc.trace.server");
    expect(customization.settings).not.toHaveProperty("oxc.lint.configPath");
  });

  it("composes Rust and TOML VS Code configuration from Rust capabilities", () => {
    const customization = builtInEditorCustomizationForCapabilities([
      "rust-tooling",
    ]);

    expect(customization.extensions).toEqual([
      "rust-lang.rust-analyzer",
      "tamasfe.even-better-toml",
    ]);
    expect(customization.settings).toEqual({
      "rust-analyzer.cargo.features": "all",
      "rust-analyzer.check.command": "clippy",
      "rust-analyzer.procMacro.enable": true,
      "[rust]": {
        "editor.defaultFormatter": "rust-lang.rust-analyzer",
      },
      "[toml]": {
        "editor.defaultFormatter": "tamasfe.even-better-toml",
      },
    });
    expectForbiddenOptionalExtensionsAbsent(customization.extensions);
  });

  it("composes Vue and Tailwind VS Code recommendations from web capabilities", () => {
    const customization = builtInEditorCustomizationForCapabilities([
      "tailwind",
      "vue",
      "tailwind",
    ]);

    expect(customization.extensions).toEqual([
      "Vue.volar",
      "bradlc.vscode-tailwindcss",
    ]);
    expect(customization.settings).toEqual({});
    expectForbiddenOptionalExtensionsAbsent(customization.extensions);
  });

  it("does not recommend Vitest for generated projects without Vitest capability", async () => {
    const projectDir = await renderPresetProject("ts-lib");
    const expected = builtInEditorCustomizationForCapabilities([
      "oxc-format-lint",
    ]);
    const devcontainer = await readDevcontainerEditorCustomization(
      path.join(projectDir, ".devcontainer/devcontainer.json"),
    );
    const workspaceExtensions = await readWorkspaceExtensions(
      path.join(projectDir, ".vscode/extensions.json"),
    );
    const workspaceSettings = await readWorkspaceSettings(
      path.join(projectDir, ".vscode/settings.json"),
    );

    expect(devcontainer.customizations.vscode.extensions).toEqual(
      expected.extensions,
    );
    expect(devcontainer.customizations.vscode.settings).toEqual(
      expected.settings,
    );
    expect(workspaceExtensions.recommendations).toEqual(["oxc.oxc-vscode"]);
    expect(workspaceSettings).toEqual(expected.settings);
    expect(workspaceExtensions.recommendations).not.toContain(
      "vitest.explorer",
    );
  });

  it("projects Rust and TOML editor customization to generated Rust repositories", async () => {
    const projectDir = await renderPresetProject("rust-bin");
    const expected = builtInEditorCustomizationForCapabilities([
      "rust-tooling",
    ]);
    const devcontainer = await readDevcontainerEditorCustomization(
      path.join(projectDir, ".devcontainer/devcontainer.json"),
    );
    const workspaceExtensions = await readWorkspaceExtensions(
      path.join(projectDir, ".vscode/extensions.json"),
    );
    const workspaceSettings = await readWorkspaceSettings(
      path.join(projectDir, ".vscode/settings.json"),
    );

    expect(devcontainer.customizations.vscode.extensions).toEqual(
      expected.extensions,
    );
    expect(devcontainer.customizations.vscode.settings).toEqual(
      expected.settings,
    );
    expect(workspaceExtensions.recommendations).toEqual(expected.extensions);
    expect(workspaceSettings).toEqual(expected.settings);
    expectForbiddenOptionalExtensionsAbsent(
      devcontainer.customizations.vscode.extensions,
    );
    expectForbiddenOptionalExtensionsAbsent(
      workspaceExtensions.recommendations,
    );
  });

  it("projects Vue and Tailwind recommendations to generated Vue app repositories", async () => {
    const projectDir = await renderPresetProject("vue-app");
    const expected = builtInEditorCustomizationForCapabilities([
      "oxc-format-lint",
      "vue",
      "tailwind",
      "vitest",
    ]);
    const devcontainer = await readDevcontainerEditorCustomization(
      path.join(projectDir, ".devcontainer/devcontainer.json"),
    );
    const workspaceExtensions = await readWorkspaceExtensions(
      path.join(projectDir, ".vscode/extensions.json"),
    );
    const workspaceSettings = await readWorkspaceSettings(
      path.join(projectDir, ".vscode/settings.json"),
    );

    expect(devcontainer.customizations.vscode.extensions).toEqual(
      expected.extensions,
    );
    expect(devcontainer.customizations.vscode.settings).toEqual(
      expected.settings,
    );
    expect(workspaceExtensions.recommendations).toEqual(expected.extensions);
    expect(workspaceSettings).toEqual(expected.settings);
    expectForbiddenOptionalExtensionsAbsent(
      devcontainer.customizations.vscode.extensions,
    );
    expectForbiddenOptionalExtensionsAbsent(
      workspaceExtensions.recommendations,
    );
  });

  it.each(supportedPresetNamesWithOxcFormatLint())(
    "references only generated OXC config files for the %s preset",
    async (preset) => {
      const projectDir = await renderPresetProject(preset);
      const devcontainer = await readDevcontainerEditorCustomization(
        path.join(projectDir, ".devcontainer/devcontainer.json"),
      );
      const workspaceSettings = await readWorkspaceSettings(
        path.join(projectDir, ".vscode/settings.json"),
      );

      for (const settings of [
        devcontainer.customizations.vscode.settings,
        workspaceSettings,
      ]) {
        for (const { value } of oxcConfigPathSettings(settings)) {
          await stat(path.resolve(projectDir, value));
        }
      }
    },
  );
});

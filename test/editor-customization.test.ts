import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import {
  editorCustomizationForCapabilities,
  type EditorCustomizationCapability,
  type EditorCustomizationOptions,
} from "@ykdz/template-core/editor-customization";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
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

function editorCustomizationOptionsForPreset(
  preset: string,
): EditorCustomizationOptions | undefined {
  void preset;
  return undefined;
}

function editorCustomizationCapabilitiesForPreset(
  preset: string,
): EditorCustomizationCapability[] {
  if (preset === "ts-lib") {
    return ["oxc-format-lint"];
  }

  if (preset === "vue-app" || preset === "vue-hono-app") {
    return ["oxc-format-lint", "vue", "tailwind", "vitest"];
  }

  return ["oxc-format-lint", "vitest"];
}

const forbiddenOptionalExtensions = [
  "vadimcn.vscode-lldb",
  "serayuzgur.crates",
  "redhat.vscode-yaml",
  "fill-labs.dependi",
  "selemondev.shadcn-vue",
] as const;

function expectForbiddenOptionalExtensionsAbsent(
  extensions: readonly string[],
): void {
  for (const extension of forbiddenOptionalExtensions) {
    expect(extensions).not.toContain(extension);
  }
}

describe("editor customization", () => {
  it("composes OXC and Vitest VS Code configuration once in stable order", () => {
    const capabilities: EditorCustomizationCapability[] = [
      "vitest",
      "oxc-format-lint",
      "vitest",
      "oxc-format-lint",
    ];

    const customization = editorCustomizationForCapabilities(capabilities);

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
    const customization = editorCustomizationForCapabilities(["rust-tooling"]);

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
    const customization = editorCustomizationForCapabilities([
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

  it("projects the same OXC and Vitest customization to devcontainer and workspace files", async () => {
    const projectDir = await renderPresetProject("hono-api");
    const expected = editorCustomizationForCapabilities([
      "oxc-format-lint",
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

  it("does not recommend Vitest for generated projects without Vitest capability", async () => {
    const projectDir = await renderPresetProject("ts-lib");
    const expected = editorCustomizationForCapabilities(["oxc-format-lint"]);
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
    const expected = editorCustomizationForCapabilities(["rust-tooling"]);
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
    const expected = editorCustomizationForCapabilities([
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

  it.each(["hono-api", "vue-app", "vue-hono-app"])(
    "generates capability-derived editor customization for the %s preset",
    async (preset) => {
      const projectDir = await renderPresetProject(preset);
      const expected = editorCustomizationForCapabilities(
        editorCustomizationCapabilitiesForPreset(preset),
        editorCustomizationOptionsForPreset(preset),
      );
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
    },
  );

  it.each(["hono-api", "ts-lib", "vue-app", "vue-hono-app"])(
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

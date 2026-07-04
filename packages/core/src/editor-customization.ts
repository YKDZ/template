import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

export type EditorCustomizationCapability =
  | "oxc-format-lint"
  | "rust-tooling"
  | "tailwind"
  | "vue"
  | "vitest";

export type EditorCustomization = {
  readonly extensions: readonly string[];
  readonly settings: Record<string, unknown>;
};

export type EditorCustomizationOptions = {
  readonly oxcConfigPaths?:
    | "nested"
    | {
        readonly lint?: string;
        readonly formatter?: string;
      };
};

type CapabilityProjection = {
  readonly extensions: readonly string[];
  readonly settings: Record<string, unknown>;
};

type EditorCustomizationDeclarations = {
  readonly capabilities: Record<
    EditorCustomizationCapability,
    CapabilityProjection
  >;
};

const capabilityOrder: readonly EditorCustomizationCapability[] = [
  "oxc-format-lint",
  "vue",
  "tailwind",
  "rust-tooling",
  "vitest",
];

const defaultOxcConfigPaths = {
  formatter: "./oxfmt.config.ts",
  lint: "./oxlint.config.ts",
};

const capabilityProjectionSchema = v.object({
  extensions: v.array(v.string()),
  settings: v.record(v.string(), v.unknown()),
});
const editorCustomizationDeclarationsSchema = v.object({
  capabilities: v.object({
    "oxc-format-lint": capabilityProjectionSchema,
    vue: capabilityProjectionSchema,
    tailwind: capabilityProjectionSchema,
    "rust-tooling": capabilityProjectionSchema,
    vitest: capabilityProjectionSchema,
  }),
});

const declarations = loadEditorCustomizationDeclarations();

function editorCustomizationDeclarationPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const relativeDeclarationPath =
    "builtin-source/templates/shared/editor-customization/capabilities.json";
  const candidates = [
    path.resolve(moduleDirectory, "..", relativeDeclarationPath),
    path.resolve(moduleDirectory, "..", "..", relativeDeclarationPath),
    path.resolve(
      moduleDirectory,
      "..",
      "..",
      "template-builtin-source",
      "templates",
      "shared",
      "editor-customization",
      "capabilities.json",
    ),
    path.resolve(
      moduleDirectory,
      "..",
      "..",
      "..",
      "packages",
      relativeDeclarationPath,
    ),
  ];

  const declarationPath = candidates.find((candidate) => existsSync(candidate));

  if (!declarationPath) {
    throw new Error(
      `Unable to find editor customization declarations at ${relativeDeclarationPath}`,
    );
  }

  return declarationPath;
}

function loadEditorCustomizationDeclarations(): EditorCustomizationDeclarations {
  const source = JSON.parse(
    readFileSync(editorCustomizationDeclarationPath(), "utf8"),
  ) as unknown;
  const result = v.safeParse(editorCustomizationDeclarationsSchema, source);

  if (!result.success) {
    throw new Error(
      `Editor customization declarations are invalid: ${result.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  return result.output;
}

function oxcConfigPathSettings(
  configPaths: EditorCustomizationOptions["oxcConfigPaths"],
): Record<string, unknown> {
  if (configPaths === "nested") {
    return {};
  }

  const paths = {
    ...defaultOxcConfigPaths,
    ...configPaths,
  };

  return {
    "oxc.configPath": paths.lint,
    "oxc.fmt.configPath": paths.formatter,
  };
}

function oxcProjection(
  options?: EditorCustomizationOptions,
): CapabilityProjection {
  const baseProjection = declarations.capabilities["oxc-format-lint"];

  return {
    extensions: baseProjection.extensions,
    settings: {
      ...baseProjection.settings,
      ...oxcConfigPathSettings(options?.oxcConfigPaths),
    },
  };
}

function mergeSettings(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...patch };
}

export function editorCustomizationForCapabilities(
  capabilities: readonly EditorCustomizationCapability[],
  options?: EditorCustomizationOptions,
): EditorCustomization {
  const selected = new Set(capabilities);
  const extensions = new Set<string>();
  let settings: Record<string, unknown> = {};

  for (const capability of capabilityOrder) {
    if (!selected.has(capability)) {
      continue;
    }

    const projection =
      capability === "oxc-format-lint"
        ? oxcProjection(options)
        : declarations.capabilities[capability];
    for (const extension of projection.extensions) {
      extensions.add(extension);
    }
    settings = mergeSettings(settings, projection.settings);
  }

  return {
    extensions: [...extensions],
    settings,
  };
}

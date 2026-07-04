import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCapabilityProjection(
  capability: EditorCustomizationCapability,
  value: unknown,
): asserts value is CapabilityProjection {
  if (!isRecord(value)) {
    throw new Error(`Editor customization ${capability} must be an object`);
  }

  const extensions = value.extensions;
  const settings = value.settings;

  if (
    !Array.isArray(extensions) ||
    extensions.some((extension) => typeof extension !== "string")
  ) {
    throw new Error(
      `Editor customization ${capability} must declare string extensions`,
    );
  }

  if (!isRecord(settings)) {
    throw new Error(
      `Editor customization ${capability} must declare object settings`,
    );
  }
}

function loadEditorCustomizationDeclarations(): EditorCustomizationDeclarations {
  const source = JSON.parse(
    readFileSync(editorCustomizationDeclarationPath(), "utf8"),
  ) as unknown;

  if (!isRecord(source) || !isRecord(source.capabilities)) {
    throw new Error(
      "Editor customization declarations must contain capabilities",
    );
  }

  const capabilities = source.capabilities;

  for (const capability of capabilityOrder) {
    assertCapabilityProjection(capability, capabilities[capability]);
  }

  return {
    capabilities: Object.fromEntries(
      capabilityOrder.map((capability) => [
        capability,
        capabilities[capability],
      ]),
    ) as Record<EditorCustomizationCapability, CapabilityProjection>,
  };
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

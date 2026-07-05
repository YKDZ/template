import { readFileSync } from "node:fs";

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

export type EditorCustomizationDeclarations = {
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

function editorCustomizationDeclarationIssuePath(
  issue: v.InferIssue<typeof editorCustomizationDeclarationsSchema>,
): string {
  const segments =
    issue.path?.flatMap((item) =>
      typeof item.key === "string" || typeof item.key === "number"
        ? [String(item.key)]
        : [],
    ) ?? [];

  return segments.length === 0 ? "$" : `$.${segments.join(".")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function editorCustomizationSharedResourceLabel(resourcePath: string): string {
  return `Editor Customization Shared Resource ${resourcePath}`;
}

export function loadEditorCustomizationDeclarations(
  resourcePath: string,
): EditorCustomizationDeclarations {
  const resourceLabel = editorCustomizationSharedResourceLabel(resourcePath);
  let resourceText: string;

  try {
    resourceText = readFileSync(resourcePath, "utf8");
  } catch (error) {
    throw new Error(`${resourceLabel} is unreadable: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let source: unknown;
  try {
    source = JSON.parse(resourceText) as unknown;
  } catch (error) {
    throw new Error(
      `${resourceLabel} is invalid: invalid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const result = v.safeParse(editorCustomizationDeclarationsSchema, source);

  if (!result.success) {
    throw new Error(
      `${resourceLabel} is invalid: ${result.issues
        .map(
          (issue) =>
            `${editorCustomizationDeclarationIssuePath(issue)}: ${issue.message}`,
        )
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

function oxcProjection(options: {
  readonly declarations: EditorCustomizationDeclarations;
  readonly editorOptions: EditorCustomizationOptions | undefined;
}): CapabilityProjection {
  const baseProjection = options.declarations.capabilities["oxc-format-lint"];

  return {
    extensions: baseProjection.extensions,
    settings: {
      ...baseProjection.settings,
      ...oxcConfigPathSettings(options.editorOptions?.oxcConfigPaths),
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
  declarations: EditorCustomizationDeclarations,
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
        ? oxcProjection({ declarations, editorOptions: options })
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

import { readFileSync } from "node:fs";

import * as v from "valibot";

/** Capability identities are supplied by the owning Built-in Presets policy. */
export type EditorCustomizationCapability = string;

export type EditorCustomization = {
  readonly extensions: readonly string[];
  readonly settings: Record<string, unknown>;
};

type CapabilityProjection = {
  readonly extensions: readonly string[];
  readonly settings: Record<string, unknown>;
};

export type EditorCustomizationDeclarations = {
  readonly capabilityOrder: readonly EditorCustomizationCapability[];
  readonly capabilities: Readonly<
    Record<EditorCustomizationCapability, CapabilityProjection>
  >;
};

const capabilityProjectionSchema = v.object({
  extensions: v.array(v.string()),
  settings: v.record(v.string(), v.unknown()),
});
const editorCustomizationDeclarationsSchema = v.object({
  capabilityOrder: v.array(v.string()),
  capabilities: v.record(v.string(), capabilityProjectionSchema),
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

function mergeSettings(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...patch };
}

export function editorCustomizationForCapabilities(
  capabilities: readonly EditorCustomizationCapability[],
  declarations: EditorCustomizationDeclarations,
): EditorCustomization {
  const selected = new Set(capabilities);
  const extensions = new Set<string>();
  let settings: Record<string, unknown> = {};

  for (const capability of declarations.capabilityOrder) {
    if (!selected.has(capability)) {
      continue;
    }

    const projection = declarations.capabilities[capability];
    if (projection === undefined) {
      throw new Error(
        `Editor customization policy orders undeclared capability ${capability}`,
      );
    }
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

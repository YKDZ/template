import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

/** 能力声明由根环境维护，能力选择由内容拥有者贡献。 */
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
  readonly source: string;
  readonly capabilityOrder: readonly EditorCustomizationCapability[];
  readonly capabilities: Readonly<
    Record<EditorCustomizationCapability, CapabilityProjection>
  >;
};

const capabilityProjectionSchema = z.object({
  extensions: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
});
const editorCustomizationDeclarationsSchema = z.object({
  capabilityOrder: z.array(z.string()),
  capabilities: z.record(z.string(), capabilityProjectionSchema),
});

function editorCustomizationDeclarationIssuePath(
  issue: z.core.$ZodIssue,
): string {
  return issue.path.length === 0
    ? "$"
    : `$.${issue.path.map(String).join(".")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function editorCustomizationSharedResourceLabel(resourcePath: string): string {
  return `编辑器定制共享资源 ${resourcePath}`;
}

export function loadEditorCustomizationDeclarations(
  resourcePath: string,
  sourceLabel: string,
): EditorCustomizationDeclarations {
  const resourceLabel = editorCustomizationSharedResourceLabel(resourcePath);
  let resourceText: string;

  try {
    resourceText = readFileSync(resourcePath, "utf8");
  } catch (error) {
    throw new Error(`${resourceLabel} 无法读取：${errorMessage(error)}`, {
      cause: error,
    });
  }

  let parsedSource: unknown;
  try {
    parsedSource = JSON.parse(resourceText) as unknown;
  } catch (error) {
    throw new Error(
      `${resourceLabel} 内容无效：JSON 语法错误：${errorMessage(error)}`,
      { cause: error },
    );
  }

  const result = editorCustomizationDeclarationsSchema.safeParse(parsedSource);

  if (!result.success) {
    throw new Error(
      `${resourceLabel} 内容无效：${result.error.issues
        .map(
          (issue) =>
            `${editorCustomizationDeclarationIssuePath(issue)}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }

  return { ...result.data, source: sourceLabel };
}

function jsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function editorCustomizationForCapabilities(
  capabilities: readonly EditorCustomizationCapability[],
  declarations: EditorCustomizationDeclarations,
): EditorCustomization {
  const selected = new Set(capabilities);
  const extensions = new Set<string>();
  const settings: Record<string, unknown> = {};
  const settingSources = new Map<
    string,
    { readonly source: string; readonly value: unknown }
  >();

  for (const capability of declarations.capabilityOrder) {
    if (!selected.has(capability)) {
      continue;
    }

    const projection = declarations.capabilities[capability];
    if (projection === undefined) {
      throw new Error(`编辑器定制策略列出了未声明的能力：${capability}`);
    }
    for (const extension of projection.extensions) {
      extensions.add(extension);
    }
    for (const [setting, value] of Object.entries(projection.settings)) {
      const source = `${declarations.source}#/capabilities/${jsonPointerToken(capability)}/settings/${jsonPointerToken(setting)}`;
      const previous = settingSources.get(setting);
      if (previous !== undefined && !isDeepStrictEqual(previous.value, value)) {
        throw new Error(
          `编辑器设置 /settings/${jsonPointerToken(setting)} 冲突：${previous.source} 与 ${source}`,
        );
      }
      settingSources.set(setting, { source, value });
      settings[setting] = value;
    }
  }

  return {
    extensions: [...extensions],
    settings,
  };
}

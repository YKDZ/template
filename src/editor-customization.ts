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

const capabilityOrder: readonly EditorCustomizationCapability[] = [
  "oxc-format-lint",
  "vue",
  "tailwind",
  "rust-tooling",
  "vitest",
];

const oxcFormatterSettings = {
  "editor.defaultFormatter": "oxc.oxc-vscode",
};

const defaultOxcConfigPaths = {
  formatter: "./oxfmt.config.ts",
  lint: "./oxlint.config.ts",
};

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
  return {
    extensions: ["oxc.oxc-vscode"],
    settings: {
      "editor.codeActionsOnSave": {
        "source.format.oxc": "always",
        "source.fixAll.oxc": "always",
      },
      ...oxcFormatterSettings,
      "editor.formatOnPaste": true,
      "editor.formatOnSave": true,
      "editor.formatOnSaveMode": "file",
      "oxc.enable": true,
      ...oxcConfigPathSettings(options?.oxcConfigPaths),
      "[javascript]": oxcFormatterSettings,
      "[json]": oxcFormatterSettings,
      "[markdown]": oxcFormatterSettings,
      "[typescript]": oxcFormatterSettings,
    },
  };
}

const capabilityProjections: Record<
  EditorCustomizationCapability,
  CapabilityProjection
> = {
  "oxc-format-lint": oxcProjection(),
  "rust-tooling": {
    extensions: ["rust-lang.rust-analyzer", "tamasfe.even-better-toml"],
    settings: {
      "rust-analyzer.cargo.features": "all",
      "rust-analyzer.check.command": "clippy",
      "rust-analyzer.procMacro.enable": true,
      "[rust]": {
        "editor.defaultFormatter": "rust-lang.rust-analyzer",
      },
      "[toml]": {
        "editor.defaultFormatter": "tamasfe.even-better-toml",
      },
    },
  },
  tailwind: {
    extensions: ["bradlc.vscode-tailwindcss"],
    settings: {},
  },
  vue: {
    extensions: ["Vue.volar"],
    settings: {},
  },
  vitest: {
    extensions: ["vitest.explorer"],
    settings: {},
  },
};

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
        : capabilityProjections[capability];
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

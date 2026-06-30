import type { BuiltInPreset } from "../src/declarations.js";
import type { GenerationContext } from "../src/generation-context.js";
import type {
  PresetProjection,
  PresetProjectionPlan,
} from "../src/preset-projection.js";
import { tsLibPresetProjection } from "./ts-lib/projection.js";

const futurePresetMetadata = [
  {
    name: "ts-app",
    title: "TypeScript application",
    description: "Future application preset metadata.",
    generation: "future",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: [],
  },
  {
    name: "node-cli",
    title: "Node.js CLI",
    description: "Future command-line preset metadata.",
    generation: "future",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: [],
  },
] satisfies readonly BuiltInPreset[];

const legacySupportedPresetMetadata = [
  {
    name: "hono-api",
    title: "Hono API",
    description: "Single-package Hono Node API with strict TypeScript tooling.",
    generation: "supported",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: [
      "pnpm-catalog",
      "oxc-format-lint",
      "strict-typescript",
      "root-check",
      "fix-command",
      "devcontainer",
      "github-actions",
      "dependabot",
    ],
  },
  {
    name: "vue-app",
    title: "Vue app",
    description:
      "Single-package Vue app with Vite, Tailwind, Pinia, and test tooling.",
    generation: "supported",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: [
      "pnpm-catalog",
      "oxc-format-lint",
      "strict-typescript",
      "root-check",
      "fix-command",
      "devcontainer",
      "github-actions",
      "dependabot",
    ],
  },
  {
    name: "vue-hono-app",
    title: "Vue Hono app",
    description: "Full-stack Vue and Hono workspace with Hono RPC typing.",
    generation: "supported",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["multi-package"],
    features: [
      "pnpm-catalog",
      "oxc-format-lint",
      "strict-typescript",
      "root-check",
      "fix-command",
      "devcontainer",
      "github-actions",
      "dependabot",
    ],
  },
  {
    name: "rust-bin",
    title: "Rust binary",
    description:
      "Single-package Rust native binary with rustfmt, clippy, and cargo tests.",
    generation: "supported",
    supportedPackageManagers: ["pnpm"],
    supportedProjectKinds: ["single-package"],
    features: [
      "root-check",
      "fix-command",
      "devcontainer",
      "github-actions",
      "dependabot",
      "rustfmt-clippy",
      "cargo-test",
    ],
  },
] satisfies readonly BuiltInPreset[];

export const builtInPresetProjections: readonly PresetProjection[] = [
  tsLibPresetProjection,
];

export const builtInPresetMetadata: readonly BuiltInPreset[] = [
  ...builtInPresetProjections.map((projection) => projection.metadata),
  ...legacySupportedPresetMetadata,
  ...futurePresetMetadata,
];

export function findBuiltInPresetProjection(
  name: string,
): PresetProjection | undefined {
  return builtInPresetProjections.find(
    (projection) => projection.metadata.name === name,
  );
}

export function projectPresetThroughRegistry(
  context: GenerationContext,
): PresetProjectionPlan | undefined {
  return findBuiltInPresetProjection(context.preset)?.project(context);
}

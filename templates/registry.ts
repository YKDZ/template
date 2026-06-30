import type { BuiltInPreset } from "../src/declarations.js";
import type { GenerationContext } from "../src/generation-context.js";
import type {
  PresetProjection,
  PresetProjectionPlan,
} from "../src/preset-projection.js";
import { honoApiPresetProjection } from "./hono-api/projection.js";
import { tsLibPresetProjection } from "./ts-lib/projection.js";
import { vueAppPresetProjection } from "./vue-app/projection.js";
import { vueHonoAppPresetProjection } from "./vue-hono-app/projection.js";

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
  honoApiPresetProjection,
  vueAppPresetProjection,
  vueHonoAppPresetProjection,
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

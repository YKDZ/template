import path from "node:path";

import { assembleGenerationContext } from "../src/generation-context.js";
import { planNextStepInstructions } from "../src/next-step-instructions.js";
import type { PresetProjectionPlan } from "../src/preset-projection.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";

function projectPresetPlan(preset: string): PresetProjectionPlan {
  const projection = findBuiltInPresetProjection(preset);

  if (!projection) {
    throw new Error(`Missing test Preset Projection: ${preset}`);
  }

  const targetDir = path.join("/", "tmp", `generated-${preset}`);
  const blueprint = projection.blueprint({ targetDir });

  return projection.project(
    assembleGenerationContext({
      targetDir,
      blueprint,
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    }),
  );
}

describe("Next Step Instructions", () => {
  it.each([
    ["ts-lib", ["pnpm run fix", "pnpm run check"]],
    ["hono-api", ["pnpm run fix", "pnpm run check"]],
    [
      "vue-app",
      [
        "pnpm run fix",
        "pnpm exec playwright install chromium",
        "pnpm run check",
      ],
    ],
    [
      "vue-hono-app",
      [
        "pnpm run fix",
        "pnpm --filter ./apps/web exec playwright install chromium",
        "pnpm run check",
      ],
    ],
  ] satisfies Array<[string, string[]]>)(
    "plans user-run instructions for a %s Preset without executable Post Commands",
    (preset, commandDisplays) => {
      const targetDir = path.join("/", "tmp", "generated-repository");

      const plan = planNextStepInstructions({
        targetDir,
        projectionPlan: projectPresetPlan(preset),
      });

      expect(plan.steps).toEqual([
        {
          id: "enter-project",
          label: "Enter Generated Repository",
          kind: "navigation",
          command: "cd",
          args: [targetDir],
          cwd: ".",
          display: `cd ${targetDir}`,
          machineVerifiable: false,
        },
        {
          id: "install-dependencies",
          label: "Install dependencies",
          kind: "command",
          command: "pnpm",
          args: ["install"],
          cwd: targetDir,
          display: "pnpm install",
          machineVerifiable: true,
        },
        ...commandDisplays.map((display) =>
          expect.objectContaining({
            kind: "command",
            cwd: targetDir,
            display,
            machineVerifiable: true,
          }),
        ),
      ]);
      expect(plan.steps.map((step) => step.command)).not.toContain("corepack");
    },
  );

  it("plans pnpm task-layer instructions for the Rust Preset", () => {
    const targetDir = path.join("/", "tmp", "rust-repository");

    const plan = planNextStepInstructions({
      targetDir,
      projectionPlan: projectPresetPlan("rust-bin"),
    });

    expect(plan.steps.map((step) => step.display)).toEqual([
      `cd ${targetDir}`,
      "pnpm install",
      "pnpm run fix",
      "pnpm run check",
    ]);
    expect(plan.steps.slice(1)).toEqual([
      {
        id: "install-dependencies",
        label: "Install dependencies",
        kind: "command",
        command: "pnpm",
        args: ["install"],
        cwd: targetDir,
        display: "pnpm install",
        machineVerifiable: true,
      },
      {
        id: "run-fix",
        label: "Run Fix Command",
        kind: "command",
        command: "pnpm",
        args: ["run", "fix"],
        cwd: targetDir,
        display: "pnpm run fix",
        machineVerifiable: true,
      },
      {
        id: "run-root-check",
        label: "Run Root Check",
        kind: "command",
        command: "pnpm",
        args: ["run", "check"],
        cwd: targetDir,
        display: "pnpm run check",
        machineVerifiable: true,
      },
    ]);
  });

  it("derives Playwright setup guidance from Check Plan environment needs", () => {
    const targetDir = path.join("/", "tmp", "custom-repository");

    const plan = planNextStepInstructions({
      targetDir,
      projectionPlan: {
        sourceRoot: targetDir,
        operations: [],
        checkPlan: {
          components: [],
          environmentNeeds: [
            {
              kind: "playwright-browser-assets",
              browser: "chromium",
              owner: { kind: "package-boundary", path: "apps/web" },
            },
          ],
        },
        fixPlan: { components: [] },
        dependencyMaintenancePolicy: {
          ecosystems: ["npm", "github-actions"],
          interval: "weekly",
        },
        packageScripts: {},
        capabilities: {
          rootCheck: true,
          fixCommand: true,
          githubActions: true,
          dependabot: true,
          devcontainer: true,
        },
      },
    });

    expect(plan.steps.map((step) => step.display)).toContain(
      "pnpm --filter ./apps/web exec playwright install chromium",
    );
  });
});

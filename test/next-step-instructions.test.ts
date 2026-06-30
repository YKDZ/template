import path from "node:path";
import { planNextStepInstructions } from "../src/next-step-instructions.js";
import type { PresetName } from "../src/declarations.js";

describe("Next Step Instructions", () => {
  it.each([
    ["ts-lib", ["pnpm run fix", "pnpm run check"]],
    ["hono-api", ["pnpm run fix", "pnpm run check"]],
    ["vue-app", ["pnpm run fix", "pnpm exec playwright install chromium", "pnpm run check"]],
    [
      "vue-hono-app",
      [
        "pnpm run fix",
        "pnpm --filter ./apps/web exec playwright install chromium",
        "pnpm run check",
      ],
    ],
  ] satisfies Array<[PresetName, string[]]>)(
    "plans user-run instructions for a %s Preset without executable Post Commands",
    (preset, commandDisplays) => {
      const targetDir = path.join("/", "tmp", "generated-repository");

      const plan = planNextStepInstructions({ preset, targetDir });

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

  it("plans the supported check script instruction for the Rust Preset until pnpm tasks exist", () => {
    const targetDir = path.join("/", "tmp", "rust-repository");

    const plan = planNextStepInstructions({ preset: "rust-bin", targetDir });

    expect(plan.steps.map((step) => step.display)).toEqual([
      `cd ${targetDir}`,
      "./scripts/check",
    ]);
    expect(plan.steps[1]).toEqual({
      id: "run-check-script",
      label: "Run Check Script",
      kind: "command",
      command: "./scripts/check",
      args: [],
      cwd: targetDir,
      display: "./scripts/check",
      machineVerifiable: true,
    });
  });

  it.each(["ts-app", "node-cli"] satisfies PresetName[])(
    "plans only generic instructions for unsupported future Preset %s",
    (preset) => {
      const targetDir = path.join("/", "tmp", "future-repository");

      const plan = planNextStepInstructions({ preset, targetDir });

      expect(plan.steps.map((step) => step.display)).toEqual([
        `cd ${targetDir}`,
        "pnpm install",
        "pnpm run check",
      ]);
    },
  );
});

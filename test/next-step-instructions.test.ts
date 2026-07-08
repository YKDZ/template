import path from "node:path";

import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import { assembleGenerationContext } from "@ykdz/template-core/generation-context";
import {
  formatGeneratedFollowUpDocument,
  generatedFollowUpDocumentOperation,
  planNextStepInstructions,
} from "@ykdz/template-core/next-step-instructions";
import type { PresetProjectionPlan } from "@ykdz/template-core/preset-projection";

const optionalGitDisplays = [
  "git init",
  "git add .",
  'git commit -m "Initial commit"',
];

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
    [
      "vue-app",
      [
        "pnpm run fix",
        "pnpm --filter ./apps/web exec playwright install chromium",
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

      expect(plan.steps.slice(0, 2)).toEqual([
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
      ]);
      expect(
        plan.steps
          .slice(2, 2 + commandDisplays.length)
          .map(({ kind, cwd, display, machineVerifiable }) => ({
            kind,
            cwd,
            display,
            machineVerifiable,
          })),
      ).toEqual(
        commandDisplays.map((display) => ({
          kind: "command",
          cwd: targetDir,
          display,
          machineVerifiable: true,
        })),
      );
      expect(
        plan.steps
          .slice(2 + commandDisplays.length)
          .map(({ kind, cwd, display, machineVerifiable }) => ({
            kind,
            cwd,
            display,
            machineVerifiable,
          })),
      ).toEqual(
        optionalGitDisplays.map((display) => ({
          kind: "command",
          cwd: targetDir,
          display,
          machineVerifiable: false,
        })),
      );
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
      ...optionalGitDisplays,
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
      {
        id: "optional-git-init",
        label: "Optional: initialize git",
        kind: "command",
        command: "git",
        args: ["init"],
        cwd: targetDir,
        display: "git init",
        machineVerifiable: false,
      },
      {
        id: "optional-git-add",
        label: "Optional: stage files",
        kind: "command",
        command: "git",
        args: ["add", "."],
        cwd: targetDir,
        display: "git add .",
        machineVerifiable: false,
      },
      {
        id: "optional-git-commit",
        label: "Optional: create your first commit",
        kind: "command",
        command: "git",
        args: ["commit", "-m", "Initial commit"],
        cwd: targetDir,
        display: 'git commit -m "Initial commit"',
        machineVerifiable: false,
      },
    ]);
  });

  it("renders a TODO.md follow-up document from project-local instructions", () => {
    const targetDir = path.join("/", "tmp", "generated-repository");
    const plan = planNextStepInstructions({
      targetDir,
      projectionPlan: projectPresetPlan("ts-lib"),
    });

    expect(formatGeneratedFollowUpDocument(plan)).toBe(
      [
        "# TODO",
        "",
        "Generated follow-up tasks for this repository.",
        "",
        "### Next Steps",
        "- [ ] Install dependencies",
        "  `pnpm install`",
        "- [ ] Run Fix Command",
        "  `pnpm run fix`",
        "- [ ] Run Root Check",
        "  `pnpm run check`",
        "",
        "### Optional Git Setup",
        "- [ ] Initialize git",
        "  `git init`",
        "- [ ] Stage files",
        "  `git add .`",
        "- [ ] Create your first commit",
        '  `git commit -m "Initial commit"`',
        "",
        "### Done ✓",
        "",
      ].join("\n"),
    );
    expect(formatGeneratedFollowUpDocument(plan)).not.toContain(
      `cd ${targetDir}`,
    );
    expect(generatedFollowUpDocumentOperation(plan)).toEqual({
      kind: "writeText",
      to: "TODO.md",
      text: formatGeneratedFollowUpDocument(plan),
    });
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
              nextStep: {
                id: "install-apps-web-playwright-browsers",
                label: "Install Playwright browser assets for apps/web package",
                command: "pnpm",
                args: [
                  "--filter",
                  "./apps/web",
                  "exec",
                  "playwright",
                  "install",
                  "chromium",
                ],
                display:
                  "pnpm --filter ./apps/web exec playwright install chromium",
                machineVerifiable: true,
              },
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

  it("uses explicit Check Plan metadata for package browser environment preparation", () => {
    const targetDir = path.join("/", "tmp", "custom-browser-repository");

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
              owner: { kind: "package-boundary", path: "packages/client" },
              nextStep: {
                id: "install-client-playwright-browsers",
                label: "Install Playwright browser assets for client package",
                command: "pnpm",
                args: [
                  "--filter",
                  "./packages/client",
                  "exec",
                  "playwright",
                  "install",
                  "chromium",
                ],
                display:
                  "pnpm --filter ./packages/client exec playwright install chromium",
                machineVerifiable: true,
              },
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

    expect(
      plan.steps.map(({ id, label, display, machineVerifiable }) => ({
        id,
        label,
        display,
        machineVerifiable,
      })),
    ).toEqual([
      {
        id: "enter-project",
        label: "Enter Generated Repository",
        display: `cd ${targetDir}`,
        machineVerifiable: false,
      },
      {
        id: "install-dependencies",
        label: "Install dependencies",
        display: "pnpm install",
        machineVerifiable: true,
      },
      {
        id: "run-fix",
        label: "Run Fix Command",
        display: "pnpm run fix",
        machineVerifiable: true,
      },
      {
        id: "install-client-playwright-browsers",
        label: "Install Playwright browser assets for client package",
        display:
          "pnpm --filter ./packages/client exec playwright install chromium",
        machineVerifiable: true,
      },
      {
        id: "run-root-check",
        label: "Run Root Check",
        display: "pnpm run check",
        machineVerifiable: true,
      },
      ...optionalGitDisplays.map((display) => ({
        id:
          display === "git init"
            ? "optional-git-init"
            : display === "git add ."
              ? "optional-git-add"
              : "optional-git-commit",
        label:
          display === "git init"
            ? "Optional: initialize git"
            : display === "git add ."
              ? "Optional: stage files"
              : "Optional: create your first commit",
        display,
        machineVerifiable: false,
      })),
    ]);
    expect(
      plan.steps.find(
        (step) => step.id === "install-client-playwright-browsers",
      ),
    ).toMatchObject({
      environmentNeedKind: "playwright-browser-assets",
    });
  });
});

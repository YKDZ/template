import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findBuiltInPresetProjection } from "@ykdz/template-builtin-source/registry";
import {
  planRustBinChecks,
  planRustBinFixes,
  projectRustBinPackageScripts,
} from "@ykdz/template-builtin-source/templates/rust-bin/projection";
import { projectTsLibPackageScripts } from "@ykdz/template-builtin-source/templates/ts-lib/projection";
import { projectVueAppPackageScripts } from "@ykdz/template-builtin-source/templates/vue-app/projection";
import {
  projectVueHonoApiPackageScripts,
  projectVueHonoRootPackageScripts,
  projectVueHonoWebPackageScripts,
} from "@ykdz/template-builtin-source/templates/vue-hono-app/projection";
import {
  deploymentCheckEnvironmentNeeds,
  renderDeploymentCheckCommand,
  renderPlaywrightBrowserInstallCommand,
  renderRootCheckCommand,
  renderFixCommand,
} from "@ykdz/template-core/module-graph";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "@ykdz/template-core/project-github";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function rootCheckWorkflowCheckoutRef(): string {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/check.yml"),
    "utf8",
  );
  const match = workflow.match(/uses:\s+(actions\/checkout@v\d+)/);

  if (!match?.[1]) {
    throw new Error("Root check workflow must use actions/checkout@vN");
  }

  return match[1];
}

describe("module graph plans", () => {
  it("selects semantic Check and Fix Components for the ts-lib workspace root", () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    const plan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-lib" },
      preset: "ts-lib",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-lib" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(plan.checkPlan.components).toEqual([
      {
        kind: "oxc-format-check",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "oxc-lint",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "typescript-typecheck",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "turbo-package-check",
        owner: { kind: "package-boundary", path: "packages/*" },
      },
    ]);

    expect(plan.fixPlan.components).toEqual([
      {
        kind: "oxc-format-write",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "oxc-lint-fix",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "turbo-package-fix",
        owner: { kind: "package-boundary", path: "packages/*" },
      },
    ]);
  });

  it("renders ts-lib Root Check and Fix Command strings through Turbo", () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    const plan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-lib" },
      preset: "ts-lib",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-lib" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });
    const checkPlan = plan.checkPlan;
    const fixPlan = plan.fixPlan;

    expect(checkPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-check",
      "oxc-lint",
      "typescript-typecheck",
      "turbo-package-check",
    ]);
    expect(fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
      "turbo-package-fix",
    ]);

    expect(renderRootCheckCommand(checkPlan)).toBe(
      "turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
    );
    expect(renderFixCommand(fixPlan)).toBe(
      "turbo run format:write:run lint:fix:run fix:run --output-logs=errors-only --log-order=grouped",
    );
  });

  it("renders Turbo package filters from package boundary ownership", () => {
    expect(
      renderRootCheckCommand({
        components: [
          {
            kind: "turbo-package-typecheck",
            owner: { kind: "package-boundary", path: "apps/*" },
          },
          {
            kind: "turbo-package-check",
            owner: { kind: "package-boundary", path: "apps/*" },
          },
        ],
        environmentNeeds: [],
      }),
    ).toBe(
      "turbo run typecheck:run format:check:run lint:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
    );

    expect(
      renderFixCommand({
        components: [
          {
            kind: "turbo-package-fix",
            owner: { kind: "package-boundary", path: "apps/*" },
          },
        ],
      }),
    ).toBe(
      "turbo run format:write:run lint:fix:run fix:run --output-logs=errors-only --log-order=grouped",
    );
  });

  it("projects ts-lib root and member package scripts from Check and Fix Plans", () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    const plan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-lib" },
      preset: "ts-lib",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-lib" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(plan.packageScripts).toEqual({
      check:
        "pnpm run check:boundaries && turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
      "check:boundaries": "turbo boundaries --no-color",
      "check:run": 'node -e ""',
      fix: "turbo run format:write:run lint:fix:run fix:run --output-logs=errors-only --log-order=grouped",
      "fix:run": 'node -e ""',
      "format:check":
        "turbo run format:check:run --output-logs=errors-only --log-order=grouped",
      "format:check:run":
        "oxfmt --list-different oxlint.config.ts oxfmt.config.ts",
      "format:write":
        "turbo run format:write:run --output-logs=errors-only --log-order=grouped",
      "format:write:run": "oxfmt --write oxlint.config.ts oxfmt.config.ts",
      lint: "turbo run lint:run --output-logs=errors-only --log-order=grouped",
      "lint:fix":
        "turbo run lint:fix:run --output-logs=errors-only --log-order=grouped",
      "lint:fix:run":
        "oxlint --format=unix oxlint.config.ts oxfmt.config.ts --fix",
      "lint:run":
        "oxlint --quiet --format=unix oxlint.config.ts oxfmt.config.ts",
      typecheck:
        "turbo run typecheck:run --output-logs=errors-only --log-order=grouped",
      "typecheck:run": "tsc -p tsconfig.config.json --noEmit --pretty false",
    });
    expect(projectTsLibPackageScripts()).toEqual({
      "format:check:run":
        "oxfmt --list-different --config ../../oxfmt.config.ts .",
      "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
      "lint:run":
        "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
      "lint:fix:run":
        "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
      "typecheck:run": "tsc -p tsconfig.json --noEmit --pretty false",
    });
  });

  it("projects vue-app package scripts and browser environment needs from Check and Fix Plans", () => {
    const projection = findBuiltInPresetProjection("vue-app");
    const plan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-vue" },
      preset: "vue-app",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-vue" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(projectVueAppPackageScripts()).toEqual({
      "build:run": "vite build",
      dev: "vite",
      "format:check:run":
        "oxfmt --list-different --config ../../oxfmt.config.ts .",
      "format:write:run": "oxfmt --write --config ../../oxfmt.config.ts .",
      "lint:run":
        "oxlint --quiet --format=unix --config ../../oxlint.config.ts .",
      "lint:fix:run":
        "oxlint --format=unix --config ../../oxlint.config.ts . --fix",
      preview: "vite preview",
      "test:run": "vitest run --reporter=agent --silent=passed-only",
      "test:e2e:run": "node scripts/run-playwright.ts",
      "typecheck:run":
        "node scripts/run-vue-tsc.ts --build --noEmit --pretty false",
    });
    expect(plan.checkPlan.environmentNeeds).toEqual([
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
          display: "pnpm --filter ./apps/web exec playwright install chromium",
          machineVerifiable: true,
        },
      },
    ]);
    expect(
      renderPlaywrightBrowserInstallCommand(
        plan.checkPlan.environmentNeeds[0]!,
      ),
    ).toBe("pnpm --filter ./apps/web exec playwright install chromium");
  });

  it("projects vue-hono workspace scripts and preserves web Playwright package filtering", () => {
    const projection = findBuiltInPresetProjection("vue-hono-app");
    const plan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-stack" },
      preset: "vue-hono-app",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-stack" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });
    const rootCheckPlan = plan.checkPlan;
    const rootFixPlan = plan.fixPlan;

    expect(rootFixPlan.components).toEqual([
      {
        kind: "oxc-format-write",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "oxc-lint-fix",
        owner: { kind: "workspace-orchestration", path: "." },
      },
      {
        kind: "turbo-package-fix",
        owner: { kind: "package-boundary", path: "apps/*" },
      },
    ]);
    expect(renderFixCommand(rootFixPlan)).toBe(
      "turbo run format:write:run lint:fix:run fix:run --output-logs=errors-only --log-order=grouped",
    );
    expect(projectVueHonoRootPackageScripts()).toEqual({
      check:
        "pnpm run check:boundaries && turbo run format:check:run lint:run typecheck:run build:run test:run test:e2e:run check:run --output-logs=errors-only --log-order=grouped",
      "check:boundaries": "turbo boundaries --no-color",
      "check:run": 'node -e ""',
      dev: "turbo run dev --parallel",
      fix: renderFixCommand(rootFixPlan),
      "fix:run": 'node -e ""',
      "format:check":
        "turbo run format:check:run --output-logs=errors-only --log-order=grouped",
      "format:check:run":
        "oxfmt --list-different oxlint.config.ts oxfmt.config.ts",
      "format:write":
        "turbo run format:write:run --output-logs=errors-only --log-order=grouped",
      "format:write:run": "oxfmt --write oxlint.config.ts oxfmt.config.ts",
      lint: "turbo run lint:run --output-logs=errors-only --log-order=grouped",
      "lint:fix":
        "turbo run lint:fix:run --output-logs=errors-only --log-order=grouped",
      "lint:fix:run":
        "oxlint --format=unix oxlint.config.ts oxfmt.config.ts --fix",
      "lint:run":
        "oxlint --quiet --format=unix oxlint.config.ts oxfmt.config.ts",
      typecheck:
        "turbo run typecheck:run --output-logs=errors-only --log-order=grouped",
      "typecheck:run": "tsc -p tsconfig.config.json --noEmit --pretty false",
    });
    expect(projectVueHonoApiPackageScripts()).not.toHaveProperty("check");
    expect(projectVueHonoWebPackageScripts()).not.toHaveProperty("check");
    expect(rootCheckPlan.environmentNeeds).toEqual([
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
          display: "pnpm --filter ./apps/web exec playwright install chromium",
          machineVerifiable: true,
        },
      },
    ]);
    expect(
      renderPlaywrightBrowserInstallCommand(rootCheckPlan.environmentNeeds[0]!),
    ).toBe("pnpm --filter ./apps/web exec playwright install chromium");
  });

  it("projects rust-bin package scripts from Rust Check and Fix Plans", () => {
    const checkPlan = planRustBinChecks();
    const fixPlan = planRustBinFixes();

    expect(checkPlan.components.map((component) => component.kind)).toEqual([
      "rustfmt-check",
      "cargo-clippy",
      "cargo-test",
    ]);
    expect(fixPlan.components.map((component) => component.kind)).toEqual([
      "rustfmt-write",
    ]);
    expect(renderRootCheckCommand(checkPlan)).toBe(
      "turbo run format:check:run lint:run test:run check:run --output-logs=errors-only --log-order=grouped",
    );
    expect(renderFixCommand(fixPlan)).toBe(
      "turbo run format:write:run fix:run --output-logs=errors-only --log-order=grouped",
    );
    expect(renderFixCommand(fixPlan)).not.toContain("clippy");
    expect(projectRustBinPackageScripts()).toEqual({
      "format:check:run": "cargo fmt --all -- --check",
      "format:write:run": "cargo fmt --all",
      "lint:run": "cargo clippy --workspace --all-targets -- -D warnings",
      "test:run": "cargo test --workspace",
    });
  });

  it("projects GitHub check workflows from CI Capability, environment preparation, Check Plans, and pnpm Task Layer", () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    const tsLibPlan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-lib" },
      preset: "ts-lib",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-lib" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    const workflow = projectCheckWorkflow({
      checkPlan: tsLibPlan.checkPlan,
      environmentPreparation: { rustToolchain: false },
    });

    expect(workflow).toContain(
      `      - uses: ${rootCheckWorkflowCheckoutRef()}`,
    );
    expect(
      workflow.replace(/actions\/checkout@v\d+/, "actions/checkout@vN"),
    ).toBe(
      [
        "name: Check",
        "",
        "on:",
        "  pull_request:",
        "  push:",
        "    branches:",
        "      - main",
        "",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@vN",
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          node-version-file: package.json",
        "      - run: corepack enable",
        "      - run: pnpm install",
        "      - run: pnpm run check",
        "",
      ].join("\n"),
    );

    const vueProjection = findBuiltInPresetProjection("vue-app");
    const vuePlan = vueProjection!.project({
      projectName: { kind: "ProjectName", value: "demo-vue" },
      preset: "vue-app",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: vueProjection!.blueprint({ targetDir: "/tmp/demo-vue" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(projectCheckWorkflow({ checkPlan: vuePlan.checkPlan })).toContain(
      "      - run: pnpm --filter ./apps/web exec playwright install --with-deps chromium",
    );
    const rustProjection = findBuiltInPresetProjection("rust-bin");
    const rustPlan = rustProjection!.project({
      projectName: { kind: "ProjectName", value: "demo-rust" },
      preset: "rust-bin",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: rustProjection!.blueprint({ targetDir: "/tmp/demo-rust" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });
    const rustWorkflow = projectCheckWorkflow({
      checkPlan: rustPlan.checkPlan,
      environmentPreparation: { rustToolchain: true },
    });

    expect(rustWorkflow).toContain(
      "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          components: rustfmt, clippy",
    );
    expect(rustWorkflow).toContain("      - uses: Swatinem/rust-cache@v2");
  });

  it("derives additive deployment checks and Docker preparation from Check Plan facts", () => {
    const vikeProjection = findBuiltInPresetProjection("vike-app");
    const vikePlan = vikeProjection!.project({
      projectName: { kind: "ProjectName", value: "demo-vike" },
      preset: "vike-app",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: vikeProjection!.blueprint({ targetDir: "/tmp/demo-vike" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });
    const deploymentCheck = vikePlan.checkPlan.deploymentChecks?.[0];

    expect(deploymentCheck).toEqual({
      kind: "deployment-image",
      owner: { kind: "package-boundary", path: "apps/web" },
    });
    expect(deploymentCheckEnvironmentNeeds(deploymentCheck!)).toEqual([
      { kind: "docker-engine" },
    ]);
    expect(vikePlan.packageScripts.check).not.toContain("check:deployment");
    expect(vikePlan.packageScripts["check:deployment"]).toBe(
      "pnpm --filter './apps/web' run check:deployment",
    );

    const workflow = projectCheckWorkflow({ checkPlan: vikePlan.checkPlan });
    expect(workflow).toContain("docker/setup-buildx-action@v3");
    expect(workflow.indexOf("      - run: pnpm run check\n")).toBeLessThan(
      workflow.indexOf("      - run: pnpm run check:deployment\n"),
    );
    expect(workflow).not.toMatch(/docker (?:build|push|login)/u);

    const vueProjection = findBuiltInPresetProjection("vue-app");
    const vuePlan = vueProjection!.project({
      projectName: { kind: "ProjectName", value: "demo-vue" },
      preset: "vue-app",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: vueProjection!.blueprint({ targetDir: "/tmp/demo-vue" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });
    const vueWorkflow = projectCheckWorkflow({ checkPlan: vuePlan.checkPlan });

    expect(vuePlan.checkPlan.deploymentChecks).toBeUndefined();
    expect(vuePlan.packageScripts).not.toHaveProperty("check:deployment");
    expect(vueWorkflow).not.toContain("docker/setup-buildx-action");
    expect(vueWorkflow).not.toContain("check:deployment");
  });

  it("aggregates deployment check owners behind one CI task entrypoint", () => {
    const deploymentChecks = [
      {
        kind: "deployment-image" as const,
        owner: { kind: "package-boundary" as const, path: "apps/web" },
      },
      {
        kind: "deployment-image" as const,
        owner: { kind: "package-boundary" as const, path: "apps/admin" },
      },
    ];
    const checkPlan = {
      components: [],
      deploymentChecks,
      environmentNeeds: [],
    };

    expect(renderDeploymentCheckCommand(checkPlan)).toBe(
      "pnpm --filter './apps/web' run check:deployment && pnpm --filter './apps/admin' run check:deployment",
    );

    const workflow = projectCheckWorkflow({ checkPlan });
    expect(workflow.match(/docker\/setup-buildx-action@v3/gu)).toHaveLength(1);
    expect(workflow.match(/- run: pnpm run check:deployment/gu)).toHaveLength(
      1,
    );
  });

  it("projects Dependabot config from Dependency Maintenance Policy separately from Check Plans", () => {
    const projection = findBuiltInPresetProjection("ts-lib");
    const tsLibPlan = projection!.project({
      projectName: { kind: "ProjectName", value: "demo-lib" },
      preset: "ts-lib",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: projection!.blueprint({ targetDir: "/tmp/demo-lib" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(projectDependabotConfig(tsLibPlan.dependencyMaintenancePolicy)).toBe(
      [
        "version: 2",
        "",
        "updates:",
        "  - package-ecosystem: npm",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
        "    groups:",
        "      drizzle:",
        "        patterns:",
        '          - "drizzle-*"',
        '          - "drizzle-orm"',
        "    ignore:",
        '      - dependency-name: "@types/node"',
        "        update-types:",
        "          - version-update:semver-major",
        "  - package-ecosystem: github-actions",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
        "  - package-ecosystem: docker",
        "    directory: /.devcontainer",
        "    schedule:",
        "      interval: weekly",
        "    ignore:",
        "      - dependency-name: mcr.microsoft.com/devcontainers/typescript-node",
        "        update-types:",
        "          - version-update:semver-major",
        "",
      ].join("\n"),
    );

    const rustProjection = findBuiltInPresetProjection("rust-bin");
    const rustPlan = rustProjection!.project({
      projectName: { kind: "ProjectName", value: "demo-rust" },
      preset: "rust-bin",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: rustProjection!.blueprint({ targetDir: "/tmp/demo-rust" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });

    expect(
      projectDependabotConfig(rustPlan.dependencyMaintenancePolicy),
    ).toContain("package-ecosystem: cargo");
    expect(
      projectDependabotConfig(rustPlan.dependencyMaintenancePolicy),
    ).toContain(
      'package-ecosystem: cargo\n    directory: "/packages/demo-rust"',
    );
    expect(
      projectDependabotConfig(rustPlan.dependencyMaintenancePolicy),
    ).toContain("package-ecosystem: rust-toolchain");
    const vueHonoProjection = findBuiltInPresetProjection("vue-hono-app");
    const vueHonoPlan = vueHonoProjection!.project({
      projectName: { kind: "ProjectName", value: "demo-stack" },
      preset: "vue-hono-app",
      packageManager: { kind: "PackageManager", value: "pnpm" },
      blueprint: vueHonoProjection!.blueprint({ targetDir: "/tmp/demo-stack" }),
      toolchain: {
        nodeLtsMajor: { kind: "NodeLtsMajor", value: "24" },
        packageManagerPin: { kind: "PackageManagerPin", value: "pnpm@11.2.3" },
        source: "online",
        diagnostics: [],
      },
    });
    expect(
      projectDependabotConfig(vueHonoPlan.dependencyMaintenancePolicy),
    ).toContain("package-ecosystem: npm");
  });
});

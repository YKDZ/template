import {
  renderPlaywrightBrowserInstallCommand,
  renderRootCheckCommand,
  renderFixCommand,
} from "../src/module-graph.js";
import {
  projectCheckWorkflow,
  projectDependabotConfig,
} from "../src/project-github.js";
import { projectHonoApiPackageScripts } from "../templates/hono-api/projection.js";
import { findBuiltInPresetProjection } from "../templates/registry.js";
import {
  planRustBinChecks,
  planRustBinFixes,
  projectRustBinPackageScripts,
} from "../templates/rust-bin/projection.js";
import { projectTsLibPackageScripts } from "../templates/ts-lib/projection.js";
import { projectVueAppPackageScripts } from "../templates/vue-app/projection.js";
import {
  projectVueHonoApiPackageScripts,
  projectVueHonoRootPackageScripts,
  projectVueHonoWebPackageScripts,
} from "../templates/vue-hono-app/projection.js";

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
        kind: "turbo-check",
        owner: { kind: "package-boundary", path: "." },
      },
    ]);

    expect(plan.fixPlan.components).toEqual([
      {
        kind: "turbo-fix",
        owner: { kind: "package-boundary", path: "." },
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
      "turbo-check",
    ]);
    expect(fixPlan.components.map((component) => component.kind)).toEqual([
      "turbo-fix",
    ]);

    expect(renderRootCheckCommand(checkPlan)).toBe("turbo run check");
    expect(renderFixCommand(fixPlan)).toBe("turbo run fix");
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
      check: "turbo run check",
      fix: "turbo run fix",
    });
    expect(projectTsLibPackageScripts()).toEqual({
      build: "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
      check: "pnpm run typecheck && pnpm run lint && pnpm run format:check",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check --config ../../oxfmt.config.ts .",
      "format:write": "oxfmt --write --config ../../oxfmt.config.ts .",
      lint: "oxlint --config ../../oxlint.config.ts . --deny-warnings",
      "lint:fix":
        "oxlint --config ../../oxlint.config.ts . --fix --deny-warnings",
      typecheck: "tsc -p tsconfig.json --noEmit",
    });
  });

  it("projects hono-api package scripts from Check and Fix Plans", () => {
    expect(projectHonoApiPackageScripts()).toEqual({
      build: "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
      check:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt --write .",
      lint: "oxlint . --deny-warnings",
      "lint:fix": "oxlint . --fix --deny-warnings",
      start: "node dist/server.js",
      test: "vitest run",
      typecheck: "tsc -p tsconfig.json --noEmit",
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
      build: "vite build",
      check:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test && pnpm run test:e2e",
      dev: "vite",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt --write .",
      lint: "oxlint . --deny-warnings",
      "lint:fix": "oxlint . --fix --deny-warnings",
      preview: "vite preview",
      test: "vitest run",
      "test:e2e": "pnpm run build && playwright test",
      typecheck: "vue-tsc --build --noEmit",
    });
    expect(plan.checkPlan.environmentNeeds).toEqual([
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "package-boundary", path: "." },
      },
    ]);
    expect(
      renderPlaywrightBrowserInstallCommand(plan.checkPlan.environmentNeeds[0]),
    ).toBe("pnpm exec playwright install chromium");
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
        kind: "turbo-fix",
        owner: { kind: "package-boundary", path: "." },
      },
    ]);
    expect(renderFixCommand(rootFixPlan)).toBe("turbo run fix");
    expect(projectVueHonoRootPackageScripts()).toEqual({
      check: "turbo run check",
      dev: "turbo run dev --parallel",
      fix: renderFixCommand(rootFixPlan),
    });
    expect(projectVueHonoApiPackageScripts().check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test",
    );
    expect(projectVueHonoWebPackageScripts().check).toBe(
      "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm run build && pnpm run test && pnpm run test:e2e",
    );
    expect(rootCheckPlan.environmentNeeds).toEqual([
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "package-boundary", path: "apps/web" },
      },
    ]);
    expect(
      renderPlaywrightBrowserInstallCommand(rootCheckPlan.environmentNeeds[0]),
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
      "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
    );
    expect(renderFixCommand(fixPlan)).toBe("cargo fmt --all");
    expect(renderFixCommand(fixPlan)).not.toContain("clippy");
    expect(projectRustBinPackageScripts()).toEqual({
      check:
        "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace",
      fix: "cargo fmt --all",
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

    expect(
      projectCheckWorkflow({
        checkPlan: tsLibPlan.checkPlan,
        environmentPreparation: { rustToolchain: false },
      }),
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
        "      - uses: actions/checkout@v6",
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
      "      - run: pnpm exec playwright install --with-deps chromium",
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
        "updates:",
        "  - package-ecosystem: npm",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
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

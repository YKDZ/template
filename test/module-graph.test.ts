import {
  planNodeChecks,
  planNodeFixes,
  planRustBinChecks,
  planRustBinFixes,
  planTsLibChecks,
  planTsLibFixes,
  renderPlaywrightBrowserInstallCommand,
  renderRootCheckCommand,
  renderFixCommand,
  selectNodeCheckComponents,
  selectTsLibCheckComponents,
  selectTsLibFixComponents,
} from "../src/module-graph.js";
import { projectHonoApiPackageScripts } from "../src/hono-api.js";
import { projectRustBinPackageScripts } from "../src/rust-bin.js";
import { projectTsLibPackageScripts } from "../src/ts-lib.js";
import { projectVueAppPackageScripts } from "../src/vue-app.js";
import {
  projectVueHonoApiPackageScripts,
  projectVueHonoRootPackageScripts,
  projectVueHonoWebPackageScripts,
} from "../src/vue-hono-app.js";

describe("module graph plans", () => {
  it("selects semantic Check and Fix Components for the ts-lib package boundary", () => {
    expect(selectTsLibCheckComponents()).toEqual([
      {
        kind: "typescript-typecheck",
        owner: { kind: "package-boundary", path: "." },
      },
      {
        kind: "oxc-lint",
        owner: { kind: "package-boundary", path: "." },
      },
      {
        kind: "oxc-format-check",
        owner: { kind: "package-boundary", path: "." },
      },
    ]);

    expect(selectTsLibFixComponents()).toEqual([
      {
        kind: "oxc-format-write",
        owner: { kind: "package-boundary", path: "." },
      },
      {
        kind: "oxc-lint-fix",
        owner: { kind: "package-boundary", path: "." },
      },
    ]);
  });

  it("orders ts-lib Check and Fix Plans before rendering Root Check and Fix Command strings", () => {
    const checkPlan = planTsLibChecks();
    const fixPlan = planTsLibFixes();

    expect(checkPlan.components.map((component) => component.kind)).toEqual([
      "typescript-typecheck",
      "oxc-lint",
      "oxc-format-check",
    ]);
    expect(fixPlan.components.map((component) => component.kind)).toEqual([
      "oxc-format-write",
      "oxc-lint-fix",
    ]);

    expect(renderRootCheckCommand(checkPlan)).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    );
    expect(renderFixCommand(fixPlan)).toBe("pnpm run format:write && pnpm run lint:fix");
  });

  it("projects ts-lib package scripts from Check and Fix Plans", () => {
    expect(projectTsLibPackageScripts()).toEqual({
      build: "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
      check: "pnpm run typecheck && pnpm run lint && pnpm run format:check",
      fix: "pnpm run format:write && pnpm run lint:fix",
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt --write .",
      lint: "oxlint . --deny-warnings",
      "lint:fix": "oxlint . --fix --deny-warnings",
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
    const checkPlan = planNodeChecks("vue-app");

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
    expect(checkPlan.environmentNeeds).toEqual([
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "package-boundary", path: "." },
      },
    ]);
    expect(renderPlaywrightBrowserInstallCommand(checkPlan.environmentNeeds[0])).toBe(
      "pnpm exec playwright install chromium",
    );
  });

  it("projects vue-hono workspace scripts and preserves web Playwright package filtering", () => {
    const rootCheckPlan = planNodeChecks("vue-hono-root");
    const rootFixPlan = planNodeFixes("vue-hono-root");

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
    expect(selectNodeCheckComponents("vue-hono-api")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: { kind: "package-boundary", path: "apps/api" } }),
      ]),
    );
    expect(selectNodeCheckComponents("vue-hono-web")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: { kind: "package-boundary", path: "apps/web" } }),
      ]),
    );
    expect(rootCheckPlan.environmentNeeds).toEqual([
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "package-boundary", path: "apps/web" },
      },
    ]);
    expect(renderPlaywrightBrowserInstallCommand(rootCheckPlan.environmentNeeds[0])).toBe(
      "pnpm --filter ./apps/web exec playwright install chromium",
    );
  });

  it("projects rust-bin package scripts from Rust Check and Fix Plans", () => {
    const checkPlan = planRustBinChecks();
    const fixPlan = planRustBinFixes();

    expect(checkPlan.components.map((component) => component.kind)).toEqual([
      "rustfmt-check",
      "cargo-clippy",
      "cargo-test",
    ]);
    expect(fixPlan.components.map((component) => component.kind)).toEqual(["rustfmt-write"]);
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
});

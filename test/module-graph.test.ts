import {
  planTsLibChecks,
  planTsLibFixes,
  renderRootCheckCommand,
  renderFixCommand,
  selectTsLibCheckComponents,
  selectTsLibFixComponents,
} from "../src/module-graph.js";
import { projectTsLibPackageScripts } from "../src/ts-lib.js";

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
});

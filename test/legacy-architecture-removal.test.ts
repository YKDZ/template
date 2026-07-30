import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkLegacyArchitectureRemoval,
  findLegacyArchitectureFindings,
  findLegacyArchitectureDistributionFindings,
  findLegacyArchitectureTarballFindings,
  findPackedTaskVocabularyFindings,
} from "../packages/checks/src/check-legacy-architecture-removal.ts";

async function fixture(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "template-removal-audit-"));
}

describe("Legacy Architecture Removal Check", () => {
  it("rejects every retired fixture replay API, marker, transport, and compatibility surface", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/checks/src"), { recursive: true }),
        mkdir(path.join(root, ".github/workflows"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/checks/src/replay-compat.ts"),
          [
            "export type GeneratedScenarioReplayCache = { directory: string };",
            "export function fixtureReplayCacheFromEnv(): GeneratedScenarioReplayCache | undefined {",
            "  const replayCache = process.env.TEMPLATE_FIXTURE_REPLAY_CACHE_DIR;",
            "  return replayCache === undefined ? undefined : { directory: replayCache };",
            "}",
            'export const marker = `${"identity"}.passed`;',
            'export const compatibilityFlag = "TEMPLATE_FIXTURE_EVIDENCE_REPLAY_COMPAT";',
          ].join("\n"),
        ),
        writeFile(
          path.join(root, ".github/workflows/check.yml"),
          [
            "env:",
            "  TEMPLATE_FIXTURE_REPLAY_CACHE_READ: '1'",
            "steps:",
            "  - uses: actions/cache/restore@v6",
            "    with:",
            "      path: .fixture-replay-cache",
            "      key: fixture-replay-linux",
          ].join("\n"),
        ),
        writeFile(
          path.join(root, "turbo.json"),
          JSON.stringify({
            tasks: {
              check: {
                passThroughEnv: ["TEMPLATE_FIXTURE_REPLAY_CACHE_WRITE"],
              },
            },
          }),
        ),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "retired-fixture-replay-symbol",
            file: "packages/checks/src/replay-compat.ts",
          }),
          expect.objectContaining({
            rule: "retired-fixture-replay-surface",
            file: "packages/checks/src/replay-compat.ts",
          }),
          expect.objectContaining({
            rule: "retired-fixture-replay-marker",
            file: "packages/checks/src/replay-compat.ts",
          }),
          expect.objectContaining({
            rule: "retired-fixture-replay-surface",
            file: ".github/workflows/check.yml",
          }),
          expect.objectContaining({
            rule: "retired-fixture-replay-surface",
            file: "turbo.json",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a focused finding for every protected surface", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/builtin-source"), {
          recursive: true,
        }),
        mkdir(path.join(root, "packages/core/src"), { recursive: true }),
        mkdir(path.join(root, "packages/cli/src"), { recursive: true }),
        mkdir(path.join(root, "test"), { recursive: true }),
        mkdir(path.join(root, "docs"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/core/src/old.ts"),
          `import { x } from "./preset-${"source"}.ts";\nexport { x } from "./preset-${"source"}.ts";\nexport type ${"Preset"}Source = typeof x;`,
        ),
        writeFile(
          path.join(root, "packages/core/src/renderer.ts"),
          'export function driver(path: string) { if (path === "turbo.json") return "structured"; return "text"; }',
        ),
        writeFile(
          path.join(root, "packages/cli/src/cli.ts"),
          `const help = "schema preset";`,
        ),
        writeFile(
          path.join(root, "test/identity.test.ts"),
          `const selected = "ts-${"lib"}"; if (selected === "ts-${"lib"}") {}`,
        ),
        writeFile(path.join(root, "docs/current.md"), `${"Preset"} Source`),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "retired-path" }),
          expect.objectContaining({ rule: "legacy-import-export" }),
          expect.objectContaining({ rule: "retired-symbol" }),
          expect.objectContaining({ rule: "generic-preset-identity" }),
          expect.objectContaining({ rule: "retired-vocabulary" }),
          expect.objectContaining({ rule: "retired-cli-command" }),
          expect.objectContaining({ rule: "identity-branch" }),
          expect.objectContaining({ rule: "foundation-output-branch" }),
        ]),
      );
      await expect(checkLegacyArchitectureRemoval(root)).rejects.toThrow(
        /\[retired-symbol\].*old\.ts/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves composed identities, aliases, re-exports, and non-if catalogs", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/core/src"), { recursive: true }),
        mkdir(path.join(root, "packages/cli/src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/core/src/legacy.ts"),
          `export type ${"Preset"}Source = string;`,
        ),
        writeFile(
          path.join(root, "packages/core/src/re-export.ts"),
          `export { ${"Preset"}Source as Old } from "./legacy.ts";`,
        ),
        writeFile(
          path.join(root, "packages/core/src/catalog.ts"),
          [
            `import type { Old } from "./re-export.ts";`,
            `const first = "ts-" + "lib";`,
            `const catalog: readonly Old[] = [first, \`rust-${"bin"}\`];`,
            `switch (first) { case "ts-lib": break; }`,
            `const selected = first === "ts-lib" ? "yes" : "no";`,
            `void [catalog, selected];`,
          ].join("\n"),
        ),
        writeFile(
          path.join(root, "packages/cli/src/help.ts"),
          `const command = "schema" + " preset"; void command;`,
        ),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "retired-symbol" }),
          expect.objectContaining({ rule: "closed-identity-catalog" }),
          expect.objectContaining({ rule: "identity-branch" }),
          expect.objectContaining({ rule: "retired-cli-command" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits historical ADR vocabulary only with an ADR-0093 supersession note", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, "docs/adr"), { recursive: true });
      await writeFile(
        path.join(root, "docs/adr/0001-old.md"),
        `${"Preset"} Source`,
      );
      await expect(checkLegacyArchitectureRemoval(root)).rejects.toThrow(
        /historical-adr-status/u,
      );
      await writeFile(
        path.join(root, "docs/adr/0001-old.md"),
        `Superseded by ADR-0093.\n\n${"Preset"} Source`,
      );
      await expect(
        checkLegacyArchitectureRemoval(root),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects retired runtime and test paths in a packed public artifact", () => {
    expect(
      findLegacyArchitectureTarballFindings([
        "package/dist/cli.js",
        `package/node_modules/@ykdz/template-builtin-${"source"}/index.js`,
        "package/node_modules/@ykdz/template-builtin-presets/dist/src/example/behavior.test.js",
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "packed-artifact" }),
      ]),
    );
  });

  it("audits package exports, dependencies, and built declaration or JavaScript leakage", async () => {
    const root = await fixture();
    try {
      await Promise.all(
        ["cli", "builtin-presets", "core"].map(
          async (name) =>
            await mkdir(path.join(root, "packages", name, "dist"), {
              recursive: true,
            }),
        ),
      );
      await Promise.all([
        writeFile(
          path.join(root, "packages/cli/package.json"),
          JSON.stringify({
            exports: { "./registry-checks": "./dist/check.js" },
          }),
        ),
        writeFile(
          path.join(root, "packages/builtin-presets/package.json"),
          "{}",
        ),
        writeFile(path.join(root, "packages/core/package.json"), "{}"),
        writeFile(
          path.join(root, "packages/builtin-presets/dist/registry-checks.d.ts"),
          "export {};",
        ),
      ]);
      await expect(
        findLegacyArchitectureDistributionFindings(root),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "package-manifest-export" }),
          expect.objectContaining({ rule: "built-artifact" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require unrelated distribution artifacts during a source-focused audit", async () => {
    const root = await fixture();
    try {
      await Promise.all(
        ["cli", "builtin-presets", "core"].map(
          async (name) =>
            await mkdir(path.join(root, "packages", name), {
              recursive: true,
            }),
        ),
      );
      await Promise.all(
        ["cli", "builtin-presets", "core"].map(
          async (name) =>
            await writeFile(
              path.join(root, "packages", name, "package.json"),
              "{}",
            ),
        ),
      );

      await expect(
        findLegacyArchitectureDistributionFindings(root),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores local package-manager stores outside repository ownership", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, ".pnpm-store/v11/files"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, ".pnpm-store/v11/files/third-party-cache"),
        "Preset File build:run",
      );

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores local fixture cache directories outside repository ownership", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, ".fixture-native-cache/pnpm/v11/files/00"), {
          recursive: true,
        }),
        mkdir(path.join(root, ".fixture-evidence/activity"), {
          recursive: true,
        }),
        mkdir(path.join(root, ".fixture-workspace/template-generated-check-x"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, ".fixture-native-cache/pnpm/v11/files/00/cache"),
          "Preset File\n",
        ),
        writeFile(
          path.join(root, ".fixture-evidence/activity/event.jsonl"),
          "Transit Task\n",
        ),
        writeFile(
          path.join(
            root,
            ".fixture-workspace/template-generated-check-x/source.ts",
          ),
          "export const rootTask = true;\n",
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects retired task selection from source, generated manifests, documentation, and builds", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/core/src"), { recursive: true }),
        mkdir(path.join(root, "packages/cli/dist"), { recursive: true }),
        mkdir(path.join(root, "packages/builtin-presets"), { recursive: true }),
        mkdir(path.join(root, "packages/core"), { recursive: true }),
        mkdir(path.join(root, "docs/adr"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/core/src/legacy-task.ts"),
          [
            `export type ${"Check"}Plan = readonly string[];`,
            `const deployment${"Owner"} = "apps/web";`,
            'const compatibility = "legacy task-model migration";',
            `const manifest = { scripts: { check: "turbo run lint --filter=./apps/web" } };`,
            "void [compatibility, deploymentOwner, manifest];",
          ].join("\n"),
        ),
        writeFile(
          path.join(root, "package.json"),
          JSON.stringify({
            name: "generated-project",
            scripts: {
              "check:run": "turbo run lint",
              check: "turbo run lint --filter=./apps/web",
            },
          }),
        ),
        writeFile(path.join(root, "docs/current.md"), `${"Fix"} Component`),
        writeFile(
          path.join(root, "docs/adr/0001-old-task-model.md"),
          `${"Check"} Plan`,
        ),
        writeFile(path.join(root, "packages/cli/package.json"), "{}"),
        writeFile(
          path.join(root, "packages/builtin-presets/package.json"),
          "{}",
        ),
        writeFile(path.join(root, "packages/core/package.json"), "{}"),
        writeFile(
          path.join(root, "packages/cli/dist/legacy.js"),
          `export const task = "${"deployment"} owner";`,
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "retired-task-symbol" }),
          expect.objectContaining({ rule: "deployment-owner-registration" }),
          expect.objectContaining({ rule: "task-model-compatibility" }),
          expect.objectContaining({ rule: "generated-task-filter" }),
          expect.objectContaining({ rule: "retired-task-script" }),
          expect.objectContaining({ rule: "retired-task-vocabulary" }),
          expect.objectContaining({ rule: "historical-task-adr-status" }),
          expect.objectContaining({ rule: "built-artifact-task-vocabulary" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects old plan fields, render-owner parameters, and composed Turbo filters", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/core/src"), { recursive: true }),
        mkdir(path.join(root, "packages/builtin-presets/src"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/core/src/package-contribution.ts"),
          "export type PackageContribution = { checks: string[]; fixes: string[]; components: string[] };",
        ),
        writeFile(
          path.join(root, "packages/builtin-presets/src/foundation.ts"),
          "export type GeneratedRepositoryPlan = { checkPlan: string[]; deploymentChecks: string[] };",
        ),
        writeFile(
          path.join(root, "packages/core/src/module-graph.ts"),
          [
            "export function renderRootCheckCommand({ owner, filter }: { owner: string; filter: string }) {",
            '  const runner = "turbo" + " run build";',
            '  const selection = "--" + "filter=./apps/web";',
            '  return [runner, selection].join(" ");',
            "}",
          ].join("\n"),
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "retired-task-plan-field" }),
          expect.objectContaining({ rule: "retired-task-render-parameter" }),
          expect.objectContaining({ rule: "generated-task-filter" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects retired Development Container capability APIs and switches", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/core/src"), { recursive: true }),
        mkdir(
          path.join(
            root,
            "packages/builtin-presets/templates/foundation/rust/devcontainer",
          ),
          { recursive: true },
        ),
        mkdir(
          path.join(
            root,
            "packages/builtin-presets/templates/rust-bin/devcontainer",
          ),
          { recursive: true },
        ),
        mkdir(
          path.join(
            root,
            "packages/builtin-presets/templates/shared/devcontainer",
          ),
          { recursive: true },
        ),
        mkdir(path.join(root, "packages/checks/src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/core/src/devcontainer.ts"),
          [
            `export type ${"DevelopmentContainer"}RustLayer = { kind: "rust" };`,
            `export type ${"DevelopmentContainer"}Capability = { kind: "docker-client" };`,
            `export type ${"RustDevelopmentContainer"}Options = { toolchain: string };`,
            `export function ${"rustTool"}Layer() { return { kind: "rust" }; }`,
            `export function ${"createRustDevelopmentContainer"}Layer() { return { kind: "rust" }; }`,
            `export function ${"developmentContainerCapability"}Compatibility() {}`,
            `export function ${"dockerfileFirstRustPnpm"}Devcontainer() {}`,
            `export function select(layer: { kind: string }) {`,
            `  switch (layer.kind) { case "rust": return true; case "docker-client": return true; default: return false; }`,
            `}`,
          ].join("\n"),
        ),
        writeFile(
          path.join(
            root,
            "packages/builtin-presets/templates/foundation/rust/devcontainer/rust.Dockerfile",
          ),
          "RUN rustup --version\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/builtin-presets/templates/rust-bin/devcontainer/devcontainer.json",
          ),
          "{}\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/builtin-presets/templates/shared/devcontainer/shellcheck.Dockerfile",
          ),
          "RUN apt-get update && apt-get install -y shellcheck\n",
        ),
        writeFile(
          path.join(
            root,
            "packages/builtin-presets/templates/shared/devcontainer/rust.Dockerfile",
          ),
          "RUN rustup toolchain install stable\n",
        ),
        writeFile(
          path.join(root, "packages/checks/src/check-generated-registry.ts"),
          [
            `async function ${"ensureHostFixtureDependencies"}() {`,
            `  await run("rustup", ["toolchain", "install", "stable"], { cwd: "." });`,
            `  await run("pnpm", ["exec", "playwright", "install", "--with-deps", "chromium"], { cwd: "." });`,
            `}`,
          ].join("\n"),
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "retired-development-container-path",
            file: "packages/core/src/devcontainer.ts",
          }),
          expect.objectContaining({
            rule: "retired-development-container-symbol",
            file: "packages/core/src/devcontainer.ts",
          }),
          expect.objectContaining({
            rule: "retired-development-container-switch",
            file: "packages/core/src/devcontainer.ts",
          }),
          expect.objectContaining({
            rule: "retired-development-container-compatibility",
            file: "packages/core/src/devcontainer.ts",
          }),
          expect.objectContaining({
            rule: "retired-development-container-path",
            file: "packages/builtin-presets/templates/foundation/rust",
          }),
          expect.objectContaining({
            rule: "retired-development-container-path",
            file: "packages/builtin-presets/templates/rust-bin/devcontainer/devcontainer.json",
          }),
          expect.objectContaining({
            rule: "retired-development-container-path",
            file: "packages/builtin-presets/templates/shared/devcontainer/shellcheck.Dockerfile",
          }),
          expect.objectContaining({
            rule: "retired-development-container-path",
            file: "packages/builtin-presets/templates/shared/devcontainer/rust.Dockerfile",
          }),
          expect.objectContaining({
            rule: "host-prepared-fixture-execution",
            file: "packages/checks/src/check-generated-registry.ts",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sibling Preset imports", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, "packages/builtin-presets/src/vike-app"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "packages/builtin-presets/src/vike-app/definition.ts"),
        `import { vueAppDefinition } from "../vue-${"app"}/definition.ts"; void vueAppDefinition;`,
      );

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "preset-sibling-import",
            file: "packages/builtin-presets/src/vike-app/definition.ts",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits the package-local Turbo prepack build selector", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, "packages/builtin-presets/src"), {
        recursive: true,
      });
      await Promise.all([
        writeFile(
          path.join(root, "packages/builtin-presets/src/definition.ts"),
          'export const prepack = "pnpm exec turbo run build --filter=.";\n',
        ),
        writeFile(
          path.join(root, "packages/builtin-presets/package.json"),
          JSON.stringify({
            name: "@example/preset",
            scripts: {
              prepack: "pnpm exec turbo run build --filter=.",
            },
          }),
        ),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      expect(
        findings.filter((finding) => finding.rule === "generated-task-filter"),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the retired public CLI parser, manual prepack chain, and packed lifecycle bypass", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/cli/src"), { recursive: true }),
        mkdir(path.join(root, "test"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/cli/src/main.ts"),
          "function parseInitOptions(args: readonly string[]) { return args; }\n",
        ),
        writeFile(
          path.join(root, "packages/cli/package.json"),
          JSON.stringify({
            name: "@ykdz/template",
            scripts: {
              prepack:
                "pnpm --filter @ykdz/template-core run build && pnpm run build",
            },
          }),
        ),
        writeFile(
          path.join(root, "test/packed-publication.test.ts"),
          'const packArgs = ["--config.ignore-scripts=true"];\n',
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "hand-written-cli-parser" }),
          expect.objectContaining({ rule: "manual-prepack-chain" }),
          expect.objectContaining({ rule: "packed-lifecycle-bypass" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directly executed TypeScript without native erasability enforcement", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/missing/scripts"), {
          recursive: true,
        }),
        mkdir(path.join(root, "packages/disabled/scripts"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/missing/package.json"),
          JSON.stringify({
            name: "@example/missing",
            scripts: { check: "node scripts/check.ts" },
          }),
        ),
        writeFile(
          path.join(root, "packages/missing/tsconfig.json"),
          JSON.stringify({ compilerOptions: { strict: true } }),
        ),
        writeFile(
          path.join(root, "packages/missing/scripts/check.ts"),
          "export {};\n",
        ),
        writeFile(
          path.join(root, "packages/disabled/package.json"),
          JSON.stringify({
            name: "@example/disabled",
            scripts: { check: "node scripts/check.ts" },
          }),
        ),
        writeFile(
          path.join(root, "packages/disabled/tsconfig.json"),
          JSON.stringify({
            compilerOptions: { erasableSyntaxOnly: false },
          }),
        ),
        writeFile(
          path.join(root, "packages/disabled/scripts/check.ts"),
          "export {};\n",
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "non-erasable-typescript-config",
            file: "packages/missing/tsconfig.json",
          }),
          expect.objectContaining({
            rule: "non-erasable-typescript-config",
            file: "packages/disabled/tsconfig.json",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-erasable TypeScript syntax in repository-authored source", async () => {
    const root = await fixture();
    try {
      const sourceRoot = path.join(root, "packages/api/src");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(
        path.join(sourceRoot, "legacy.ts"),
        [
          "enum Status { Ready }",
          "namespace RuntimeState { export const ready = true; }",
          "export class Service {",
          "  constructor(readonly name: string) {}",
          "}",
          "",
        ].join("\n"),
      );

      const findings = await findLegacyArchitectureFindings(root);
      expect(
        findings.filter(
          ({ rule }) => rule === "non-erasable-typescript-syntax",
        ),
      ).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not scan non-erasable negative fixtures or generated output", async () => {
    const root = await fixture();
    const source = "enum HistoricalExample { Retired }\n";
    try {
      await Promise.all([
        mkdir(path.join(root, "test/fixtures/erasability"), {
          recursive: true,
        }),
        mkdir(path.join(root, "generated-repository/example"), {
          recursive: true,
        }),
        mkdir(path.join(root, "docs/adr"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "test/fixtures/erasability/non-erasable.ts"),
          source,
        ),
        writeFile(
          path.join(root, "generated-repository/example/non-erasable.ts"),
          source,
        ),
        writeFile(
          path.join(root, "docs/adr/0001-historical.md"),
          `Historical example:\n\n\`\`\`ts\n${source}\`\`\`\n`,
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects TypeScript runtime loaders and source runners", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/cli"), { recursive: true }),
        mkdir(path.join(root, "packages/builtin-presets/src"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/cli/package.json"),
          JSON.stringify({
            name: "@example/cli",
            scripts: {
              dev: "node --loader ts-node/esm src/cli.ts",
              check: "tsx scripts/check.ts",
            },
          }),
        ),
        writeFile(
          path.join(root, "packages/builtin-presets/src/definition.ts"),
          'export const sourceCommand = "node --import tsx src/cli.ts";\n',
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "typescript-runtime-loader",
            file: "packages/cli/package.json",
          }),
          expect.objectContaining({
            rule: "typescript-runtime-loader",
            file: "packages/builtin-presets/src/definition.ts",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects TypeScript paths aliases and alias rewriting", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/api"), { recursive: true }),
        mkdir(path.join(root, "packages/builtin-presets/src"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/api/tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              paths: { "#/*": ["./src/*"] },
            },
          }),
        ),
        writeFile(
          path.join(root, "packages/api/package.json"),
          JSON.stringify({
            name: "@example/api",
            scripts: {
              build: "tsc -p tsconfig.build.json && tsc-alias",
            },
            devDependencies: { "tsc-alias": "1.0.0" },
          }),
        ),
        writeFile(
          path.join(root, "packages/builtin-presets/src/definition.ts"),
          'export const build = "tsc && tsc-alias";\n',
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "typescript-path-alias",
            file: "packages/api/tsconfig.json",
          }),
          expect.objectContaining({
            rule: "typescript-path-alias",
            file: "packages/api/package.json",
          }),
          expect.objectContaining({
            rule: "typescript-path-alias",
            file: "packages/builtin-presets/src/definition.ts",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Generated Repository Vitest resolver aliases structurally", async () => {
    const root = await fixture();
    try {
      const configDirectory = path.join(
        root,
        "packages/builtin-presets/templates/vue-app",
      );
      const checksDirectory = path.join(root, "packages/checks");
      await Promise.all([
        mkdir(configDirectory, { recursive: true }),
        mkdir(checksDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(configDirectory, "vitest.config.ts"),
          [
            'import { defineConfig } from "vitest/config";',
            "export default defineConfig({",
            '  resolve: { alias: { "@": "./src" } },',
            "  test: { globals: true },",
            "});",
            "",
          ].join("\n"),
        ),
        writeFile(
          path.join(checksDirectory, "package.json"),
          JSON.stringify({
            exports: { "./check-generated-registry": null },
          }),
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual([
        expect.objectContaining({
          rule: "vitest-resolver-alias",
          file: "packages/builtin-presets/templates/vue-app/vitest.config.ts",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects manual cross-package build chains outside Turbo topology", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/web"), { recursive: true }),
        mkdir(path.join(root, "packages/builtin-presets/src"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/web/package.json"),
          JSON.stringify({
            name: "@example/web",
            scripts: {
              "test:e2e": "pnpm --dir ../api run build && playwright test",
            },
          }),
        ),
        writeFile(
          path.join(root, "packages/builtin-presets/src/definition.ts"),
          'export const deployment = "pnpm --filter @example/api run build && node dist/server.js";\n',
        ),
      ]);

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "manual-dependency-build-chain",
            file: "packages/web/package.json",
          }),
          expect.objectContaining({
            rule: "manual-dependency-build-chain",
            file: "packages/builtin-presets/src/definition.ts",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects lifecycle bypasses in active generated-template checks", async () => {
    const root = await fixture();
    try {
      const checkRoot = path.join(root, "packages/builtin-presets/src");
      await mkdir(checkRoot, { recursive: true });
      await writeFile(
        path.join(checkRoot, "check-template-source.ts"),
        'const installArgs = ["install", "--ignore-scripts"];\n',
      );

      await expect(findLegacyArchitectureFindings(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "packed-lifecycle-bypass",
            file: "packages/builtin-presets/src/check-template-source.ts",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects retired task words through Markdown and YAML punctuation, requiring explicit ADR-0094 supersession", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "docs/adr"), { recursive: true }),
        mkdir(path.join(root, ".github/workflows"), { recursive: true }),
      ]);
      await writeFile(
        path.join(root, "docs/current.md"),
        "Use `check:run` for this task.",
      );
      await writeFile(
        path.join(root, ".github/workflows/check.yml"),
        "check:run: turbo run check:run",
      );
      await writeFile(
        path.join(root, "docs/adr/0001-old.md"),
        "ADR-0094 describes this old `check:run` command.",
      );
      await expect(checkLegacyArchitectureRemoval(root)).rejects.toThrow(
        /historical-task-adr-status/u,
      );
      await writeFile(
        path.join(root, "docs/adr/0001-old.md"),
        "Superseded by ADR-0094.\n\nOld `check:run` command.",
      );
      const findings = await findLegacyArchitectureFindings(root);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "retired-task-vocabulary" }),
        ]),
      );
      expect(
        findings.filter((entry) => entry.file.endsWith("0001-old.md")),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires every bundled root and audits repository-owned packed source", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(
          path.join(
            root,
            "node_modules/@ykdz/template-builtin-presets/templates/web/.github",
          ),
          { recursive: true },
        ),
        mkdir(
          path.join(root, "node_modules/@ykdz/template-builtin-presets/dist"),
          { recursive: true },
        ),
        mkdir(path.join(root, "node_modules/typescript/lib"), {
          recursive: true,
        }),
      ]);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          bundleDependencies: [
            "@ykdz/template-builtin-presets",
            "@ykdz/template-core",
            "typescript",
          ],
        }),
      );
      await Promise.all([
        writeFile(
          path.join(
            root,
            "node_modules/@ykdz/template-builtin-presets/templates/web/Dockerfile",
          ),
          "RUN pnpm run build:run",
        ),
        writeFile(
          path.join(
            root,
            "node_modules/@ykdz/template-builtin-presets/templates/web/.github/check.yml",
          ),
          "check:run: pnpm run check:run",
        ),
        writeFile(
          path.join(
            root,
            "node_modules/@ykdz/template-builtin-presets/templates/web/legacy.sh",
          ),
          "turbo run transit",
        ),
        writeFile(
          path.join(root, "node_modules/typescript/lib/typesMap.json"),
          '{"transit":"third-party vocabulary"}',
        ),
      ]);

      const findings = await findPackedTaskVocabularyFindings(root);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "packed-artifact-task-vocabulary",
            file: expect.stringContaining("templates/web/Dockerfile"),
          }),
          expect.objectContaining({
            rule: "packed-bundled-root",
            file: "node_modules/@ykdz/template-core",
          }),
        ]),
      );
      expect(
        findings.some(({ file }) => file.includes("node_modules/typescript")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

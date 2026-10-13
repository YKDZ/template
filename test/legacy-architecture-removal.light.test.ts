import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

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

void describe("Legacy Architecture Removal Check", () => {
  void it("rejects every retired fixture replay API, marker, transport, and compatibility surface", async () => {
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
      for (const [rule, file] of [
        [
          "retired-fixture-replay-symbol",
          "packages/checks/src/replay-compat.ts",
        ],
        [
          "retired-fixture-replay-surface",
          "packages/checks/src/replay-compat.ts",
        ],
        [
          "retired-fixture-replay-marker",
          "packages/checks/src/replay-compat.ts",
        ],
        ["retired-fixture-replay-surface", ".github/workflows/check.yml"],
        ["retired-fixture-replay-surface", "turbo.json"],
      ] as const) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === rule &&
              Object.hasOwn(finding, "file") &&
              finding.file === file,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("reports a focused finding for every protected surface", async () => {
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
          `import { x } from "./preset-source.ts";\nexport { x } from "./preset-source.ts";\nexport type PresetSource = typeof x;`,
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
          `const selected = "ts-lib"; if (selected === "ts-lib") {}`,
        ),
        writeFile(path.join(root, "docs/current.md"), `Preset Source`),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      for (const rule of [
        "retired-path",
        "legacy-import-export",
        "retired-symbol",
        "generic-preset-identity",
        "retired-vocabulary",
        "retired-cli-command",
        "identity-branch",
        "foundation-output-branch",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") && finding.rule === rule,
          ),
        );
      }
      await assert.rejects(
        checkLegacyArchitectureRemoval(root),
        (error: unknown) =>
          error instanceof Error &&
          /\[retired-symbol\].*old\.ts/u.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("resolves composed identities, aliases, re-exports, and non-if catalogs", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, "packages/core/src"), { recursive: true }),
        mkdir(path.join(root, "packages/cli/src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "packages/core/src/legacy.ts"),
          `export type PresetSource = string;`,
        ),
        writeFile(
          path.join(root, "packages/core/src/re-export.ts"),
          `export { PresetSource as Old } from "./legacy.ts";`,
        ),
        writeFile(
          path.join(root, "packages/core/src/catalog.ts"),
          [
            `import type { Old } from "./re-export.ts";`,
            `const first = "ts-" + "lib";`,
            `const catalog: readonly Old[] = [first, \`rust-bin\`];`,
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
      for (const rule of [
        "retired-symbol",
        "closed-identity-catalog",
        "identity-branch",
        "retired-cli-command",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") && finding.rule === rule,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("permits historical ADR vocabulary only with an ADR-0093 supersession note", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, "docs/adr"), { recursive: true });
      await writeFile(path.join(root, "docs/adr/0001-old.md"), `Preset Source`);
      await assert.rejects(
        checkLegacyArchitectureRemoval(root),
        (error: unknown) =>
          error instanceof Error &&
          /historical-adr-status/u.test(error.message),
      );
      await writeFile(
        path.join(root, "docs/adr/0001-old.md"),
        `Superseded by ADR-0093.\n\nPreset Source`,
      );
      assert.strictEqual(await checkLegacyArchitectureRemoval(root), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects retired runtime and test paths in a packed public artifact", () => {
    const findings = findLegacyArchitectureTarballFindings([
      "package/dist/cli.js",
      `package/node_modules/@ykdz/template-builtin-source/index.js`,
      "package/node_modules/@ykdz/template-builtin-presets/dist/src/example/behavior.test.js",
    ]);
    assert.ok(
      findings.some(
        (finding) =>
          Object.hasOwn(finding, "rule") && finding.rule === "packed-artifact",
      ),
    );
  });

  void it("audits package exports, dependencies, and built declaration or JavaScript leakage", async () => {
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
      const findings = await findLegacyArchitectureDistributionFindings(root);
      for (const rule of ["package-manifest-export", "built-artifact"]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") && finding.rule === rule,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not require unrelated distribution artifacts during a source-focused audit", async () => {
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

      assert.deepStrictEqual(
        await findLegacyArchitectureDistributionFindings(root),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("ignores local package-manager stores outside repository ownership", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, ".pnpm-store/v11/files"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, ".pnpm-store/v11/files/third-party-cache"),
        "Preset File build:run",
      );

      assert.deepStrictEqual(await findLegacyArchitectureFindings(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("ignores local fixture cache directories outside repository ownership", async () => {
    const root = await fixture();
    try {
      await Promise.all([
        mkdir(path.join(root, ".fixture-native-cache/pnpm/v11/files/00"), {
          recursive: true,
        }),
        mkdir(path.join(root, ".fixture-evidence/activity"), {
          recursive: true,
        }),
        mkdir(
          path.join(root, ".fixture-workspace/template-generated-check-x"),
          {
            recursive: true,
          },
        ),
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

      assert.deepStrictEqual(await findLegacyArchitectureFindings(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects retired task selection from source, generated manifests, documentation, and builds", async () => {
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
            `export type CheckPlan = readonly string[];`,
            `const deploymentOwner = "apps/web";`,
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
        writeFile(path.join(root, "docs/current.md"), `Fix Component`),
        writeFile(
          path.join(root, "docs/adr/0001-old-task-model.md"),
          `Check Plan`,
        ),
        writeFile(path.join(root, "packages/cli/package.json"), "{}"),
        writeFile(
          path.join(root, "packages/builtin-presets/package.json"),
          "{}",
        ),
        writeFile(path.join(root, "packages/core/package.json"), "{}"),
        writeFile(
          path.join(root, "packages/cli/dist/legacy.js"),
          `export const task = "deployment owner";`,
        ),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      for (const rule of [
        "retired-task-symbol",
        "deployment-owner-registration",
        "task-model-compatibility",
        "generated-task-filter",
        "retired-task-script",
        "retired-task-vocabulary",
        "historical-task-adr-status",
        "built-artifact-task-vocabulary",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") && finding.rule === rule,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects old plan fields, render-owner parameters, and composed Turbo filters", async () => {
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

      const findings = await findLegacyArchitectureFindings(root);
      for (const rule of [
        "retired-task-plan-field",
        "retired-task-render-parameter",
        "generated-task-filter",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") && finding.rule === rule,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects retired Development Container capability APIs and switches", async () => {
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
            `export type DevelopmentContainerRustLayer = { kind: "rust" };`,
            `export type DevelopmentContainerCapability = { kind: "docker-client" };`,
            `export type RustDevelopmentContainerOptions = { toolchain: string };`,
            `export function rustToolLayer() { return { kind: "rust" }; }`,
            `export function createRustDevelopmentContainerLayer() { return { kind: "rust" }; }`,
            `export function developmentContainerCapabilityCompatibility() {}`,
            `export function dockerfileFirstRustPnpmDevcontainer() {}`,
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
            `async function ensureHostFixtureDependencies() {`,
            `  await run("rustup", ["toolchain", "install", "stable"], { cwd: "." });`,
            `  await run("pnpm", ["exec", "playwright", "install", "--with-deps", "chromium"], { cwd: "." });`,
            `}`,
          ].join("\n"),
        ),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      for (const [rule, file] of [
        [
          "retired-development-container-path",
          "packages/core/src/devcontainer.ts",
        ],
        [
          "retired-development-container-symbol",
          "packages/core/src/devcontainer.ts",
        ],
        [
          "retired-development-container-switch",
          "packages/core/src/devcontainer.ts",
        ],
        [
          "retired-development-container-compatibility",
          "packages/core/src/devcontainer.ts",
        ],
        [
          "retired-development-container-path",
          "packages/builtin-presets/templates/foundation/rust",
        ],
        [
          "retired-development-container-path",
          "packages/builtin-presets/templates/rust-bin/devcontainer/devcontainer.json",
        ],
        [
          "retired-development-container-path",
          "packages/builtin-presets/templates/shared/devcontainer/shellcheck.Dockerfile",
        ],
        [
          "retired-development-container-path",
          "packages/builtin-presets/templates/shared/devcontainer/rust.Dockerfile",
        ],
        [
          "host-prepared-fixture-execution",
          "packages/checks/src/check-generated-registry.ts",
        ],
      ] as const) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === rule &&
              Object.hasOwn(finding, "file") &&
              finding.file === file,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects sibling Preset imports", async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, "packages/builtin-presets/src/vike-app"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "packages/builtin-presets/src/vike-app/definition.ts"),
        `import { vueAppDefinition } from "../vue-app/definition.ts"; void vueAppDefinition;`,
      );

      const findings = await findLegacyArchitectureFindings(root);
      assert.ok(
        findings.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "preset-sibling-import" &&
            Object.hasOwn(finding, "file") &&
            finding.file ===
              "packages/builtin-presets/src/vike-app/definition.ts",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("permits the package-local Turbo prepack build selector", async () => {
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
      assert.deepStrictEqual(
        findings.filter((finding) => finding.rule === "generated-task-filter"),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects the retired public CLI parser, manual prepack chain, and packed lifecycle bypass", async () => {
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
          path.join(root, "test/packed-publication.integration.test.ts"),
          'const packArgs = ["--config.ignore-scripts=true"];\n',
        ),
      ]);

      const findings = await findLegacyArchitectureFindings(root);
      for (const rule of [
        "hand-written-cli-parser",
        "manual-prepack-chain",
        "packed-lifecycle-bypass",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") && finding.rule === rule,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects directly executed TypeScript without native erasability enforcement", async () => {
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

      const findings = await findLegacyArchitectureFindings(root);
      for (const file of [
        "packages/missing/tsconfig.json",
        "packages/disabled/tsconfig.json",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === "non-erasable-typescript-config" &&
              Object.hasOwn(finding, "file") &&
              finding.file === file,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects non-erasable TypeScript syntax in repository-authored source", async () => {
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
      assert.strictEqual(
        findings.filter(({ rule }) => rule === "non-erasable-typescript-syntax")
          .length,
        3,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("does not scan non-erasable negative fixtures or generated output", async () => {
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

      assert.deepStrictEqual(await findLegacyArchitectureFindings(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects TypeScript runtime loaders and source runners", async () => {
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

      const findings = await findLegacyArchitectureFindings(root);
      for (const file of [
        "packages/cli/package.json",
        "packages/builtin-presets/src/definition.ts",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === "typescript-runtime-loader" &&
              Object.hasOwn(finding, "file") &&
              finding.file === file,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects TypeScript paths aliases and alias rewriting", async () => {
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

      await writeFile(
        path.join(root, "packages/builtin-presets/src/behavior.light.test.ts"),
        'import assert from "node:assert/strict";\nassert.ok(!Object.hasOwn({}, "tsc-alias"));\n',
      );

      const findings = await findLegacyArchitectureFindings(root);
      assert.deepStrictEqual(
        findings.filter((entry) =>
          entry.file.endsWith(
            "packages/builtin-presets/src/behavior.light.test.ts",
          ),
        ),
        [],
      );
      for (const file of [
        "packages/api/tsconfig.json",
        "packages/api/package.json",
        "packages/builtin-presets/src/definition.ts",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === "typescript-path-alias" &&
              Object.hasOwn(finding, "file") &&
              finding.file === file,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects Generated Repository Vitest resolver aliases structurally", async () => {
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

      const findings = await findLegacyArchitectureFindings(root);
      assert.strictEqual(findings.length, 1);
      assert.ok(
        Object.hasOwn(findings[0]!, "rule") &&
          findings[0]!.rule === "vitest-resolver-alias" &&
          Object.hasOwn(findings[0]!, "file") &&
          findings[0]!.file ===
            "packages/builtin-presets/templates/vue-app/vitest.config.ts",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects manual cross-package build chains outside Turbo topology", async () => {
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

      const findings = await findLegacyArchitectureFindings(root);
      for (const file of [
        "packages/web/package.json",
        "packages/builtin-presets/src/definition.ts",
      ]) {
        assert.ok(
          findings.some(
            (finding) =>
              Object.hasOwn(finding, "rule") &&
              finding.rule === "manual-dependency-build-chain" &&
              Object.hasOwn(finding, "file") &&
              finding.file === file,
          ),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects lifecycle bypasses in active generated-template checks", async () => {
    const root = await fixture();
    try {
      const checkRoot = path.join(root, "packages/builtin-presets/src");
      await mkdir(checkRoot, { recursive: true });
      await writeFile(
        path.join(checkRoot, "check-template-source.ts"),
        'const installArgs = ["install", "--ignore-scripts"];\n',
      );

      const findings = await findLegacyArchitectureFindings(root);
      assert.ok(
        findings.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "packed-lifecycle-bypass" &&
            Object.hasOwn(finding, "file") &&
            finding.file ===
              "packages/builtin-presets/src/check-template-source.ts",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("detects retired task words through Markdown and YAML punctuation, requiring explicit ADR-0094 supersession", async () => {
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
      await assert.rejects(
        checkLegacyArchitectureRemoval(root),
        (error: unknown) =>
          error instanceof Error &&
          /historical-task-adr-status/u.test(error.message),
      );
      await writeFile(
        path.join(root, "docs/adr/0001-old.md"),
        "Superseded by ADR-0094.\n\nOld `check:run` command.",
      );
      const findings = await findLegacyArchitectureFindings(root);
      assert.ok(
        findings.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "retired-task-vocabulary",
        ),
      );
      assert.deepStrictEqual(
        findings.filter((entry) => entry.file.endsWith("0001-old.md")),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("requires every bundled root and audits repository-owned packed source", async () => {
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
      assert.ok(
        findings.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "packed-artifact-task-vocabulary" &&
            Object.hasOwn(finding, "file") &&
            finding.file.includes("templates/web/Dockerfile"),
        ),
      );
      assert.ok(
        findings.some(
          (finding) =>
            Object.hasOwn(finding, "rule") &&
            finding.rule === "packed-bundled-root" &&
            Object.hasOwn(finding, "file") &&
            finding.file === "node_modules/@ykdz/template-core",
        ),
      );
      assert.strictEqual(
        findings.some(({ file }) => file.includes("node_modules/typescript")),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

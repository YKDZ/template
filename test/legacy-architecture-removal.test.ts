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

  it("audits every bundled package root and text template in a packed CLI", async () => {
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
      ]);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          bundleDependencies: [
            "@ykdz/template-builtin-presets",
            "@ykdz/template-core",
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
      ]);

      await expect(findPackedTaskVocabularyFindings(root)).resolves.toEqual(
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

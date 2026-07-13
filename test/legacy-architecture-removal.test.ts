import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkLegacyArchitectureRemoval,
  findLegacyArchitectureFindings,
  findLegacyArchitectureDistributionFindings,
  findLegacyArchitectureTarballFindings,
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
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { isTsCliPublicCandidateCreationInput } from "@ykdz/reference-ts-cli/creation-input";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent, templatePresets } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

function generator() {
  return createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  });
}

void describe("生成项目包清单策略", () => {
  void it("公开预设通过正式生成保留私有包隔离与发布候选事实", async () => {
    const nativeConfigurationManifest = JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve("@ykdz/reference-tooling-config/reference"),
        ),
        "utf8",
      ),
    ) as { readonly version: string };

    for (const preset of templatePresets) {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-public-manifest-policy-"),
      );
      const repositoryName = "manifest-policy";
      const targetRoot = path.join(workspace, repositoryName);

      try {
        const initialized = await generator().init({
          targetRoot,
          selection: { roots: [{ preset: preset.identity }] },
          strategyInput: {
            repositoryName,
            defaultPackageScope: "manifest-policy",
          },
        });
        assert.strictEqual(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );
        if (initialized.status !== "success") continue;

        const rootManifest = JSON.parse(
          await readFile(path.join(targetRoot, "package.json"), "utf8"),
        ) as {
          readonly name: string;
          readonly private: boolean;
          readonly version?: string;
          readonly scripts: Readonly<Record<string, string>>;
        };
        assert.strictEqual(rootManifest.name, repositoryName);
        assert.strictEqual(rootManifest.private, true);
        assert.strictEqual(
          rootManifest.scripts["lint:fix"],
          "oxlint --format=unix --no-error-on-unmatched-pattern *.config.ts .pnpmfile.mjs scripts test --fix",
        );

        const candidateRecords = initialized.generationRecord.packages.filter(
          (record) =>
            record.createdBy === "initialization" &&
            isTsCliPublicCandidateCreationInput(record.creationInput),
        );
        assert.strictEqual(
          candidateRecords.length,
          preset.identity.packageName === "@ykdz/preset-ts-cli" ? 1 : 0,
        );

        for (const definition of initialized.blueprint.packages) {
          const manifest = JSON.parse(
            await readFile(
              path.join(targetRoot, definition.path, "package.json"),
              "utf8",
            ),
          ) as {
            readonly name: string;
            readonly private?: boolean;
            readonly version?: string;
          };
          assert.strictEqual(manifest.name, definition.name);
          const record = initialized.generationRecord.packages.find(
            (item) =>
              item.packageDefinitionId === definition.packageDefinitionId,
          );
          assert.ok(record, `缺少生成记录：${definition.path}`);
          const isPublicCandidate = candidateRecords.some(
            (candidate) =>
              candidate.packageDefinitionId === definition.packageDefinitionId,
          );

          if (isPublicCandidate) {
            assert.strictEqual(manifest.private, true);
            assert.strictEqual(manifest.version, undefined);
          } else {
            assert.strictEqual(manifest.private, true);
            if (manifest.version !== undefined) {
              assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+].+)?$/u);
            }
          }
        }

        const configuration = initialized.blueprint.packages.find(
          (definition) =>
            definition.path === "packages/tooling-config" &&
            definition.role === "shared-library",
        );
        assert.ok(configuration, "生成项目必须复用原生 TypeScript 配置包");
        const configurationManifest = JSON.parse(
          await readFile(
            path.join(targetRoot, configuration.path, "package.json"),
            "utf8",
          ),
        ) as { readonly version: string };
        assert.strictEqual(
          configurationManifest.version,
          nativeConfigurationManifest.version,
        );

        const tsconfig = JSON.parse(
          await readFile(path.join(targetRoot, "tsconfig.json"), "utf8"),
        ) as { readonly include: readonly string[] };
        assert.ok(tsconfig.include.includes("scripts/**/*.ts"));
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });
});

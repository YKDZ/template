import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { defineReferencePackage } from "@ykdz/default-content-authoring/reference-package";
import { definePreset } from "@ykdz/template-core/preset-definition";

import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { validateGeneratedScenarioReceipt } from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

async function focusedProviderRuntime(withExports: boolean) {
  const sourcePreset = sourceGeneratedScenarioRuntime.content.find(
    (member) =>
      member.kind === "preset" &&
      member.identity.packageName === "@ykdz/preset-ts-lib",
  );
  const sourceReference = sourceGeneratedScenarioRuntime.content.find(
    (member) =>
      member.kind === "reference" &&
      member.identity.packageName === "@ykdz/reference-ts-lib",
  );
  assert.ok(sourcePreset?.kind === "preset");
  assert.ok(sourceReference?.kind === "reference");

  const providerReference = defineReferencePackage({
    manifest: {
      name: "@fixture/focused-provider-reference",
      version: "0.0.0",
      private: true,
      type: "module",
    },
    resourceRoot: new URL("./fixtures/focused-provider/", import.meta.url),
    alias: "library",
    instance: "independent",
    defaultLeafName: "library",
    role: "shared-library",
    resources: [{ path: "src/index.ts" }],
    transformManifest({ manifest }) {
      return withExports
        ? {
            ...manifest,
            exports: {
              ".": {
                source: "./src/index.ts",
                types: "./dist/index.d.ts",
                default: "./dist/index.js",
              },
            },
          }
        : manifest;
    },
  });
  const providerPreset = definePreset({
    metadata: {
      alias: "focused-provider",
      title: "Focused provider",
      description: "以公开清单变换提供 source 条件导出。",
    },
    owner: {
      packageName: "@fixture/focused-provider",
      exportPath: "./template",
    },
    operations: ["add"],
    nodes: { library: { reference: providerReference } },
  });
  const providerPresetMember = {
    identity: {
      namespace: "checks-fixture",
      packageName: "@fixture/focused-provider",
      exportPath: "./template",
    },
    kind: "preset" as const,
    alias: providerPreset.metadata.alias,
    definition: providerPreset,
    source: {
      specifier: import.meta.url,
      moduleURL: import.meta.url,
      manifestURL: import.meta.url,
    },
  };
  const providerReferenceMember = {
    identity: {
      namespace: "checks-fixture",
      packageName: "@fixture/focused-provider-reference",
      exportPath: "./template",
    },
    kind: "reference" as const,
    alias: providerReference.alias,
    definition: providerReference,
    source: {
      specifier: import.meta.url,
      moduleURL: new URL(
        "./fixtures/focused-provider/src/index.ts",
        import.meta.url,
      ).href,
      manifestURL: import.meta.url,
    },
  };
  const content = [
    ...sourceGeneratedScenarioRuntime.content.filter(
      (member) => member !== sourcePreset && member !== sourceReference,
    ),
    providerReferenceMember,
    providerPresetMember,
  ];
  return { ...sourceGeneratedScenarioRuntime, content };
}

void describe("唯一内容集合的真实生成检查场景", () => {
  void it("按声明操作派生初始化和完整实际 init/add 矩阵", async () => {
    const initializations = deriveInitializationScenarios(
      sourceGeneratedScenarioRuntime,
    );
    const scenarios = deriveFixtureMatrix(sourceGeneratedScenarioRuntime);
    const additions = scenarios.filter(
      (scenario) => scenario.addition !== undefined,
    );
    assert.strictEqual(initializations.length, 6);
    assert.strictEqual(additions.length, 24);

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generated-content-matrix-"),
    );
    try {
      for (const scenario of scenarios) {
        const receipt = await materializeGeneratedScenario({
          runtime: sourceGeneratedScenarioRuntime,
          scenario,
          workspace,
        });
        assert.notEqual(receipt.status, "not-applicable", scenario.id);
        if (receipt.status === "not-applicable") {
          throw new Error(
            `${scenario.id}: product matrix scenario was skipped`,
          );
        }
        assert.strictEqual(
          receipt.initialization.generationRecord.schemaVersion,
          6,
        );
        assert.strictEqual(receipt.result.generationRecord.schemaVersion, 6);
        assert.strictEqual(receipt.initialization.blueprint.schemaVersion, 4);
        assert.strictEqual(receipt.result.blueprint.schemaVersion, 4);
        assert.ok(receipt.initialization.projection.entries.length > 0);
        assert.ok(receipt.result.projection.entries.length > 0);
        await validateGeneratedScenarioReceipt({
          receipt,
          runtime: sourceGeneratedScenarioRuntime,
        });
        assert.equal((await stat(receipt.projectDir)).isDirectory(), true);
        const persistedRecord = JSON.parse(
          await readFile(
            path.join(receipt.projectDir, ".template/generation.json"),
            "utf8",
          ),
        ) as { readonly schemaVersion: number };
        assert.strictEqual(persistedRecord.schemaVersion, 6);
        if (scenario.addition !== undefined) {
          const addition = receipt.result.generationRecord.packages.find(
            (record) => record.createdBy === "addition",
          );
          assert.ok(addition);
          assert.ok(
            receipt.result.blueprint.packages.some(
              (definition) =>
                definition.packageDefinitionId === addition.packageDefinitionId,
            ),
          );
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("按公开清单求值结果判断 focused provider 能力", async () => {
    const runtime = await focusedProviderRuntime(true);
    const scenario = deriveFocusedProjectLinkScenarios(runtime).find(
      (candidate) =>
        candidate.base.identity.packageName === "@ykdz/preset-ts-cli" &&
        candidate.addition?.identity.packageName ===
          "@fixture/focused-provider",
    );
    assert.ok(scenario);

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-focused-package-link-"),
    );
    try {
      const receipt = await materializeGeneratedScenario({
        runtime,
        scenario,
        workspace,
      });
      assert.equal(receipt.status, "generated");
      if (receipt.status !== "generated") return;
      assert.deepEqual(receipt.linkFrom, ["packages/cli"]);
      const providerRecord = receipt.result.generationRecord.packages.find(
        (record) => record.createdBy === "addition",
      );
      assert.ok(providerRecord);
      const providerDefinition = receipt.result.blueprint.packages.find(
        (definition) =>
          definition.packageDefinitionId === providerRecord.packageDefinitionId,
      );
      const consumerDefinition = receipt.result.blueprint.packages.find(
        (definition) => definition.path === "packages/cli",
      );
      assert.ok(providerDefinition);
      assert.ok(consumerDefinition);
      assert.ok(
        receipt.result.blueprint.packageLinkIntents.some(
          (intent) =>
            intent.consumerId === consumerDefinition.packageDefinitionId &&
            intent.providerId === providerDefinition.packageDefinitionId,
        ),
      );
      const consumerManifest = JSON.parse(
        await readFile(
          path.join(
            receipt.projectDir,
            consumerDefinition.path,
            "package.json",
          ),
          "utf8",
        ),
      ) as { readonly dependencies?: Readonly<Record<string, string>> };
      assert.equal(
        consumerManifest.dependencies?.[providerDefinition.name],
        "workspace:*",
      );
      await validateGeneratedScenarioReceipt({ receipt, runtime });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    const unsupportedRuntime = await focusedProviderRuntime(false);
    const unsupportedScenario = deriveFocusedProjectLinkScenarios(
      unsupportedRuntime,
    ).find(
      (candidate) =>
        candidate.base.identity.packageName === "@ykdz/preset-ts-cli" &&
        candidate.addition?.identity.packageName ===
          "@fixture/focused-provider",
    );
    assert.ok(unsupportedScenario);
    const unsupportedWorkspace = await mkdtemp(
      path.join(tmpdir(), "template-focused-unsupported-provider-"),
    );
    try {
      const result = await materializeGeneratedScenario({
        runtime: unsupportedRuntime,
        scenario: unsupportedScenario,
        workspace: unsupportedWorkspace,
      });
      assert.deepEqual(result, { status: "not-applicable" });
      const persistedRecord = JSON.parse(
        await readFile(
          path.join(
            unsupportedWorkspace,
            unsupportedScenario.id,
            ".template/generation.json",
          ),
          "utf8",
        ),
      ) as {
        readonly packages: readonly { readonly createdBy: string }[];
      };
      assert.equal(
        persistedRecord.packages.some(
          (record) => record.createdBy === "addition",
        ),
        false,
      );
    } finally {
      await rm(unsupportedWorkspace, { recursive: true, force: true });
    }
  });
});

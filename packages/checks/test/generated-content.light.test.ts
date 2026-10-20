import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  TemplatePreset,
  TemplateReferencePackage,
} from "@ykdz/template-content";
import { createContentIndex } from "@ykdz/template-core/content-identity";
import { definePreset } from "@ykdz/template-core/preset-definition";

import {
  deriveFixtureMatrix,
  deriveFocusedProjectLinkScenarios,
  deriveInitializationScenarios,
  materializeGeneratedScenario,
  type ChecksPreset,
  type GeneratedScenarioRuntime,
} from "../src/generated-content.ts";
import { validateGeneratedScenarioReceipt } from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

void describe("唯一内容集合的真实生成检查场景", () => {
  void it("按声明操作派生六种 init 与完整 6×4 实际 init/add 矩阵", async () => {
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
        if (receipt.status === "not-applicable") continue;
        assert.strictEqual(
          receipt.initialization.generationRecord.schemaVersion,
          3,
        );
        assert.strictEqual(receipt.result.generationRecord.schemaVersion, 3);
        await validateGeneratedScenarioReceipt({
          receipt,
          runtime: sourceGeneratedScenarioRuntime,
        });
        assert.ok(receipt.initialization.projection !== null);
        assert.ok(receipt.result.projection !== null);
        assert.equal((await stat(receipt.projectDir)).isDirectory(), true);
        const persistedRecord = JSON.parse(
          await readFile(
            path.join(receipt.projectDir, ".template/generation.json"),
            "utf8",
          ),
        ) as { readonly schemaVersion: number };
        assert.strictEqual(persistedRecord.schemaVersion, 3);
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

  void it("从实际加包贡献判断 focused provider 能力", async () => {
    const libraryPreset = sourceGeneratedScenarioRuntime.content.find(
      (member): member is ChecksPreset =>
        "kind" in member &&
        member.kind === "preset" &&
        member.definition.metadata.alias === "ts-lib",
    );
    assert.ok(libraryPreset);
    const [libraryNode] = Object.values(libraryPreset.definition.nodes);
    assert.ok(libraryNode);
    const libraryReference = libraryNode.reference;
    const libraryReferenceMember = createContentIndex(
      sourceGeneratedScenarioRuntime.content,
    ).fromDefinition(libraryReference, "reference");
    const nativeManifest = Object.fromEntries(
      Object.entries(libraryReference.manifest).filter(
        ([key]) => key !== "exports",
      ),
    ) as typeof libraryReference.manifest;
    const providerReference = {
      ...libraryReference,
      manifest: nativeManifest,
    };
    const providerPreset = definePreset({
      metadata: {
        alias: "focused-provider-with-generated-exports",
        title: "测试提供包",
        description: "以实际贡献提供 Node package-name exports",
      },
      operations: ["add"],
      nodes: { provider: { reference: providerReference } },
    });
    const providerReferenceMember: TemplateReferencePackage = {
      ...libraryReferenceMember,
      identity: {
        namespace: "checks-fixture",
        packageName: "@fixture/focused-provider-reference",
        exportPath: "./template",
      },
      definition: providerReference,
      source: {
        specifier: "@fixture/focused-provider-reference/template",
        moduleURL:
          "file:///checks-fixture/focused-provider-reference/template.js",
        manifestURL:
          "file:///checks-fixture/focused-provider-reference/package.json",
      },
    };
    const providerPresetMember: ChecksPreset = {
      identity: {
        namespace: "checks-fixture",
        packageName: "@fixture/focused-provider",
        exportPath: "./template",
      },
      kind: "preset",
      alias: providerPreset.metadata.alias,
      definition: providerPreset as TemplatePreset["definition"],
      source: {
        specifier: "@fixture/focused-provider/template",
        moduleURL: "file:///checks-fixture/focused-provider/template.js",
        manifestURL: "file:///checks-fixture/focused-provider/package.json",
      },
    };
    const content = [
      ...sourceGeneratedScenarioRuntime.content.filter(
        (member) =>
          member !== libraryPreset && member !== libraryReferenceMember,
      ),
      providerReferenceMember,
      providerPresetMember,
    ];
    const runtime: GeneratedScenarioRuntime = {
      ...sourceGeneratedScenarioRuntime,
      content,
    };
    const scenario = deriveFocusedProjectLinkScenarios(runtime).find(
      (candidate) =>
        candidate.base.identity.packageName === "@ykdz/preset-ts-cli" &&
        candidate.addition?.identity.packageName ===
          "@fixture/focused-provider",
    );
    assert.ok(scenario);

    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-focused-provider-"),
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
      assert.ok(providerDefinition);
      const providerManifest = JSON.parse(
        await readFile(
          path.join(
            receipt.projectDir,
            providerDefinition.path,
            "package.json",
          ),
          "utf8",
        ),
      ) as {
        readonly exports?: Readonly<Record<string, unknown>>;
      };
      assert.deepEqual(providerManifest.exports?.["."], {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      assert.ok(
        receipt.result.blueprint.packageLinkIntents?.some(
          (intent) =>
            intent.consumerPackagePath === "packages/cli" &&
            intent.providerPackagePath === providerDefinition.path,
        ),
      );
      await validateGeneratedScenarioReceipt({ receipt, runtime });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    const unsupportedReference = {
      ...providerReference,
      contribute: (
        options: Parameters<typeof providerReference.contribute>[0],
      ) => {
        const contribution = providerReference.contribute(options);
        const manifest = Object.fromEntries(
          Object.entries(contribution.manifest).filter(
            ([key]) => key !== "exports",
          ),
        ) as typeof contribution.manifest;
        return { ...contribution, manifest };
      },
    };
    const unsupportedPreset = definePreset({
      metadata: {
        alias: "focused-provider-without-generated-exports",
        title: "未提供导出的测试包",
        description: "实际贡献不支持 source 条件导入",
      },
      operations: ["add"],
      nodes: { provider: { reference: unsupportedReference } },
    });
    const unsupportedReferenceMember: TemplateReferencePackage = {
      ...providerReferenceMember,
      definition: unsupportedReference,
    };
    const unsupportedPresetMember: ChecksPreset = {
      identity: {
        namespace: "checks-fixture",
        packageName: "@fixture/focused-provider-without-exports",
        exportPath: "./template",
      },
      kind: "preset",
      alias: unsupportedPreset.metadata.alias,
      definition: unsupportedPreset as TemplatePreset["definition"],
      source: {
        specifier: "@fixture/focused-provider-without-exports/template",
        moduleURL:
          "file:///checks-fixture/focused-provider-without-exports/template.js",
        manifestURL:
          "file:///checks-fixture/focused-provider-without-exports/package.json",
      },
    };
    const unsupportedContent = [
      ...sourceGeneratedScenarioRuntime.content.filter(
        (member) =>
          member !== libraryPreset && member !== libraryReferenceMember,
      ),
      unsupportedReferenceMember,
      unsupportedPresetMember,
    ];
    const unsupportedRuntime: GeneratedScenarioRuntime = {
      ...sourceGeneratedScenarioRuntime,
      content: unsupportedContent,
    };
    const unsupportedScenario = deriveFocusedProjectLinkScenarios(
      unsupportedRuntime,
    ).find(
      (candidate) =>
        candidate.base.identity.packageName === "@ykdz/preset-ts-cli" &&
        candidate.addition?.identity.packageName ===
          "@fixture/focused-provider-without-exports",
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

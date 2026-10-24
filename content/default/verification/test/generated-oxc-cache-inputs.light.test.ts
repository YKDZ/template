import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { templateContent } from "@ykdz/template-content";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

void it("把已选工具配置实例的路径加入 Turbo 全局输入", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "generated-oxc-cache-inputs-"),
  );
  try {
    const result = await createDefaultGenerator({
      content: templateContent,
    }).init({
      targetRoot: root,
      selection: {
        presets: [
          {
            contentIdentity: templateContent.find(
              (member) => member.kind === "preset" && member.alias === "ts-lib",
            )!.identity,
          },
        ],
      },
      conventions: {
        repositoryName: "oxc-cache-inputs",
        defaultPackageScope: "demo",
      },
    });
    assert.equal(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") throw new Error(JSON.stringify(result));

    const toolingConfiguration = result.ownerFacts.nativeDocuments.find(
      ({ identity, sourcePath }) =>
        identity.packageName === "@ykdz/reference-tooling-config" &&
        sourcePath === "package.json",
    );
    assert.ok(toolingConfiguration);
    const packageDefinition = result.blueprint.packages.find(
      ({ packageDefinitionId }) =>
        packageDefinitionId === toolingConfiguration.packageDefinitionId,
    );
    assert.ok(packageDefinition);
    const turbo = JSON.parse(
      await readFile(path.join(root, "turbo.json"), "utf8"),
    ) as {
      readonly globalDependencies: readonly string[];
    };
    assert.ok(
      turbo.globalDependencies.includes(
        `${packageDefinition.path}/oxfmt.config.ts`,
      ),
    );
    assert.ok(
      turbo.globalDependencies.includes(
        `${packageDefinition.path}/oxlint.config.ts`,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

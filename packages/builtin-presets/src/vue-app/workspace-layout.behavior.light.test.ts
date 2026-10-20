import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { referencePackage as vueApp } from "@ykdz/reference-vue-app/template";
import { referencePackage as vueShared } from "@ykdz/reference-vue-shared/template";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

import { loadTestReferences } from "../../test-support/content-member.ts";

const configuration = defineReferencePackage(configurationDefinition);

void it("Vue 应用连续加包沿参考布局写入 apps", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "template-generator-vue-layout-"),
  );
  const targetRoot = path.join(temporaryRoot, "demo");
  try {
    const generator = createGenerator({
      content: loadTestReferences([vueApp, vueShared, configuration]),
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "web", contentIdentity: "vue-app" }],
      },
      strategyInput: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    assert.match(
      await readFile(path.join(targetRoot, "pnpm-workspace.yaml"), "utf8"),
      /overrides:\n  pinia>typescript: "-"\n  vue>typescript: "-"/u,
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: "vue-app",
      creationInput: { leafName: "admin" },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") return;
    assert.ok(
      added.blueprint.packages.some(
        (definition) => definition.path === "apps/admin",
      ),
    );
    const manifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/admin/package.json"), "utf8"),
    ) as { name: string };
    assert.strictEqual(manifest.name, "@demo/admin");
    await assert.rejects(
      readFile(path.join(targetRoot, "packages/admin/package.json"), "utf8"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

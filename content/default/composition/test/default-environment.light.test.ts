import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadEditorCustomizationDeclarations,
  projectBuiltInEditorCustomization,
} from "@ykdz/template-workspace/default-environment";

void describe("默认编辑器设置组合", () => {
  void it("拒绝冲突资源中的设置并报告位置及双方来源", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "default-editor-conflict-"),
    );
    const resourcePath = path.join(directory, "capabilities.json");
    try {
      await writeFile(
        resourcePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            capabilityOrder: ["formatter-a", "formatter-b"],
            capabilities: {
              "formatter-a": {
                extensions: [],
                settings: { "editor.defaultFormatter": "tool-a" },
              },
              "formatter-b": {
                extensions: [],
                settings: { "editor.defaultFormatter": "tool-b" },
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const declarations = loadEditorCustomizationDeclarations(
        resourcePath,
        resourcePath,
      );

      assert.throws(
        () =>
          projectBuiltInEditorCustomization(
            ["formatter-a", "formatter-b"],
            declarations,
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("/settings/editor.defaultFormatter") &&
          error.message.includes(
            `${resourcePath}#/capabilities/formatter-a/settings`,
          ) &&
          error.message.includes(
            `${resourcePath}#/capabilities/formatter-b/settings`,
          ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

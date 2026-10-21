import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent, templatePresets } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

async function initialize(
  targetRoot: string,
  preset: (typeof templatePresets)[number],
): Promise<void> {
  const result = await createGenerator({
    content: templateContent,
    strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
  }).init({
    targetRoot,
    selection: { roots: [{ preset: preset.identity }] },
    strategyInput: {
      repositoryName: "generated-repository",
      defaultPackageScope: "generated",
    },
  });
  assert.strictEqual(result.status, "success", JSON.stringify(result));
}

void describe("生成任务公共入口", () => {
  void it("每个公开初始化预设都投影原生 Turbo 边界命令", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-gates-"));

    try {
      for (const preset of templatePresets) {
        const targetRoot = path.join(workspace, preset.identity.packageName);
        await initialize(targetRoot, preset);

        const rootManifest = JSON.parse(
          await readFile(path.join(targetRoot, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const turbo = JSON.parse(
          await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
        ) as {
          readonly tasks: Readonly<
            Record<string, { readonly tags?: readonly string[] }>
          >;
        };

        assert.deepStrictEqual(
          {
            check: rootManifest.scripts.check,
            "check:heavy": rootManifest.scripts["check:heavy"],
            "check:full": rootManifest.scripts["check:full"],
            fix: rootManifest.scripts.fix,
            boundaries: rootManifest.scripts.boundaries,
          },
          {
            check: "node --conditions=source scripts/task-gates.ts check",
            "check:heavy":
              "node --conditions=source scripts/task-gates.ts check:heavy",
            "check:full":
              "node --conditions=source scripts/task-gates.ts check:full",
            fix: "node --conditions=source scripts/task-gates.ts fix",
            boundaries: "turbo boundaries",
          },
        );

        for (const gate of ["check", "check:heavy", "check:full"]) {
          assert.deepStrictEqual(turbo.tasks[`//#${gate}`]?.tags, [
            "quality:entry",
          ]);
        }
        assert.deepStrictEqual(turbo.tasks["//#fix"]?.tags, ["work:repair"]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

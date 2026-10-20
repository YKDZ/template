import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { preset as rustBinPreset } from "@ykdz/preset-rust-bin/template";
import { preset as tsCliPreset } from "@ykdz/preset-ts-cli/template";
import { preset } from "@ykdz/preset-ts-lib/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { templateContent } from "@ykdz/template-content";
import { createGenerator } from "@ykdz/template-generator";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const temporaryDirectories: string[] = [];

async function createTargetRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "demo");
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

void describe("公开模板内容集合", () => {
  void it("只用集合成员完成库初始化及其公开共享依赖展开", async () => {
    const targetRoot = await createTargetRoot("template-content-ts-lib-");
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: { roots: [{ preset }] },
      strategyInput: { defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      ["packages/lib", "packages/typescript-config"].toSorted(),
    );
  });

  void it("从同一集合初始化 CLI 发布候选和 Rust 二进制程序", async () => {
    const generator = createGenerator({
      content: templateContent,
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });
    const cliRoot = await createTargetRoot("template-content-ts-cli-");
    const cliResult = await generator.init({
      targetRoot: cliRoot,
      selection: { roots: [{ preset: tsCliPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(cliResult.status, "success", JSON.stringify(cliResult));
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(cliRoot, "scripts/npm-publication/publication.config.json"),
          "utf8",
        ),
      ),
      { packagePath: "packages/cli" },
    );

    const rustRoot = await createTargetRoot("template-content-rust-bin-");
    const rustResult = await generator.init({
      targetRoot: rustRoot,
      selection: { roots: [{ preset: rustBinPreset }] },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      rustResult.status,
      "success",
      JSON.stringify(rustResult),
    );
    assert.match(
      await readFile(path.join(rustRoot, "packages/app/Cargo.toml"), "utf8"),
      /name = "app"/u,
    );
  });
});

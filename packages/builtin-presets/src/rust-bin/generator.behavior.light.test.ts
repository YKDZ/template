import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { referencePackage as rust } from "@ykdz/reference-rust-bin/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

import {
  loadTestReferences,
  testContentIdentity,
} from "../../test-support/content-member.ts";

const configuration = defineReferencePackage(configurationDefinition);

async function snapshotTree(root: string): Promise<string> {
  const entries: {
    readonly path: string;
    readonly mode: number;
    readonly text: string;
  }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath, file);
      } else {
        entries.push({
          path: file,
          mode: (await stat(filePath)).mode & 0o777,
          text: await readFile(filePath, "utf8"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify(entries);
}

void describe("显式生成器 Rust 行为", () => {
  void it("初始化 Rust 时从发布快照投影根声明与容器工具链", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-rust-init-")),
      "demo",
    );
    const generator = createGenerator({
      content: loadTestReferences([rust, configuration]),
      strategy: createDefaultWorkspaceStrategy(),
    });

    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "rust", contentIdentity: testContentIdentity(rust) },
        ],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { readonly scripts: Record<string, string> };
    assert.strictEqual(
      rootManifest.scripts["toolchain:prepare"],
      "cargo --version",
    );
    const turbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { readonly tasks: Record<string, unknown> };
    assert.deepStrictEqual(turbo.tasks["//#toolchain:prepare"], {
      cache: false,
      tags: ["work:preparation"],
    });
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      '[toolchain]\nchannel = "1.99.0"\ncomponents = ["rustfmt", "clippy"]\n',
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ).build.args.RUST_TOOLCHAIN,
      "1.99.0",
    );
    assert.strictEqual(
      (
        await readFile(path.join(targetRoot, "packages/app/Cargo.toml"), "utf8")
      ).includes('name = "app"'),
      true,
    );
  });

  void it("首次加 Rust 保留合法根声明，现有 Rust 根失效时加包零写入", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-rust-add-")),
      "demo",
    );
    const generator = createGenerator({
      content: loadTestReferences([library, rust, configuration]),
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "library",
            contentIdentity: testContentIdentity(library),
          },
        ],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const customRootDeclaration =
      '# local toolchain\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt"]\nprofile = "minimal"\n';
    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      customRootDeclaration,
    );
    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: testContentIdentity(rust),
      creationInput: { leafName: "native", packagePath: "packages/native" },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      customRootDeclaration,
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ).build.args.RUST_TOOLCHAIN,
      "nightly-2026-10-01",
    );

    const addedToRustWorkspace = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: testContentIdentity(rust),
      creationInput: {
        leafName: "second-native",
        packagePath: "packages/second-native",
      },
    });
    assert.strictEqual(
      addedToRustWorkspace.status,
      "success",
      JSON.stringify(addedToRustWorkspace),
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      customRootDeclaration,
    );

    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      "[toolchain]\nchannel = 7\n",
    );
    const beforeFailure = await snapshotTree(targetRoot);
    const rejected = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: testContentIdentity(rust),
      creationInput: {
        leafName: "third-native",
        packagePath: "packages/third-native",
      },
    });

    assert.strictEqual(rejected.status, "operation-failure");
    assert.strictEqual(
      rejected.status === "operation-failure" ? rejected.phase : undefined,
      "metadata",
    );
    assert.strictEqual(await snapshotTree(targetRoot), beforeFailure);
  });

  void it("首次加 Rust 缺少根声明时使用发布快照", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-rust-snapshot-")),
      "demo",
    );
    const generator = createGenerator({
      content: loadTestReferences([library, rust, configuration]),
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "library",
            contentIdentity: testContentIdentity(library),
          },
        ],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: testContentIdentity(rust),
      creationInput: { leafName: "native", packagePath: "packages/native" },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      (
        await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8")
      ).includes('channel = "1.99.0"'),
      true,
    );
  });
});

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  contentIdentityKey,
  createContentIndex,
} from "@ykdz/template-core/content-identity";
import { createGenerator } from "@ykdz/template-generator";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";
import { defineReferencePackage } from "@ykdz/template-workspace/reference-package";

const content = await loadContentSource({
  namespace: "ykdz",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@ykdz/reference-rust-bin/template",
    "@ykdz/reference-ts-lib/template",
    "@ykdz/reference-tooling-config/template",
    "@ykdz/preset-rust-bin/template",
  ],
  prepareReferenceDefinition(definition) {
    return defineReferencePackage(
      definition as Parameters<typeof defineReferencePackage>[0],
    );
  },
});
const contentIndex = createContentIndex(content);
const rust = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-rust-bin",
    exportPath: "./template",
  },
  "reference",
);
const library = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/reference-ts-lib",
    exportPath: "./template",
  },
  "reference",
);
const preset = contentIndex.resolve(
  {
    namespace: "ykdz",
    packageName: "@ykdz/preset-rust-bin",
    exportPath: "./template",
  },
  "preset",
);
const temporaryDirectories: string[] = [];

async function createTargetRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "demo");
}

async function snapshotTree(root: string): Promise<string> {
  const entries: {
    path: string;
    kind: "directory" | "file";
    mode: number;
    bytes: string;
  }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push({
          path: file,
          kind: "directory",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: "",
        });
        await visit(filePath, file);
      } else {
        entries.push({
          path: file,
          kind: "file",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: (await readFile(filePath)).toString("base64"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify({
    rootMode: (await stat(root)).mode & 0o777,
    entries,
  });
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
const strategyInput = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};

void describe("Rust 二进制公开组合预设", () => {
  void it("初始化并再次加包时保留原生构建与根工具链事实", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-preset-");
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput,
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const manifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      manifest.scripts["toolchain:prepare"],
      "cargo --version",
    );
    const turbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, unknown> };
    assert.deepStrictEqual(turbo.tasks["//#toolchain:prepare"], {
      cache: false,
      tags: ["work:preparation"],
    });
    assert.match(
      await readFile(path.join(targetRoot, "packages/app/Cargo.toml"), "utf8"),
      /name = "app"/u,
    );
    const appManifest = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/app/package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      appManifest.scripts.lint,
      "cargo clippy --workspace --all-targets -- -D warnings",
    );
    assert.strictEqual(appManifest.scripts.test, "cargo test --workspace");
    assert.strictEqual(appManifest.scripts.typecheck, undefined);
    assert.strictEqual(appManifest.scripts["lint:fix"], undefined);
    const appTurbo = JSON.parse(
      await readFile(path.join(targetRoot, "packages/app/turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn?: readonly string[] }> };
    assert.strictEqual(appTurbo.tasks.typecheck, undefined);
    assert.strictEqual(appTurbo.tasks["lint:fix"], undefined);
    assert.ok(!appTurbo.tasks["format:write"]?.dependsOn?.includes("lint:fix"));
    assert.match(
      await readFile(path.join(targetRoot, "packages/app/Cargo.lock"), "utf8"),
      /name = "anyhow"\nversion = "1\.0\.104"\nsource = "registry\+/u,
    );
    const initialToolchain = await readFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      "utf8",
    );
    assert.match(initialToolchain, /channel = "1\.99\.0"/u);

    const customToolchain =
      '# local toolchain\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt"]\nprofile = "minimal"\n';
    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      customToolchain,
    );
    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: {
        leafName: "second-native",
        packagePath: "packages/second-native",
      },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.match(
      await readFile(
        path.join(targetRoot, "packages/second-native/Cargo.toml"),
        "utf8",
      ),
      /name = "second-native"/u,
    );
    assert.match(
      await readFile(
        path.join(targetRoot, "packages/second-native/Cargo.lock"),
        "utf8",
      ),
      /name = "second-native"/u,
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      customToolchain,
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
    const records = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: typeof rust.identity;
        createdBy: string;
      }[];
    };
    assert.deepStrictEqual(
      records.packages
        .filter(
          (record) =>
            contentIdentityKey(record.contentIdentity) ===
            contentIdentityKey(rust.identity),
        )
        .map((record) => record.createdBy),
      ["initialization", "addition"],
    );
  });

  void it("首次向 Node 工作区加 Rust 后按现行根事实投影并保留自定义项", async () => {
    const targetRoot = await createTargetRoot(
      "template-rust-bin-node-workspace-",
    );
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: library.identity }],
      },
      strategyInput,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const localRootDeclaration =
      '# checked in by this repository\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt"]\nprofile = "minimal"\n';
    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      localRootDeclaration,
    );

    const firstRust = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: {
        leafName: "native",
        packagePath: "packages/native",
      },
    });
    assert.strictEqual(firstRust.status, "success", JSON.stringify(firstRust));
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      localRootDeclaration,
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
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/native/package.json"),
          "utf8",
        ),
      ).devDependencies["@demo/tooling-config"],
      "workspace:*",
    );
    assert.strictEqual(
      await stat(
        path.join(targetRoot, "packages/tooling-config/tsconfig.json"),
      ).then((file) => file.isFile()),
      true,
    );

    const secondRust = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: rust.identity,
      creationInput: {
        leafName: "another-native",
        packagePath: "packages/another-native",
      },
    });
    assert.strictEqual(
      secondRust.status,
      "success",
      JSON.stringify(secondRust),
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      localRootDeclaration,
    );
    assert.match(
      await readFile(
        path.join(targetRoot, "packages/another-native/Cargo.toml"),
        "utf8",
      ),
      /name = "another-native"/u,
    );
  });

  void it("缺少原生共享依赖时不写入目标", async () => {
    const targetRoot = await createTargetRoot(
      "template-rust-bin-missing-dependency-",
    );
    await mkdir(targetRoot, { recursive: true });
    const missingConfiguration = createGenerator({
      content: [rust, preset],
      strategy: createDefaultWorkspaceStrategy(),
    });
    const result = await missingConfiguration.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput,
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.deepStrictEqual(await readdir(targetRoot), []);
  });

  void it("真实文件冲突拒绝 Rust 加包且不改变原目录", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-conflict-");
    const generator = createGenerator({
      content,
      strategy: createDefaultWorkspaceStrategy(),
    });
    const initialized = await generator.init({
      targetRoot,
      selection: { roots: [{ preset: preset.identity }] },
      strategyInput,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const conflictDirectory = path.join(targetRoot, "packages/conflict");
    await mkdir(conflictDirectory, { recursive: true });
    await writeFile(
      path.join(conflictDirectory, "Cargo.toml"),
      "local bytes\n",
    );
    const before = await snapshotTree(targetRoot);

    const rejected = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "conflict", packagePath: "packages/conflict" },
    });
    assert.strictEqual(rejected.status, "conflict", JSON.stringify(rejected));
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });
});

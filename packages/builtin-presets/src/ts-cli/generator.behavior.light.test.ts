import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { referencePackage as rust } from "@ykdz/reference-rust-bin/template";
import {
  referencePackage as cli,
  tsCliPublicCandidateCreationInput,
} from "@ykdz/reference-ts-cli/template";
import type { TsCliCreationInput } from "@ykdz/reference-ts-cli/template";
import { referencePackage as library } from "@ykdz/reference-ts-lib/template";
import { referenceDefinition as configurationDefinition } from "@ykdz/reference-typescript-config/template";
import { resolveTemplateSource } from "@ykdz/template-core/renderer";
import { createGenerator } from "@ykdz/template-generator";
import { defineReferencePackage } from "@ykdz/template-workspace-authoring/reference-package";
import { createDefaultWorkspaceStrategy } from "@ykdz/template-workspace/default-workspace-strategy";

const configuration = defineReferencePackage(configurationDefinition);

async function snapshotTree(root: string): Promise<string> {
  const entries: {
    readonly path: string;
    readonly mode: number;
    readonly bytes: string;
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
          bytes: (await readFile(filePath)).toString("base64"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify(entries);
}

void describe("显式生成器 TypeScript CLI 行为", () => {
  void it("只把显式初始化候选发布，并在真实加包回放后保留候选身份", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-ts-cli-")),
      "demo",
    );
    const generator = createGenerator({
      content: [cli, configuration],
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "cli",
            contentIdentity: cli.identity,
            creationInput: tsCliPublicCandidateCreationInput,
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
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(
            targetRoot,
            "scripts/npm-publication/publication.config.json",
          ),
          "utf8",
        ),
      ),
      { packagePath: "packages/cli" },
    );
    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as {
      readonly imports: Record<string, string>;
      readonly scripts: Record<string, string>;
      readonly devDependencies: Record<string, string>;
    };
    assert.strictEqual(
      rootManifest.imports["#npm-publication/*"],
      "./scripts/npm-publication/*.ts",
    );
    assert.strictEqual(
      rootManifest.scripts["publication:readiness"],
      "node --conditions=source scripts/npm-publication/check-readiness.ts",
    );
    assert.strictEqual(rootManifest.devDependencies.npm, "catalog:");
    const rootTsconfig = JSON.parse(
      await readFile(path.join(targetRoot, "tsconfig.json"), "utf8"),
    ) as {
      readonly compilerOptions: {
        readonly allowJs: boolean;
        readonly checkJs: boolean;
      };
      readonly include: readonly string[];
    };
    assert.strictEqual(rootTsconfig.compilerOptions.allowJs, true);
    assert.strictEqual(rootTsconfig.compilerOptions.checkJs, true);
    assert.ok(rootTsconfig.include.includes(".pnpmfile.mjs"));
    assert.ok(await readFile(path.join(targetRoot, ".pnpmfile.mjs"), "utf8"));
    assert.ok(cli.publicationIdentitySource);
    assert.strictEqual(
      await readFile(
        path.join(
          targetRoot,
          "scripts/npm-publication/cli-command-identity.ts",
        ),
        "utf8",
      ),
      await readFile(
        resolveTemplateSource(cli.publicationIdentitySource, "."),
        "utf8",
      ),
    );
    assert.ok(
      await readFile(
        path.join(targetRoot, ".github/workflows/release.yml"),
        "utf8",
      ),
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/cli/package.json"),
          "utf8",
        ),
      ).engines.node,
      "^24.21.0",
    );
    assert.strictEqual(
      (
        await stat(
          path.join(targetRoot, "scripts/npm-publication-setup/setup.sh"),
        )
      ).mode & 0o111,
      0o111,
    );

    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        leafName: "private-cli",
        packagePath: "packages/private-cli",
      },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/private-cli/package.json"),
          "utf8",
        ),
      ).engines.node,
      ">=24",
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/cli/package.json"),
          "utf8",
        ),
      ).devDependencies["@demo/typescript-config"],
      "link:../typescript-config",
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/private-cli/package.json"),
          "utf8",
        ),
      ).devDependencies["@demo/typescript-config"],
      "workspace:*",
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(
            targetRoot,
            "scripts/npm-publication/publication.config.json",
          ),
          "utf8",
        ),
      ).packagePath,
      "packages/cli",
    );
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".template/generation.json"),
          "utf8",
        ),
      ).packages.map(
        (record: { createdBy: string; creationInput?: unknown }) => ({
          createdBy: record.createdBy,
          creationInput: record.creationInput,
        }),
      ),
      [
        {
          createdBy: "initialization",
          creationInput: { variant: "public-candidate" },
        },
        { createdBy: "shared-dependency", creationInput: undefined },
        {
          createdBy: "addition",
          creationInput: {
            leafName: "private-cli",
            packagePath: "packages/private-cli",
          },
        },
      ],
    );
  });

  void it("直接初始化原生 CLI 参考包时默认保持私有", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-private-cli-")),
      "demo",
    );
    const generator = createGenerator({
      content: [cli, configuration],
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "cli", contentIdentity: cli.identity }],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/cli/package.json"),
          "utf8",
        ),
      ).engines.node,
      ">=24",
    );
    await assert.rejects(
      stat(
        path.join(
          targetRoot,
          "scripts/npm-publication/publication.config.json",
        ),
      ),
      { code: "ENOENT" },
    );
  });

  void it("显式连接库包时保留 source 与 default exports 供 Node 解析", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-cli-link-")),
      "demo",
    );
    const generator = createGenerator({
      content: [cli, library, configuration],
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: library.identity }],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        variant: "private",
        linkToNodeIdentity: "library",
      },
    });

    assert.strictEqual(result.status, "success", JSON.stringify(result));
    if (result.status !== "success") return;
    assert.deepStrictEqual(result.blueprint.packageLinkIntents, [
      {
        consumerPackagePath: "packages/cli",
        providerPackagePath: "packages/lib",
      },
    ]);
    const cliManifest = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/cli/package.json"),
        "utf8",
      ),
    ) as {
      readonly dependencies: Record<string, string>;
      readonly dependenciesMeta?: Record<string, unknown>;
    };
    assert.strictEqual(cliManifest.dependencies["@demo/lib"], "workspace:*");
    assert.strictEqual(cliManifest.dependenciesMeta?.["@demo/lib"], undefined);
    assert.deepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ).exports["."],
      {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    );
  });

  void it("普通加包沿用已连接 provider 的当前 exports 并在失效时零写入", async () => {
    const targetRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "template-generator-cli-link-truth-")),
      "demo",
    );
    const generator = createGenerator({
      content: [cli, library, configuration],
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "library", contentIdentity: library.identity }],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const linked = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        variant: "private",
        linkToNodeIdentity: "library",
      },
    });
    assert.strictEqual(linked.status, "success", JSON.stringify(linked));

    const validAdd = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "next", packagePath: "packages/next" },
    });
    assert.strictEqual(validAdd.status, "success", JSON.stringify(validAdd));

    const providerManifestPath = path.join(
      targetRoot,
      "packages/lib/package.json",
    );
    const providerManifest = JSON.parse(
      await readFile(providerManifestPath, "utf8"),
    ) as {
      exports: Record<string, unknown>;
    };
    const rootExport = providerManifest.exports["."] as Record<string, unknown>;
    delete rootExport.default;
    await writeFile(
      providerManifestPath,
      JSON.stringify(providerManifest, null, 2) + "\n",
    );

    const beforeFailure = await snapshotTree(targetRoot);
    const rejected = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: {
        leafName: "after-broken-link",
        packagePath: "packages/after-broken-link",
      },
    });
    assert.strictEqual(rejected.status, "operation-failure");
    assert.match(
      rejected.status === "operation-failure" ? rejected.error.message : "",
      /Package Link provider packages\/lib does not expose an importable package root/u,
    );
    assert.strictEqual(await snapshotTree(targetRoot), beforeFailure);
  });

  void it("拒绝连接不支持的 Rust 包且初始化目标保持空白", async () => {
    const targetRoot = path.join(
      await mkdtemp(
        path.join(tmpdir(), "template-generator-cli-link-invalid-"),
      ),
      "demo",
    );
    await mkdir(targetRoot, { recursive: true });
    const generator = createGenerator({
      content: [cli, configuration, rust],
      strategy: createDefaultWorkspaceStrategy<TsCliCreationInput>(),
    });

    const result = await generator.init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "cli",
            contentIdentity: cli.identity,
            creationInput: {
              variant: "private",
              linkToNodeIdentity: "rust",
            },
          },
          { nodeIdentity: "rust", contentIdentity: rust.identity },
        ],
      },
      strategyInput: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.deepStrictEqual(await readdir(targetRoot), []);
  });
});

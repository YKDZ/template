import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { execa } from "execa";

import {
  checkRepositoryConfiguration,
  syncRepositoryConfiguration,
} from "../scripts/sync-repository-config.ts";

const requireFromTest = createRequire(import.meta.url);

async function installOwnerFixture(
  root: string,
  packageName: string,
  packagePath: string,
  manifest: string,
): Promise<void> {
  const ownerDirectory = path.join(root, packagePath);
  await mkdir(path.join(ownerDirectory, "scripts"), { recursive: true });
  await copyFile(
    requireFromTest.resolve(`${packageName}/repository-configuration`),
    path.join(ownerDirectory, "scripts/repository-configuration.ts"),
  );
  await writeFile(path.join(ownerDirectory, "package.json"), manifest);

  const packageLink = path.join(
    root,
    "node_modules",
    ...packageName.split("/"),
  );
  await mkdir(path.dirname(packageLink), { recursive: true });
  await symlink(
    path.relative(path.dirname(packageLink), ownerDirectory),
    packageLink,
    "dir",
  );
}

function ownerManifest(
  packageName: string,
  fields: Readonly<Record<string, unknown>> = {},
): string {
  return `${JSON.stringify(
    {
      name: packageName,
      type: "module",
      exports: {
        "./repository-configuration": {
          source: "./scripts/repository-configuration.ts",
        },
      },
      ...fields,
    },
    null,
    2,
  )}\n`;
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repository-config-"));
  await mkdir(path.join(root, ".devcontainer"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      engines: { node: "26.1.2" },
      packageManager: "pnpm@13.2.1",
      devDependencies: {
        "@ykdz/template": "workspace:*",
        "@ykdz/reference-ts-cli": "workspace:*",
        "@ykdz/reference-rust-bin": "workspace:*",
        "@ykdz/template-core": "workspace:*",
      },
    })}\n`,
  );
  await writeFile(
    path.join(root, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.100.2"\n',
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    'catalog:\n  "@playwright/test": 1.64.0\n',
  );
  await installOwnerFixture(
    root,
    "@ykdz/template",
    "apps/cli",
    ownerManifest("@ykdz/template", {
      engines: { node: "^24.0.0" },
      custom: true,
    }),
  );
  await installOwnerFixture(
    root,
    "@ykdz/reference-ts-cli",
    "content/default/references/ts-cli",
    ownerManifest("@ykdz/reference-ts-cli", {
      engines: { node: "^24.0.0" },
      custom: "参考 CLI 局部配置",
    }),
  );
  await installOwnerFixture(
    root,
    "@ykdz/reference-rust-bin",
    "content/default/references/rust-bin",
    ownerManifest("@ykdz/reference-rust-bin"),
  );
  const corePackage = path.dirname(
    requireFromTest.resolve("@ykdz/template-core/reference"),
  );
  const coreLink = path.join(root, "node_modules/@ykdz/template-core");
  await mkdir(path.dirname(coreLink), { recursive: true });
  await symlink(
    path.relative(path.dirname(coreLink), corePackage),
    coreLink,
    "dir",
  );
  await writeFile(
    path.join(root, ".devcontainer/Dockerfile"),
    "FROM node:24.0.0-bookworm\n",
  );
  await writeFile(
    path.join(
      root,
      "content/default/references/rust-bin/template/rust-toolchain.toml",
    ),
    '[toolchain]\nchannel = "1.99.0" # 保留模板注释\ncomponents = ["rustfmt", "clippy"]\n',
  );
  return root;
}

void it("统一同步重建自用配置，并从根版本声明投影工具链和编辑器能力", async () => {
  const root = await repositoryFixture();
  try {
    await syncRepositoryConfiguration(root);
    const container = JSON.parse(
      await readFile(
        path.join(root, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    );
    assert.strictEqual(container.build.args.NODE_VERSION, "26.1.2");
    assert.strictEqual(container.build.args.RUST_TOOLCHAIN, "1.100.2");
    assert.strictEqual(
      container.build.args.PLAYWRIGHT_CLI_PACKAGE,
      "@playwright/test@1.64.0",
    );
    const settings = JSON.parse(
      await readFile(path.join(root, ".vscode/settings.json"), "utf8"),
    );
    assert.strictEqual(settings["rust-analyzer.check.command"], "clippy");
    assert.deepStrictEqual(container.customizations.vscode.settings, settings);
    assert.strictEqual(
      await readFile(path.join(root, "apps/cli/package.json"), "utf8"),
      ownerManifest("@ykdz/template", {
        engines: { node: "^26.1.2" },
        custom: true,
      }),
    );
    assert.strictEqual(
      await readFile(
        path.join(root, "content/default/references/ts-cli/package.json"),
        "utf8",
      ),
      '{"engines":{"node":"^26.1.2"},"custom":"参考 CLI 局部配置"}\n',
    );
    assert.deepStrictEqual(await syncRepositoryConfiguration(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("只读检查发现所有受管输出的漂移，同步恢复后再次检查通过", async () => {
  const root = await repositoryFixture();
  try {
    await syncRepositoryConfiguration(root);
    assert.deepStrictEqual(await checkRepositoryConfiguration(root), []);
    const managedFiles = [
      ".devcontainer/Dockerfile",
      ".devcontainer/devcontainer.json",
      ".vscode/settings.json",
      ".vscode/extensions.json",
    ];
    const cliFile = "apps/cli/package.json";
    const referenceCliFile = "content/default/references/ts-cli/package.json";
    const rustFile =
      "content/default/references/rust-bin/template/rust-toolchain.toml";
    const labels = [
      ...managedFiles,
      "应用 CLI 包清单",
      "参考 CLI 包清单",
      "Rust 工具链模板",
    ];
    const files = [...managedFiles, cliFile, referenceCliFile, rustFile];
    const readOutputs = () =>
      Promise.all(
        files.map((file) =>
          readFile(path.join(root, file), "utf8").catch((error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return undefined;
            throw error;
          }),
        ),
      );
    await rm(path.join(root, managedFiles[0]!));
    for (const file of managedFiles.slice(1))
      await writeFile(path.join(root, file), '{"custom":"直接修改输出"}\n');
    await writeFile(
      path.join(root, cliFile),
      ownerManifest("@ykdz/template", {
        engines: { node: "^24.0.0", npm: ">=10" },
        custom: "保留包配置",
      }),
    );
    await writeFile(
      path.join(root, referenceCliFile),
      ownerManifest("@ykdz/reference-ts-cli", {
        engines: { node: "^24.0.0" },
      }),
    );
    await writeFile(
      path.join(root, rustFile),
      '[toolchain]\nchannel = "1.99.0" # 保留模板注释\ncomponents = ["rustfmt", "clippy"]\n',
    );
    const beforeCheck = await readOutputs();
    const diagnostics = await checkRepositoryConfiguration(root);
    assert.strictEqual(diagnostics.length, 7);
    for (const file of labels)
      assert.ok(
        diagnostics.some(
          (message) =>
            message.includes(file) && message.includes("pnpm run sync"),
        ),
      );
    assert.deepStrictEqual(await readOutputs(), beforeCheck);
    assert.deepStrictEqual(
      (await syncRepositoryConfiguration(root)).sort(),
      labels.sort(),
    );
    assert.deepStrictEqual(await checkRepositoryConfiguration(root), []);
    const settings = JSON.parse(
      await readFile(path.join(root, ".vscode/settings.json"), "utf8"),
    );
    assert.strictEqual(settings.custom, undefined);
    assert.strictEqual(
      await readFile(path.join(root, cliFile), "utf8"),
      ownerManifest("@ykdz/template", {
        engines: { node: "^26.1.2", npm: ">=10" },
        custom: "保留包配置",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("写入失败报告已更新文件，直接 Node 入口可离线补齐且保留局部目标的无关内容", async () => {
  const root = await repositoryFixture();
  try {
    await assert.rejects(
      syncRepositoryConfiguration(root, async (label, write) => {
        if (label === "Rust 工具链模板") throw new Error("磁盘故障");
        await write();
      }),
      /已更新文件：应用 CLI 包清单、参考 CLI 包清单；/u,
    );
    const result = await execa(
      process.execPath,
      [
        "--conditions=source",
        path.resolve(
          import.meta.dirname,
          "../scripts/sync-repository-config.ts",
        ),
        "--repository-root",
        root,
      ],
      { env: { PATH: "", RUSTUP_TOOLCHAIN: "uninstalled" }, reject: false },
    );
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(await checkRepositoryConfiguration(root), []);
    assert.strictEqual(
      await readFile(path.join(root, "apps/cli/package.json"), "utf8"),
      ownerManifest("@ykdz/template", {
        engines: { node: "^26.1.2" },
        custom: true,
      }),
    );
    assert.strictEqual(
      await readFile(
        path.join(
          root,
          "content/default/references/rust-bin/template/rust-toolchain.toml",
        ),
        "utf8",
      ),
      '[toolchain]\nchannel = "1.100.2" # 保留模板注释\ncomponents = ["rustfmt", "clippy"]\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["node", "pnpm", "rust", "invalid-toml"]) {
  void it(`预检失败 ${failure} 时已经需要更新的其他目标也零写入`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync-preflight-"));
    try {
      await mkdir(path.join(root, "packages/cli"), { recursive: true });
      await mkdir(path.join(root, ".devcontainer"), { recursive: true });
      await mkdir(path.join(root, "content/default/references/ts-cli"), {
        recursive: true,
      });
      await mkdir(
        path.join(root, "content/default/references/rust-bin/template"),
        {
          recursive: true,
        },
      );
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          engines: { node: failure === "node" ? ">=26" : "26.1.2" },
          packageManager: failure === "pnpm" ? "pnpm@^13" : "pnpm@13.2.1",
        }),
      );
      await writeFile(
        path.join(root, "rust-toolchain.toml"),
        failure === "rust"
          ? '[toolchain]\nchannel = "stable"\n'
          : failure === "invalid-toml"
            ? '[toolchain]\nchannel = "1.100.2"\nchannel = "stable"\n'
            : '[toolchain]\nchannel = "1.100.2"\n',
      );
      const cli = '{"engines":{"node":"^24.0.0"},"custom":true}\n';
      const docker = "FROM node:24.0.0-bookworm\nENV CUSTOM=yes\n";
      await writeFile(path.join(root, "packages/cli/package.json"), cli);
      await writeFile(
        path.join(root, "content/default/references/ts-cli/package.json"),
        cli,
      );
      await writeFile(
        path.join(
          root,
          "content/default/references/rust-bin/template/rust-toolchain.toml",
        ),
        '[toolchain]\nchannel = "1.99.0"\n',
      );
      await writeFile(path.join(root, ".devcontainer/Dockerfile"), docker);
      const result = await execa(
        process.execPath,
        [
          "--conditions=source",
          path.resolve(
            import.meta.dirname,
            "../scripts/sync-repository-config.ts",
          ),
          "--repository-root",
          root,
        ],
        { reject: false },
      );
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(
        await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
        cli,
      );
      assert.strictEqual(
        await readFile(path.join(root, ".devcontainer/Dockerfile"), "utf8"),
        docker,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

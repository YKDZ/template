import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { execa } from "execa";

import { syncTemplateToolchain } from "../scripts/sync-template-toolchain.ts";

void it("直接 Node 入口离线同步三个目标并保留无关内容，重复执行不再修改", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-toolchain-"));
  try {
    await mkdir(path.join(root, "packages/cli"), { recursive: true });
    await mkdir(path.join(root, "packages/core/src"), { recursive: true });
    await mkdir(path.join(root, ".devcontainer"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      '{"engines":{"node":"26.1.2"},"packageManager":"pnpm@13.2.1"}\n',
    );
    await writeFile(
      path.join(root, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "1.100.2"\n',
    );
    await writeFile(
      path.join(root, "packages/cli/package.json"),
      '{"engines":{"node":"^24.0.0"},"custom":true}\n',
    );
    await writeFile(
      path.join(root, ".devcontainer/Dockerfile"),
      "FROM node:24.0.0-bookworm\nENV CUSTOM=yes\n",
    );
    await writeFile(
      path.join(root, "packages/core/src/release-toolchain-snapshot.ts"),
      'export const releaseToolchainSnapshot = Object.freeze({\n nodeVersion: "24.0.0",\n packageManagerPin: "pnpm@12.0.0",\n rustVersion: "1.99.0",\n} as const);\n// keep\n',
    );
    const run = () =>
      execa(
        process.execPath,
        [
          path.resolve(
            import.meta.dirname,
            "../scripts/sync-template-toolchain.ts",
          ),
          "--repository-root",
          root,
        ],
        { env: { PATH: "", RUSTUP_TOOLCHAIN: "uninstalled" }, reject: false },
      );
    await assert.rejects(
      syncTemplateToolchain(root, async (file, contents) => {
        if (file.endsWith("Dockerfile")) throw new Error("磁盘故障");
        await writeFile(file, contents);
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes("已更新文件：packages/cli/package.json"),
    );
    assert.strictEqual(
      await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
      '{"engines":{"node":"^26.1.2"},"custom":true}\n',
    );
    assert.strictEqual(
      await readFile(path.join(root, ".devcontainer/Dockerfile"), "utf8"),
      "FROM node:24.0.0-bookworm\nENV CUSTOM=yes\n",
    );
    const result = await run();
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(
      await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
      '{"engines":{"node":"^26.1.2"},"custom":true}\n',
    );
    assert.strictEqual(
      await readFile(path.join(root, ".devcontainer/Dockerfile"), "utf8"),
      "FROM node:26.1.2-bookworm\nENV CUSTOM=yes\n",
    );
    assert.ok(
      (
        await readFile(
          path.join(root, "packages/core/src/release-toolchain-snapshot.ts"),
          "utf8",
        )
      ).includes(
        'nodeVersion: "26.1.2",\n packageManagerPin: "pnpm@13.2.1",\n rustVersion: "1.100.2",\n} as const);\n// keep',
      ),
    );
    assert.ok((await run()).stdout.includes("无需修改"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of [
  "node",
  "pnpm",
  "rust",
  "invalid-toml",
  "missing",
  "shape",
  "syntax",
]) {
  void it(`预检失败 ${failure} 时已经需要更新的其他目标也零写入`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync-preflight-"));
    try {
      await mkdir(path.join(root, "packages/cli"), { recursive: true });
      await mkdir(path.join(root, "packages/core/src"), { recursive: true });
      await mkdir(path.join(root, ".devcontainer"), { recursive: true });
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
      await writeFile(path.join(root, ".devcontainer/Dockerfile"), docker);
      if (failure !== "missing")
        await writeFile(
          path.join(root, "packages/core/src/release-toolchain-snapshot.ts"),
          failure === "shape"
            ? "export const releaseToolchainSnapshot = compute();\n"
            : `export const releaseToolchainSnapshot = Object.freeze({nodeVersion:"24.0.0",packageManagerPin:"pnpm@12.0.0",rustVersion:"1.99.0"} as const${failure === "syntax" ? "" : ")"};\n`,
        );
      const result = await execa(
        process.execPath,
        [
          path.resolve(
            import.meta.dirname,
            "../scripts/sync-template-toolchain.ts",
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

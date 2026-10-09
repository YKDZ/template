import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { expect, it } from "vitest";

import { syncTemplateToolchain } from "../scripts/sync-template-toolchain.ts";

it("直接 Node 入口离线同步三个目标并保留无关内容，重复执行不再修改", async () => {
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
    await expect(
      syncTemplateToolchain(root, async (file, contents) => {
        if (file.endsWith("Dockerfile")) throw new Error("磁盘故障");
        await writeFile(file, contents);
      }),
    ).rejects.toThrow("已更新文件：packages/cli/package.json");
    expect(
      await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
    ).toBe('{"engines":{"node":"^26.1.2"},"custom":true}\n');
    expect(
      await readFile(path.join(root, ".devcontainer/Dockerfile"), "utf8"),
    ).toBe("FROM node:24.0.0-bookworm\nENV CUSTOM=yes\n");
    const result = await run();
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(
      await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
    ).toBe('{"engines":{"node":"^26.1.2"},"custom":true}\n');
    expect(
      await readFile(path.join(root, ".devcontainer/Dockerfile"), "utf8"),
    ).toBe("FROM node:26.1.2-bookworm\nENV CUSTOM=yes\n");
    expect(
      await readFile(
        path.join(root, "packages/core/src/release-toolchain-snapshot.ts"),
        "utf8",
      ),
    ).toContain(
      'nodeVersion: "26.1.2",\n packageManagerPin: "pnpm@13.2.1",\n rustVersion: "1.100.2",\n} as const);\n// keep',
    );
    expect((await run()).stdout).toContain("无需修改");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["declaration", "missing", "shape"])(
  "预检失败 %s 时已经需要更新的其他目标也零写入",
  async (failure) => {
    const root = await mkdtemp(path.join(tmpdir(), "sync-preflight-"));
    try {
      await mkdir(path.join(root, "packages/cli"), { recursive: true });
      await mkdir(path.join(root, "packages/core/src"), { recursive: true });
      await mkdir(path.join(root, ".devcontainer"), { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          engines: { node: failure === "declaration" ? ">=26" : "26.1.2" },
          packageManager: "pnpm@13.2.1",
        }),
      );
      await writeFile(
        path.join(root, "rust-toolchain.toml"),
        '[toolchain]\nchannel = "1.100.2"\n',
      );
      const cli = '{"engines":{"node":"^24.0.0"},"custom":true}\n';
      const docker = "FROM node:24.0.0-bookworm\nENV CUSTOM=yes\n";
      await writeFile(path.join(root, "packages/cli/package.json"), cli);
      await writeFile(path.join(root, ".devcontainer/Dockerfile"), docker);
      if (failure !== "missing")
        await writeFile(
          path.join(root, "packages/core/src/release-toolchain-snapshot.ts"),
          "export const releaseToolchainSnapshot = compute();\n",
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
      expect(result.exitCode).toBe(1);
      expect(
        await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
      ).toBe(cli);
      expect(
        await readFile(path.join(root, ".devcontainer/Dockerfile"), "utf8"),
      ).toBe(docker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

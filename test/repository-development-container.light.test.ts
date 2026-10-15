import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import type { FixtureCommandRunner } from "@ykdz/template-checks/development-container-session";
import { execa } from "execa";

import { checkRepositoryDevelopmentContainer } from "../scripts/check-repository-development-container.ts";

void it("源码容器冻结检查当前工作树，成功后移除快照、失败时保留诊断", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "repository-container-behavior-"),
  );
  let snapshot: string | undefined;
  let checkFails = false;
  const executed: string[][] = [];
  try {
    await mkdir(path.join(root, ".devcontainer"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        engines: { node: "24.21.0" },
        packageManager: "pnpm@12.9.1",
      }),
    );
    await writeFile(
      path.join(root, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "1.99.0"\n',
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "保持原样的锁文件\n");
    await writeFile(
      path.join(root, ".devcontainer/devcontainer.json"),
      JSON.stringify({ build: { dockerfile: "Dockerfile" }, mounts: [] }),
    );
    await writeFile(
      path.join(root, ".devcontainer/Dockerfile"),
      "FROM node:24.21.0-bookworm\n",
    );
    await writeFile(
      path.join(root, ".gitignore"),
      ".template/\nnode_modules/\n",
    );
    await writeFile(path.join(root, "tracked.ts"), "旧源码\n");
    await writeFile(path.join(root, "deleted.ts"), "将删除\n");
    await execa("git", ["init", "--quiet"], { cwd: root });
    await execa("git", ["add", "--all"], { cwd: root });
    await writeFile(path.join(root, "tracked.ts"), "当前改动\n");
    await writeFile(path.join(root, "new.ts"), "新增源码\n");
    await rm(path.join(root, "deleted.ts"));
    for (const directory of ["node_modules", ".agents", "docs", ".codex"]) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, "local.txt"), "不得复制\n");
    }
    await writeFile(path.join(root, "AGENTS.md"), "不得复制\n");

    const run: FixtureCommandRunner = async (command, args, options) => {
      if (command === "git") return await execa(command, [...args], options);
      if (command === "docker" && args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            { Type: "bind", Source: "/host/source", Destination: root },
          ]),
        };
      }
      if (command === "devcontainer" && args[0] === "up") {
        snapshot = options.cwd;
        assert.strictEqual(
          await readFile(path.join(snapshot, "tracked.ts"), "utf8"),
          "当前改动\n",
        );
        assert.strictEqual(
          await readFile(path.join(snapshot, "new.ts"), "utf8"),
          "新增源码\n",
        );
        for (const file of [
          "deleted.ts",
          "node_modules",
          ".agents",
          "docs",
          ".codex",
          "AGENTS.md",
        ])
          await assert.rejects(access(path.join(snapshot, file)));
        assert.match(
          (await execa("git", ["rev-parse", "HEAD"], { cwd: snapshot })).stdout,
          /^[a-f0-9]{40}$/u,
        );
        assert.ok(
          (await execa("git", ["ls-files"], { cwd: snapshot })).stdout.includes(
            "new.ts",
          ),
        );
      }
      if (command === "devcontainer" && args[0] === "exec") {
        let index = args.indexOf("--id-label") + 2;
        while (args[index] === "--remote-env") index += 2;
        const nested = args.slice(index);
        if (nested[0] === "pnpm") executed.push([...nested]);
        if (checkFails && nested.join(" ") === "pnpm run check")
          throw new Error("正式轻检查失败");
      }
      return { stdout: "" };
    };
    await checkRepositoryDevelopmentContainer({ repositoryRoot: root, run });

    assert.ok(snapshot !== undefined);
    assert.deepStrictEqual(
      executed.filter((command) => command[1] !== "--version"),
      [
        ["pnpm", "install", "--frozen-lockfile", "--store-dir", "/pnpm/store"],
        ["pnpm", "run", "check"],
      ],
    );
    await assert.rejects(access(snapshot));
    assert.strictEqual(
      await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"),
      "保持原样的锁文件\n",
    );
    checkFails = true;
    await assert.rejects(
      checkRepositoryDevelopmentContainer({ repositoryRoot: root, run }),
      /正式轻检查失败/u,
    );
    assert.ok(snapshot !== undefined);
    assert.strictEqual(
      path.dirname(snapshot),
      path.join(root, ".fixture-workspace", "repository-development-container"),
    );
    assert.strictEqual(
      await readFile(path.join(snapshot, "tracked.ts"), "utf8"),
      "当前改动\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./first-release.ts", import.meta.url));
const ownerPackage = fileURLToPath(new URL("../../", import.meta.url));

async function executableInPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续查找当前命令环境里的可执行程序。
    }
  }
  throw new Error(`PATH 中没有可执行命令：${name}`);
}

async function writeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  await chmod(file, 0o755);
}

void test("直接运行 setup 会显示首次使用引导", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-setup-entry-"),
  );
  try {
    const result = spawnSync(
      process.execPath,
      ["--conditions=source", "--experimental-strip-types", entry],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PUBLICATION_TOOL_NAME:
            process.env.PUBLICATION_TOOL_NAME ??
            "@ykdz/reference-npm-publication",
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /一次性向导已就绪/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

void test("公开 pnpm 命令把原生 --filter 参数传给首发逻辑", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-setup-argv-"),
  );
  const binDirectory = path.join(repositoryRoot, "test-bin");
  const packageDirectory = path.join(repositoryRoot, "node_modules", "@ykdz");
  const packageName = "@ykdz/reference-npm-publication";
  const pnpmPath = await executableInPath("pnpm");
  const gitPath = await executableInPath("git");
  const pnpmLog = path.join(repositoryRoot, "pnpm-arguments.json");
  const remoteSha = "0123456789abcdef0123456789abcdef01234567";

  try {
    await mkdir(binDirectory, { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await symlink(
      ownerPackage,
      path.join(packageDirectory, "reference-npm-publication"),
    );
    await writeFile(
      path.join(repositoryRoot, "package.json"),
      JSON.stringify({
        name: "publication-setup-argv-fixture",
        private: true,
        scripts: {
          "publication:setup": `node --import ${packageName}/setup --eval '' --`,
        },
      }),
    );
    await writeExecutable(
      path.join(binDirectory, "git"),
      `const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const key = args.join(" ");
if (key === "rev-parse HEAD") process.stdout.write("${remoteSha}\\n");
else if (key === "status --porcelain --untracked-files=normal") {}
else if (key === "symbolic-ref --quiet --short HEAD") process.stdout.write("main\\n");
else if (key === "ls-remote --symref origin HEAD") process.stdout.write("ref: refs/heads/main\\tHEAD\\n${remoteSha}\\tHEAD\\n");
else if (key === "ls-remote origin refs/heads/main") process.stdout.write("${remoteSha}\\trefs/heads/main\\n");
else execFileSync("${gitPath}", args, { stdio: "inherit" });
`,
    );
    await writeExecutable(
      path.join(binDirectory, "pnpm"),
      `const fs = require("node:fs");
fs.writeFileSync(process.env.PUBLICATION_TEST_PNPM_LOG, JSON.stringify(process.argv.slice(2)));
process.exitCode = 37;
`,
    );

    const runSetup = (arguments_: readonly string[]) =>
      spawnSync(pnpmPath, ["run", "publication:setup", "--", ...arguments_], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          PUBLICATION_TEST_PNPM_LOG: pnpmLog,
        },
      });

    const missingValue = runSetup(["--filter"]);
    assert.equal(missingValue.error, undefined);
    assert.equal(missingValue.status, 1, missingValue.stderr);
    assert.match(
      missingValue.stderr,
      /每个 --filter 都必须提供 pnpm 原生选择器/u,
    );
    await assert.rejects(access(pnpmLog));

    const validSelection = runSetup(["--filter", "@example/cli"]);
    assert.equal(validSelection.error, undefined);
    assert.equal(validSelection.status, 1, validSelection.stderr);
    assert.match(validSelection.stderr, /npm 原件整批验收失败，退出状态 37/u);
    assert.deepEqual(JSON.parse(await readFile(pnpmLog, "utf8")), [
      "run",
      "publication:artifact",
      "--",
      "--filter",
      "@example/cli",
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

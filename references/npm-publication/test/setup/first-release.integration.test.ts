import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { PackageContribution } from "@ykdz/template-workspace/package-contribution";

import { runPublicationSetup } from "../../scripts/setup/first-release.ts";
import { projectPublicationTarget } from "../../template/target.ts";

const entry = fileURLToPath(
  new URL("../../scripts/setup/first-release.ts", import.meta.url),
);
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

void test("首发 setup 将核验的默认分支与仓库根带入真实制品验收", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-setup-branch-"),
  );
  const repositoryRoot = path.join(temporaryRoot, "workspace");
  const packageRoot = path.join(repositoryRoot, "packages", "probe");
  const remoteRoot = path.join(temporaryRoot, "origin.git");
  const packageName = "@example/first-release-probe";
  const gitLog = path.join(temporaryRoot, "git-commands.jsonl");
  const binDirectory = path.join(temporaryRoot, "bin");
  const pnpmPath = await executableInPath("pnpm");
  const turboPath = await executableInPath("turbo");
  const gitPath = await executableInPath("git");
  const publicationTool = path.join(
    repositoryRoot,
    "node_modules",
    "@ykdz",
    "reference-npm-publication",
  );
  const turbo = path.join(repositoryRoot, "node_modules", ".bin", "turbo");
  const taskContribution: PackageContribution = {
    definition: { name: packageName, path: "packages/probe", role: "app" },
    exposure: { exports: {}, imports: {} },
    foundation: {
      toolchains: {},
      editorCapabilities: [],
      dependencyMaintenance: { ecosystems: [], interval: "weekly" },
    },
    environmentNeeds: [],
    manifest: {
      name: packageName,
      version: "1.0.0",
      private: true,
      main: "index.cjs",
      files: ["index.cjs"],
      scripts: { "publication:consume": "node consume.cjs" },
    },
    operations: [
      {
        kind: "writeJson" as const,
        to: "packages/probe/turbo.json",
        value: { extends: ["//"], tags: ["app"], tasks: {} },
      },
    ],
  };
  const projected = projectPublicationTarget({
    contribution: taskContribution,
    configuration: { publication: true },
    bindings: new Map<string, PackageDefinition>([
      [
        "@ykdz/reference-npm-publication",
        {
          name: "@ykdz/reference-npm-publication",
          path: "tools/npm-publication",
          role: "shared-library",
        },
      ],
    ]),
  });
  const turboOperation = projected.operations.find(
    (operation) =>
      operation.kind === "writeJson" &&
      operation.to === "packages/probe/turbo.json",
  );
  assert.ok(turboOperation?.kind === "writeJson");
  const targetTurbo = turboOperation.value as {
    readonly extends: readonly string[];
    readonly tags: readonly string[];
    readonly tasks: Readonly<Record<string, unknown>>;
  };

  try {
    await mkdir(packageRoot, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await mkdir(path.join(repositoryRoot, "node_modules", "@ykdz"), {
      recursive: true,
    });
    await mkdir(path.join(repositoryRoot, "node_modules", ".bin"), {
      recursive: true,
    });
    await writeFile(
      path.join(repositoryRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "first-release-setup-probe",
          private: true,
          packageManager: "pnpm@12.9.1",
          scripts: {
            "publication:artifact":
              "node --import @ykdz/reference-npm-publication/artifact --eval '' --",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(repositoryRoot, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    await writeFile(
      path.join(repositoryRoot, "turbo.json"),
      `${JSON.stringify(
        {
          globalPassThroughEnv: ["PUBLICATION_TEST_GIT_PHASE"],
          tasks: {
            "//#publication:artifact": {
              cache: false,
              tags: ["quality:conditional"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(repositoryRoot, ".gitignore"),
      "node_modules/\n.verified-packed-publication/\n",
    );
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(projected.manifest, null, 2)}\n`,
    );
    await writeFile(
      path.join(packageRoot, "turbo.json"),
      `${JSON.stringify(targetTurbo, null, 2)}\n`,
    );
    await writeFile(
      path.join(packageRoot, "index.cjs"),
      'module.exports = "installed-package-ok";\n',
    );
    await writeFile(
      path.join(packageRoot, "consume.cjs"),
      `const assert = require("node:assert/strict");
const path = require("node:path");
const packageRoot = path.join(process.env.NPM_PUBLICATION_CONSUMER_ROOT, "node_modules", "@example", "first-release-probe");
assert.equal(require(packageRoot), "installed-package-ok");
`,
    );

    const lock = spawnSync(
      pnpmPath,
      ["install", "--lockfile-only", "--offline", "--ignore-scripts"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(lock.error, undefined);
    assert.equal(lock.status, 0, lock.stderr);

    await symlink(ownerPackage, publicationTool, "dir");
    await symlink(turboPath, turbo);
    await writeExecutable(
      path.join(binDirectory, "git"),
      `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const log = ${JSON.stringify(gitLog)};
fs.appendFileSync(log, JSON.stringify({ phase: process.env.PUBLICATION_TEST_GIT_PHASE ?? "remote-check", cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
execFileSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });
`,
    );
    execFileSync(gitPath, [
      "init",
      "--bare",
      "--initial-branch=main",
      remoteRoot,
    ]);
    execFileSync(gitPath, ["init", "--initial-branch=main", repositoryRoot]);
    execFileSync(gitPath, ["config", "user.name", "Publication Probe"], {
      cwd: repositoryRoot,
    });
    execFileSync(gitPath, ["config", "user.email", "probe@example.test"], {
      cwd: repositoryRoot,
    });
    execFileSync(gitPath, ["add", "."], { cwd: repositoryRoot });
    execFileSync(gitPath, ["commit", "-m", "Prepare setup fixture"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    execFileSync(gitPath, ["remote", "add", "origin", remoteRoot], {
      cwd: repositoryRoot,
    });
    execFileSync(gitPath, ["push", "origin", "main"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    const sourceSha = execFileSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();

    const environmentKeys = [
      "GITHUB_ACTIONS",
      "GITHUB_DEFAULT_BRANCH",
      "PUBLICATION_REPOSITORY_ROOT",
      "PUBLICATION_SOURCE_SHA",
      "PUBLICATION_TEST_GIT_PHASE",
      "PATH",
    ] as const;
    const previousEnvironment = new Map(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    process.env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.PUBLICATION_TEST_GIT_PHASE = "setup";
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_DEFAULT_BRANCH;
    delete process.env.PUBLICATION_REPOSITORY_ROOT;
    delete process.env.PUBLICATION_SOURCE_SHA;

    let artifactOutput = "";
    const messages: string[] = [];
    try {
      await runPublicationSetup({
        repositoryRoot,
        arguments_: ["--filter", packageName],
        runCommand: async (command, arguments_, options) => {
          const env = {
            ...options.env,
            PUBLICATION_TEST_GIT_PHASE: "artifact",
          };
          const result = spawnSync(command, [...arguments_], {
            cwd: options.cwd,
            env,
            encoding: "utf8",
            timeout: 300_000,
          });
          artifactOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          if (result.error !== undefined) throw result.error;
          return result.status ?? 1;
        },
        prompt: async () => "no",
        write: (message) => messages.push(message),
      });
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const artifactRoot = path.join(
      repositoryRoot,
      ".verified-packed-publication/first-release",
    );
    const receipt = JSON.parse(
      await readFile(
        path.join(artifactRoot, "publication-preparation.json"),
        "utf8",
      ),
    ) as {
      readonly sourceSha: string;
      readonly pack: { readonly count: number };
    };
    assert.equal(receipt.sourceSha, sourceSha);
    assert.equal(receipt.pack.count, 1);
    assert.match(artifactOutput, /npm 制品整批本地验收通过/u);
    assert.ok(
      messages.some((message) => message.startsWith("未执行外部写入；")),
    );

    const gitCommands = (await readFile(gitLog, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly cwd: string;
            readonly args: readonly string[];
          },
      );
    const repositoryStatusChecks = gitCommands.filter(
      (event) => event.args[0] === "status" && event.args[1] === "--porcelain",
    );
    assert.equal(repositoryStatusChecks.length, 2);
    assert.ok(
      repositoryStatusChecks.every((event) => event.cwd === repositoryRoot),
    );
    const defaultBranchChecks = gitCommands.filter(
      (event) =>
        event.args[0] === "symbolic-ref" &&
        event.args[1] === "--quiet" &&
        event.args[2] === "--short",
    );
    assert.equal(defaultBranchChecks.length, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

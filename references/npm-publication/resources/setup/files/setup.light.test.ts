import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPublicationSetup } from "./setup.ts";

void test("未选择目标时只说明公开入口，不访问远端或启动验收", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-first-release-help-"),
  );
  const messages: string[] = [];
  try {
    await runPublicationSetup({
      repositoryRoot,
      run: async () => {
        throw new Error("没有目标时不应访问 Git 或 GitHub");
      },
      runCommand: async () => {
        throw new Error("没有目标时不应运行制品验收");
      },
      prompt: async () => {
        throw new Error("没有原件时不应确认外部写入");
      },
      write: (message) => messages.push(message),
    });

    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /pnpm run publication:setup -- --filter/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

void test("远端批次复用验收清单，npm失败仍交给Release批次处理就绪目标", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-first-release-batches-"),
  );
  const sourceSha = "b".repeat(40);
  const commands: {
    readonly arguments_: readonly string[];
    readonly environment: NodeJS.ProcessEnv;
  }[] = [];
  const messages: string[] = [];
  try {
    await assert.rejects(
      runPublicationSetup({
        repositoryRoot,
        arguments_: ["--filter", "@example/cli", "--filter", "@example/lib"],
        run: async (_command, arguments_) => {
          if (arguments_[0] === "rev-parse") {
            return { exitCode: 0, stdout: `${sourceSha}\n`, stderr: "" };
          }
          if (arguments_[0] === "ls-remote" && arguments_[1] === "--symref") {
            return {
              exitCode: 0,
              stdout: `ref: refs/heads/main\tHEAD\n${sourceSha}\tHEAD\n`,
              stderr: "",
            };
          }
          if (arguments_[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (arguments_[0] === "symbolic-ref") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (arguments_[0] === "ls-remote") {
            return {
              exitCode: 0,
              stdout: `${sourceSha}\trefs/heads/main\n`,
              stderr: "",
            };
          }
          throw new Error(`测试不允许该命令：${arguments_.join(" ")}`);
        },
        runCommand: async (_command, arguments_, options) => {
          commands.push({ arguments_, environment: options.env });
          if (arguments_[1] === "publication:artifact") {
            const outputDirectory =
              options.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY;
            assert.ok(outputDirectory);
            await mkdir(outputDirectory, { recursive: true });
            await writeFile(
              path.join(outputDirectory, "publication-accepted-artifacts.json"),
              JSON.stringify({
                artifacts: [
                  {
                    packageRoot: "packages/cli",
                    packageName: "@example/cli",
                    artifactVersion: "1.2.3-beta.1",
                    artifactPath: "%40example%2Fcli/example-cli.tgz",
                    receiptPath:
                      "%40example%2Fcli/publication-preparation.json",
                    sha512: "a".repeat(128),
                  },
                  {
                    packageRoot: "packages/lib",
                    packageName: "@example/lib",
                    artifactVersion: "2.0.0-rc.1",
                    artifactPath: "%40example%2Flib/example-lib.tgz",
                    receiptPath:
                      "%40example%2Flib/publication-preparation.json",
                    sha512: "c".repeat(128),
                  },
                ],
              }),
            );
            return 0;
          }
          if (arguments_[1] === "publication:remote:npm") return 1;
          if (arguments_[1] === "publication:remote:release") return 0;
          throw new Error(`测试不允许该命令：${arguments_.join(" ")}`);
        },
        prompt: async (message) => {
          messages.push(message);
          return messages.length === 1
            ? "RC"
            : messages.length === 2
              ? "_beta"
              : "yes";
        },
        write: () => undefined,
      }),
      /首发未全部完成.*npm 1/u,
    );

    assert.deepEqual(
      commands.map(({ arguments_ }) => arguments_.join(" ")),
      [
        "run publication:artifact -- --filter @example/cli --filter @example/lib",
        "run publication:remote:npm",
        "run publication:remote:release",
      ],
    );
    assert.deepEqual(
      JSON.parse(commands[1]!.environment.PUBLICATION_DIST_TAGS!),
      { "@example/cli": "RC", "@example/lib": "_beta" },
    );
    assert.equal(
      commands[1]!.environment.PUBLICATION_CREDENTIAL_MODE,
      "interactive",
    );
    assert.equal(
      commands[1]!.environment.PUBLICATION_ACCEPTED_ARTIFACTS_FILE,
      commands[2]!.environment.PUBLICATION_ACCEPTED_ARTIFACTS_FILE,
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

void test("取消后重跑只续办已验收原件，不重复打包", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-first-release-resume-"),
  );
  const sourceSha = "c".repeat(40);
  const commands: string[] = [];
  const confirmations = ["no", "yes"];
  try {
    const run = async (_command: string, arguments_: readonly string[]) => {
      if (arguments_[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${sourceSha}\n`, stderr: "" };
      }
      if (arguments_[0] === "ls-remote" && arguments_[1] === "--symref") {
        return {
          exitCode: 0,
          stdout: `ref: refs/heads/main\tHEAD\n${sourceSha}\tHEAD\n`,
          stderr: "",
        };
      }
      if (arguments_[0] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (arguments_[0] === "symbolic-ref") {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      if (arguments_[0] === "ls-remote") {
        return {
          exitCode: 0,
          stdout: `${sourceSha}\trefs/heads/main\n`,
          stderr: "",
        };
      }
      throw new Error(`测试不允许该命令：${arguments_.join(" ")}`);
    };
    const runCommand = async (
      _command: string,
      arguments_: readonly string[],
      options: { readonly env: NodeJS.ProcessEnv },
    ) => {
      const command = arguments_[1];
      commands.push(command ?? "");
      if (command === "publication:artifact") {
        const outputDirectory =
          options.env.PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY;
        assert.ok(outputDirectory);
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
          path.join(outputDirectory, "publication-accepted-artifacts.json"),
          JSON.stringify({
            artifacts: [
              {
                packageRoot: "packages/cli",
                packageName: "@example/cli",
                artifactVersion: "1.2.3",
                artifactPath: "%40example%2Fcli/example-cli.tgz",
                receiptPath: "%40example%2Fcli/publication-preparation.json",
                sha512: "b".repeat(128),
              },
            ],
          }),
        );
        return 0;
      }
      return 0;
    };
    const prompt = async () => confirmations.shift() ?? "no";
    const options = {
      repositoryRoot,
      run,
      runCommand,
      prompt,
      write: () => {},
    };

    await runPublicationSetup({
      ...options,
      arguments_: ["--filter", "@example/cli"],
    });
    await runPublicationSetup({ ...options, arguments_: [] });

    assert.deepEqual(commands, [
      "publication:artifact",
      "publication:remote:npm",
      "publication:remote:release",
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

void test("预发布 tag 沿用 npm 语义拒绝版本范围和空格", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-first-release-tags-"),
  );
  const artifactRoot = path.join(
    repositoryRoot,
    ".verified-packed-publication/first-release",
  );
  try {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      path.join(artifactRoot, "publication-accepted-artifacts.json"),
      JSON.stringify({
        artifacts: [
          {
            packageRoot: "packages/cli",
            packageName: "@example/cli",
            artifactVersion: "1.2.3-rc.1",
            artifactPath: "%40example%2Fcli/example-cli.tgz",
            receiptPath: "%40example%2Fcli/publication-preparation.json",
            sha512: "d".repeat(128),
          },
        ],
      }),
    );

    for (const tag of ["1.2", "two words"]) {
      await assert.rejects(
        runPublicationSetup({
          repositoryRoot,
          arguments_: [],
          runCommand: async () => {
            throw new Error("无效 tag 不应进入远端批次");
          },
          prompt: async () => tag,
          write: () => undefined,
        }),
        /有效的非 latest dist-tag/u,
      );
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

void test("整批制品验收失败时不会开始 npm 或 GitHub 写入", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "publication-first-release-"),
  );
  const sourceSha = "a".repeat(40);
  const remoteCommands: string[] = [];
  const localCommands: string[] = [];
  try {
    await assert.rejects(
      runPublicationSetup({
        repositoryRoot,
        arguments_: ["--filter", "@example/cli", "--filter=@example/lib"],
        run: async (command, arguments_) => {
          remoteCommands.push(`${command} ${arguments_.join(" ")}`);
          if (arguments_[0] === "rev-parse") {
            return { exitCode: 0, stdout: `${sourceSha}\n`, stderr: "" };
          }
          if (arguments_[0] === "ls-remote" && arguments_[1] === "--symref") {
            return {
              exitCode: 0,
              stdout: `ref: refs/heads/main\tHEAD\n${sourceSha}\tHEAD\n`,
              stderr: "",
            };
          }
          if (arguments_[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (arguments_[0] === "symbolic-ref") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (arguments_[0] === "ls-remote") {
            return {
              exitCode: 0,
              stdout: `${sourceSha}\trefs/heads/main\n`,
              stderr: "",
            };
          }
          throw new Error(
            `测试不允许该命令：${command} ${arguments_.join(" ")}`,
          );
        },
        runCommand: async (command, arguments_) => {
          localCommands.push(`${command} ${arguments_.join(" ")}`);
          return 1;
        },
        prompt: async () => {
          throw new Error("验收失败后不应询问远端写入确认");
        },
        write: () => undefined,
      }),
      /整批验收失败.*未执行外部写入/u,
    );
    assert.deepEqual(localCommands, [
      "pnpm run publication:artifact -- --filter @example/cli --filter @example/lib",
    ]);
    assert.equal(
      remoteCommands.some((command) => command.startsWith("gh ")),
      false,
    );
    assert.equal(
      remoteCommands.some((command) => command.includes(" publish ")),
      false,
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

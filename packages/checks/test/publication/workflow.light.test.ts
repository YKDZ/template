import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acceptArtifact,
  prepareArtifact,
  readAcceptedArtifact,
} from "@ykdz/reference-npm-publication";
import {
  runDirectOidcPublication,
  type ProcessResult,
} from "@ykdz/template-workspace/npm-publication/publish";

const packageName = "@publisher/tool";
const packageVersion = "1.2.3";

async function createPackage(repositoryRoot: string): Promise<string> {
  const packageRoot = path.join(repositoryRoot, "packages/cli");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: packageVersion,
        type: "commonjs",
        main: "index.cjs",
        files: ["index.cjs", "consume.cjs"],
        repository: "git+https://github.com/publisher/tool.git",
        scripts: { "publication:consume": "node consume.cjs" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(packageRoot, "index.cjs"),
    'exports.value = "installed original";\n',
  );
  await writeFile(
    path.join(packageRoot, "consume.cjs"),
    [
      'const assert = require("node:assert/strict");',
      'const { createRequire } = require("node:module");',
      'const path = require("node:path");',
      'const consumerRequire = createRequire(path.join(process.env.NPM_PUBLICATION_CONSUMER_ROOT, "package.json"));',
      `assert.equal(consumerRequire(${JSON.stringify(packageName)}).value, "installed original");`,
    ].join("\n") + "\n",
  );
  return packageRoot;
}

function remoteEnvironment(runDirectory: string) {
  return {
    GITHUB_REPOSITORY: "publisher/tool",
    GITHUB_RUN_ATTEMPT: "1",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.test/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
    RUNNER_TEMP: runDirectory,
  };
}

void describe("远端发布消费共享验收原件", () => {
  void it("准备回执尚未记录安装与消费验收时，不调用外部命令", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(tmpdir(), "npm-publication-prepared-only-"),
    );
    const artifactDirectory = path.join(repositoryRoot, "artifact");
    const packageRoot = await createPackage(repositoryRoot);
    const commands: string[] = [];

    try {
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory: artifactDirectory,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") {
        throw new Error("普通 npm 包的共享原件准备失败");
      }

      await assert.rejects(
        runDirectOidcPublication({
          repositoryRoot,
          artifactDirectory,
          environment: remoteEnvironment(repositoryRoot),
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        /消费验收尚未通过/u,
      );
      assert.deepEqual(commands, []);
      await assert.rejects(
        readAcceptedArtifact({ packageRoot, artifactDirectory }),
        /消费验收尚未通过/u,
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  void it("安装消费验收后只把 receipt 绑定的原件传给受控 npm 命令", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(tmpdir(), "npm-publication-accepted-"),
    );
    const artifactDirectory = path.join(repositoryRoot, "artifact");
    const packageRoot = await createPackage(repositoryRoot);
    const commands: {
      readonly command: string;
      readonly args: readonly string[];
    }[] = [];
    let exactLookups = 0;
    let publishedArtifact: string | undefined;
    let integrity = "";

    try {
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory: artifactDirectory,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") {
        throw new Error("普通 npm 包的共享原件准备失败");
      }
      const accepted = await acceptArtifact({
        packageRoot,
        artifactPath: prepared.artifactPath,
      });
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") {
        throw new Error("普通 npm 包的安装和消费验收失败");
      }
      integrity = `sha512-${Buffer.from(accepted.sha512, "hex").toString("base64")}`;

      const run = async (
        command: string,
        args: readonly string[],
      ): Promise<ProcessResult> => {
        commands.push({ command, args });
        if (args[0] === "pnpm" && args[1] === "install") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("config") && args.includes("fetch-retries")) {
          return { exitCode: 0, stdout: "1\n", stderr: "" };
        }
        if (args.includes("config") && args.includes("registry")) {
          return {
            exitCode: 0,
            stdout: "https://registry.npmjs.org/\n",
            stderr: "",
          };
        }
        if (args.includes("dist-tags")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              latest:
                publishedArtifact === undefined ? "1.0.0" : packageVersion,
            }),
            stderr: "",
          };
        }
        if (args.includes("dist.integrity")) {
          exactLookups += 1;
          if (exactLookups === 1) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "npm error code E404\n",
            };
          }
          return { exitCode: 0, stdout: JSON.stringify(integrity), stderr: "" };
        }
        if (args.includes("publish")) {
          publishedArtifact = args.find((argument) =>
            argument.endsWith(".tgz"),
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("install")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`未预期的受控命令：${command} ${args.join(" ")}`);
      };

      await runDirectOidcPublication({
        repositoryRoot,
        artifactDirectory,
        environment: remoteEnvironment(repositoryRoot),
        run,
      });

      assert.equal(publishedArtifact, prepared.artifactPath);
      assert.ok(
        commands.some(
          ({ args }) =>
            args.includes("publish") && args.includes(prepared.artifactPath),
        ),
      );
      const reread = await readAcceptedArtifact({
        packageRoot,
        artifactDirectory,
      });
      assert.equal(reread.kind, "prepared");
      if (reread.kind !== "prepared") {
        throw new Error("已验收原件回执无法重读");
      }
      assert.equal(reread.sha512, accepted.sha512);
      assert.equal(reread.artifactPath, prepared.artifactPath);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});

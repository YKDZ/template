import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  acceptArtifact,
  inspectTarget,
  prepareArtifact,
  readAcceptedArtifact,
  readPreparedArtifact,
} from "@ykdz/reference-npm-publication";

import { restoreAcceptedPublicationArtifacts } from "./accepted-artifacts.ts";
import {
  defaultRemoteCommand,
  type RemoteCommandRunner,
} from "./remote-context.ts";

const execFileAsync = promisify(execFile);

async function makePackage(root: string): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@example/lifecycle-package",
        version: "1.2.3-beta.1+build.2",
        code: "consumer-metadata",
        type: "module",
        exports: "./index.mjs",
        files: ["index.mjs", "lifecycle.mjs", "consume.mjs"],
        scripts: {
          prepack: "node lifecycle.mjs prepack",
          postinstall: "node lifecycle.mjs postinstall",
          "publication:consume": "node consume.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "index.mjs"),
    'export const value = "installed archive";\n',
  );
  await writeFile(
    path.join(root, "lifecycle.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "const log = process.env.NPM_PUBLICATION_EVENT_LOG;",
      "if (log) await appendFile(log, `${process.argv[2]}\\n`);",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "consume.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      'import path from "node:path";',
      'import { appendFile } from "node:fs/promises";',
      "const consumer = process.env.NPM_PUBLICATION_CONSUMER_ROOT;",
      "assert.ok(consumer);",
      'const require = createRequire(path.join(consumer, "package.json"));',
      'assert.equal(require("@example/lifecycle-package").value, "installed archive");',
      'await appendFile(process.env.NPM_PUBLICATION_EVENT_LOG, "consume\\n");',
    ].join("\n"),
  );
}

async function makeBatchPackage(
  root: string,
  options: {
    readonly name: string;
    readonly value: string;
    readonly version?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly consumerExpectations?: Readonly<Record<string, string>>;
    readonly prepareCommand?: string;
    readonly postinstallCommand?: string;
    readonly buildCommand?: string;
  },
): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: options.name,
        version: options.version ?? "1.0.0",
        type: "module",
        exports: "./index.mjs",
        files: ["index.mjs", "lifecycle.mjs", "consume.mjs"],
        scripts: {
          prepack: "node lifecycle.mjs prepack",
          postinstall:
            options.postinstallCommand ?? "node lifecycle.mjs postinstall",
          ...(options.buildCommand === undefined
            ? {}
            : { build: options.buildCommand }),
          "publication:consume": "node consume.mjs",
          ...(options.prepareCommand === undefined
            ? {}
            : { "publication:prepare": options.prepareCommand }),
        },
        ...(options.dependencies === undefined
          ? {}
          : { dependencies: options.dependencies }),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "index.mjs"),
    `export const value = ${JSON.stringify(options.value)};\n`,
  );
  await writeFile(
    path.join(root, "lifecycle.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "const log = process.env.NPM_PUBLICATION_EVENT_LOG;",
      `if (log) await appendFile(log, ${JSON.stringify(`${options.value}:`)} + process.argv[2] + "\\n");`,
    ].join("\n"),
  );
  const expected = {
    [options.name]: options.value,
    ...options.consumerExpectations,
  };
  await writeFile(
    path.join(root, "consume.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { createRequire } from "node:module";',
      'import path from "node:path";',
      'import { appendFile } from "node:fs/promises";',
      "const consumer = process.env.NPM_PUBLICATION_CONSUMER_ROOT;",
      "assert.ok(consumer);",
      'const require = createRequire(path.join(consumer, "package.json"));',
      `for (const [name, value] of Object.entries(${JSON.stringify(expected)})) {`,
      "  assert.equal(require(name).value, value);",
      "}",
      `await appendFile(process.env.NPM_PUBLICATION_EVENT_LOG, ${JSON.stringify(`${options.value}:consume\n`)});`,
    ].join("\n"),
  );
}

async function sha512(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha512")
    .update(await readFile(filePath))
    .digest("hex");
}

async function makePublicationCommandShims(options: {
  readonly root: string;
  readonly logPath: string;
}): Promise<{ readonly env: NodeJS.ProcessEnv }> {
  const shimDirectory = path.join(options.root, "command-shims");
  await mkdir(shimDirectory, { recursive: true });
  const originalPath = process.env.PATH ?? "";
  const env = {
    ...process.env,
    PATH: `${shimDirectory}${path.delimiter}${originalPath}`,
    NPM_PUBLICATION_EXTERNAL_WRITE_LOG: options.logPath,
  };

  for (const command of ["pnpm", "npm", "gh"] as const) {
    const realCommand =
      command === "gh"
        ? ""
        : (
            await execFileAsync("which", [command], {
              encoding: "utf8",
              env: process.env,
            })
          ).stdout.trim();
    const scriptPath = path.join(shimDirectory, command);
    const script = [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `const command = ${JSON.stringify(command)};`,
      "const arguments_ = process.argv.slice(2);",
      'const write = command === "npm" && arguments_.includes("publish") || command === "pnpm" && arguments_.includes("publish") || command === "gh" && arguments_[0] === "release" && arguments_[1] === "create";',
      "if (process.env.NPM_PUBLICATION_EXTERNAL_WRITE_LOG) appendFileSync(process.env.NPM_PUBLICATION_EXTERNAL_WRITE_LOG, `${JSON.stringify({ command, arguments: arguments_, write })}${String.fromCharCode(10)}`);",
      "if (write) process.exit(97);",
      `const result = spawnSync(${JSON.stringify(realCommand)}, arguments_, { stdio: "inherit", env: process.env });`,
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n");
    await writeFile(scriptPath, script);
    await chmod(scriptPath, 0o755);
  }

  return { env };
}

async function installPnpmFixtureDependencies(
  workspaceRoot: string,
): Promise<void> {
  await execFileAsync("pnpm", ["install", "--ignore-scripts"], {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function linkPublicationOwner(workspaceRoot: string): Promise<void> {
  const ownerRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const ownerNodeModules = path.join(workspaceRoot, "node_modules/@ykdz");
  await mkdir(ownerNodeModules, { recursive: true });
  await symlink(
    ownerRoot,
    path.join(ownerNodeModules, "reference-npm-publication"),
    "dir",
  );
}

async function makeTurboWorkspace(
  workspaceRoot: string,
  options: { readonly buildGraph?: boolean } = {},
): Promise<void> {
  const buildGraph = options.buildGraph ?? false;
  await writeFile(
    path.join(workspaceRoot, "turbo.json"),
    `${JSON.stringify(
      {
        $schema: "https://turbo.build/schema.json",
        tasks: {
          "publication:prepare": {
            dependsOn: buildGraph ? ["build"] : [],
            cache: false,
            outputs: [],
            passThroughEnv: [
              "PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY",
              "TEMPLATE_VERIFIED_PACKED_ARTIFACT_DIR",
              "PUBLICATION_BATCH_TARGET_COUNT",
              "NPM_PUBLICATION_EXTERNAL_WRITE_LOG",
              "NPM_PUBLICATION_EVENT_LOG",
            ],
          },
          ...(buildGraph
            ? {
                build: {
                  dependsOn: ["^build"],
                  cache: false,
                  outputs: [],
                  passThroughEnv: ["NPM_PUBLICATION_EVENT_LOG"],
                },
              }
            : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
}

void describe("共享 npm 制品准备", () => {
  void it("打包并正常安装普通包后运行其自有消费命令", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-contract-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(packageRoot, { recursive: true });
    await makePackage(packageRoot);
    const env = { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog };

    try {
      const originalManifest = await readFile(
        path.join(packageRoot, "package.json"),
        "utf8",
      );
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory,
        sourceSha: "0123456789abcdef0123456789abcdef01234567",
        env,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") throw new Error("共享制品准备被阻断");
      assert.equal(prepared.packageVersion, "1.2.3-beta.1+build.2");
      assert.equal(prepared.artifactVersion, "1.2.3-beta.1");
      await assert.rejects(
        readAcceptedArtifact({
          packageRoot,
          artifactDirectory: outputDirectory,
        }),
        /消费验收尚未通过/u,
      );

      await writeFile(
        path.join(packageRoot, "package.json"),
        originalManifest.replace("1.2.3-beta.1+build.2", "2.0.0"),
      );
      await assert.rejects(
        acceptArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
          env,
        }),
        /制品 @example\/lifecycle-package/u,
      );
      await writeFile(path.join(packageRoot, "package.json"), originalManifest);

      const accepted = await acceptArtifact({
        packageRoot,
        artifactPath: prepared.artifactPath,
        env,
      });
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") throw new Error("共享制品验收被阻断");
      assert.equal(accepted.sha512, prepared.sha512);
      assert.equal(accepted.artifactVersion, prepared.artifactVersion);
      const acceptedArtifact = await readAcceptedArtifact({
        packageRoot,
        artifactDirectory: outputDirectory,
      });
      assert.equal(acceptedArtifact.kind, "prepared");
      if (acceptedArtifact.kind !== "prepared") {
        throw new Error("已验收共享制品回执读取被阻断");
      }
      assert.equal(acceptedArtifact.sha512, prepared.sha512);
      const receipt = JSON.parse(
        await readFile(
          path.join(outputDirectory, "publication-preparation.json"),
          "utf8",
        ),
      ) as { readonly acceptance?: unknown; readonly sourceSha?: string };
      assert.equal(
        receipt.sourceSha,
        "0123456789abcdef0123456789abcdef01234567",
      );
      assert.deepEqual(receipt.acceptance, {
        packageName: prepared.packageName,
        artifactVersion: prepared.artifactVersion,
        sha512: prepared.sha512,
        installation: "passed",
        consumption: "passed",
      });
      await writeFile(
        path.join(packageRoot, "package.json"),
        originalManifest.replace("1.2.3-beta.1+build.2", "2.0.0"),
      );
      await assert.rejects(
        readAcceptedArtifact({
          packageRoot,
          artifactDirectory: outputDirectory,
        }),
        /当前包配置不一致/u,
      );
      const originalTarget = await readAcceptedArtifact({
        packageRoot,
        artifactDirectory: outputDirectory,
        preserveReceiptTarget: true,
      });
      assert.equal(originalTarget.kind, "prepared");
      if (originalTarget.kind !== "prepared") {
        throw new Error("原提交目标的共享制品回执读取被阻断");
      }
      assert.equal(originalTarget.packageVersion, "1.2.3-beta.1+build.2");
      assert.equal(
        originalTarget.receipt.sourceSha,
        "0123456789abcdef0123456789abcdef01234567",
      );
      await writeFile(path.join(packageRoot, "package.json"), originalManifest);
      const reread = await readPreparedArtifact({
        packageRoot,
        artifactDirectory: outputDirectory,
      });
      assert.equal(reread.kind, "prepared");
      if (reread.kind !== "prepared") {
        throw new Error("共享制品回执读取被阻断");
      }
      assert.equal(reread.artifactPath, prepared.artifactPath);
      assert.equal(reread.packageVersion, "1.2.3-beta.1+build.2");
      assert.equal(reread.artifactVersion, "1.2.3-beta.1");
      assert.equal(reread.sha512, prepared.sha512);
      assert.equal(reread.receipt.acceptance?.consumption, "passed");
      await writeFile(prepared.artifactPath, "modified original bytes");
      await assert.rejects(
        readPreparedArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
        }),
        /原件已变化/u,
      );
      assert.deepEqual((await readFile(eventLog, "utf8")).trim().split("\n"), [
        "prepack",
        "postinstall",
        "consume",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("同 run 重跑恢复原验收原件，不增加打包或消费次数", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-rerun-"),
    );
    const packageRoot = path.join(workspace, "package");
    const originalDirectory = path.join(workspace, "original", "package");
    const uploadedDirectory = path.join(workspace, "uploaded");
    const restoredDirectory = path.join(workspace, "restored");
    const eventLog = path.join(workspace, "lifecycle.log");
    const sourceSha = "0123456789abcdef0123456789abcdef01234567";
    const runId = "4242";
    const artifactName = `verified-packed-publication-${runId}`;
    let artifactExists = false;
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(workspace, "package.json"),
      '{"name":"@example/rerun-workspace","private":true}\n',
    );
    await writeFile(
      path.join(workspace, "pnpm-workspace.yaml"),
      "packages:\n  - package\n",
    );
    await makePackage(packageRoot);

    const run: RemoteCommandRunner = async (command, arguments_, options) => {
      if (command === "gh" && arguments_[0] === "api") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            artifacts: artifactExists
              ? [{ name: artifactName, expired: false }]
              : [],
          }),
          stderr: "",
        };
      }
      if (command === "gh" && arguments_[0] === "run") {
        const destination = arguments_
          .find((argument) => argument.startsWith("--dir="))!
          .slice("--dir=".length);
        await mkdir(destination, { recursive: true });
        await copyFile(
          path.join(uploadedDirectory, "publication-accepted-artifacts.json"),
          path.join(destination, "publication-accepted-artifacts.json"),
        );
        await mkdir(path.join(destination, "package"), { recursive: true });
        for (const name of await readdir(originalDirectory)) {
          await copyFile(
            path.join(originalDirectory, name),
            path.join(destination, "package", name),
          );
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return await defaultRemoteCommand(command, arguments_, options);
    };
    const baseOptions = {
      repositoryRoot: workspace,
      sourceSha,
      filters: ["./package"],
      runId,
      githubRepository: "example/repository",
      environment: {
        GH_TOKEN: "controlled-token",
        GITHUB_ACTIONS: "true",
      },
      run,
    };

    try {
      const firstAttempt = await restoreAcceptedPublicationArtifacts({
        ...baseOptions,
        artifactDirectory: path.join(workspace, "first-attempt"),
        runAttempt: 1,
      });
      assert.equal(firstAttempt, false);

      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory: originalDirectory,
        sourceSha,
        env: { NPM_PUBLICATION_EVENT_LOG: eventLog },
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") {
        throw new Error("共享制品准备被阻断");
      }
      const accepted = await acceptArtifact({
        packageRoot,
        artifactPath: prepared.artifactPath,
        env: { NPM_PUBLICATION_EVENT_LOG: eventLog },
      });
      assert.equal(accepted.kind, "accepted");

      await mkdir(uploadedDirectory, { recursive: true });
      await mkdir(path.join(uploadedDirectory, "package"), {
        recursive: true,
      });
      for (const name of await readdir(originalDirectory)) {
        await copyFile(
          path.join(originalDirectory, name),
          path.join(uploadedDirectory, "package", name),
        );
      }
      await writeFile(
        path.join(uploadedDirectory, "publication-accepted-artifacts.json"),
        `${JSON.stringify(
          {
            artifacts: [
              {
                packageRoot: "package",
                packageName: prepared.packageName,
                artifactVersion: prepared.artifactVersion,
                artifactPath: `package/${path.basename(prepared.artifactPath)}`,
                receiptPath: "package/publication-preparation.json",
                sha512: prepared.sha512,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      artifactExists = true;
      const beforeRerun = await readFile(eventLog, "utf8");

      const rerun = await restoreAcceptedPublicationArtifacts({
        ...baseOptions,
        artifactDirectory: restoredDirectory,
        runAttempt: 2,
      });
      assert.equal(rerun, true);
      const restored = await readAcceptedArtifact({
        packageRoot,
        artifactDirectory: path.join(restoredDirectory, "package"),
        preserveReceiptTarget: true,
      });
      assert.equal(restored.kind, "prepared");
      if (restored.kind !== "prepared") {
        throw new Error("恢复后的已验收原件读取被阻断");
      }
      assert.equal(restored.receipt.sourceSha, sourceSha);
      assert.equal(restored.sha512, prepared.sha512);
      assert.equal(await readFile(eventLog, "utf8"), beforeRerun);
      assert.deepEqual(beforeRerun.trim().split("\n"), [
        "prepack",
        "postinstall",
        "consume",
      ]);

      await assert.rejects(
        restoreAcceptedPublicationArtifacts({
          ...baseOptions,
          artifactDirectory: path.join(workspace, "lost-attempt"),
          runAttempt: 3,
          run: async (command, arguments_, options) =>
            command === "gh" && arguments_[0] === "api"
              ? {
                  exitCode: 0,
                  stdout: JSON.stringify({ artifacts: [] }),
                  stderr: "",
                }
              : await defaultRemoteCommand(command, arguments_, options),
        }),
        /原验收原件缺失或过期/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("报告目标配置缺口并传递消费失败", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-failure-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@example/missing-consumer","version":"1.0.0"}\n',
    );
    const missing = await inspectTarget({ packageRoot });
    assert.equal(missing.kind, "blocked");
    assert.ok(
      missing.blockers.some(
        (item) =>
          item.field === "package.json#/scripts/publication:consume" &&
          item.target === packageRoot &&
          item.nextAction.includes("publication:consume"),
      ),
    );

    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@example/invalid-version","version":"banana","scripts":{"publication:consume":"node consume.mjs"}}\n',
    );
    const invalidVersion = await inspectTarget({ packageRoot });
    assert.equal(invalidVersion.kind, "blocked");
    assert.ok(
      invalidVersion.blockers.some(
        (item) =>
          item.field === "package.json#/version" &&
          item.code === "publication-package-version-invalid" &&
          item.target === packageRoot &&
          item.nextAction.includes("SemVer"),
      ),
    );

    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"JSONStream","version":"1.3.5","scripts":{"publication:consume":"node consume.mjs"}}\n',
    );
    const legacyName = await inspectTarget({ packageRoot });
    assert.equal(legacyName.kind, "ready");

    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"%%%","version":"1.3.5","scripts":{"publication:consume":"node consume.mjs"}}\n',
    );
    const invalidName = await inspectTarget({ packageRoot });
    assert.equal(invalidName.kind, "blocked");
    assert.ok(
      invalidName.blockers.some(
        (item) =>
          item.field === "package.json#/name" &&
          item.code === "publication-package-name-invalid",
      ),
    );

    await makePackage(packageRoot);
    const manifestPath = path.join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["publication:consume"] = 'node -e "process.exit(37)"';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const prepared = await prepareArtifact({
      packageRoot,
      outputDirectory,
      env: { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog },
    });
    assert.equal(prepared.kind, "prepared");
    const originalDigest = prepared.sha512;

    try {
      await assert.rejects(
        acceptArtifact({ packageRoot, artifactPath: prepared.artifactPath }),
        /退出状态 37/u,
      );
      assert.equal(
        await import("node:crypto").then(({ createHash }) =>
          readFile(prepared.artifactPath).then((bytes) =>
            createHash("sha512").update(bytes).digest("hex"),
          ),
        ),
        originalDigest,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("一次正常安装并验收有依赖关系的整批 tgz", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-"),
    );
    const baseRoot = path.join(workspace, "base");
    const dependentRoot = path.join(workspace, "dependent");
    const baseOutput = path.join(workspace, "artifacts", "base");
    const dependentOutput = path.join(workspace, "artifacts", "dependent");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(baseRoot, { recursive: true });
    await mkdir(dependentRoot, { recursive: true });
    await makeBatchPackage(baseRoot, {
      name: "@example/batch-base",
      value: "base",
    });
    await makeBatchPackage(dependentRoot, {
      name: "@example/batch-dependent",
      value: "dependent",
      dependencies: { "@example/batch-base": "1.0.0" },
      consumerExpectations: { "@example/batch-base": "base" },
    });
    const env = { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog };

    try {
      const base = await prepareArtifact({
        packageRoot: baseRoot,
        outputDirectory: baseOutput,
        env,
      });
      const dependent = await prepareArtifact({
        packageRoot: dependentRoot,
        outputDirectory: dependentOutput,
        env,
      });
      assert.equal(base.kind, "prepared");
      assert.equal(dependent.kind, "prepared");
      if (base.kind !== "prepared" || dependent.kind !== "prepared") {
        throw new Error("依赖批次制品准备失败");
      }

      const accepted = await acceptArtifact({
        packageRoot: baseRoot,
        artifactPath: base.artifactPath,
        additionalArtifacts: [
          { packageRoot: dependentRoot, artifactPath: dependent.artifactPath },
        ],
        env,
      });
      assert.equal(accepted.kind, "accepted");
      if (accepted.kind !== "accepted") {
        throw new Error("依赖批次制品消费验收失败");
      }
      assert.equal(accepted.installation.command, "npm");
      assert.ok(accepted.installation.arguments.includes(base.artifactPath));
      assert.ok(
        accepted.installation.arguments.includes(dependent.artifactPath),
      );
      assert.deepEqual(
        accepted.artifacts.map((artifact) => artifact.packageName),
        ["@example/batch-base", "@example/batch-dependent"],
      );
      assert.deepEqual(
        accepted.artifacts.map((artifact) => artifact.sha512),
        [base.sha512, dependent.sha512],
      );
      assert.deepEqual(
        await Promise.all([
          sha512(base.artifactPath),
          sha512(dependent.artifactPath),
        ]),
        [base.sha512, dependent.sha512],
      );
      for (const [packageRoot, artifactDirectory] of [
        [baseRoot, baseOutput],
        [dependentRoot, dependentOutput],
      ] as const) {
        const reread = await readAcceptedArtifact({
          packageRoot,
          artifactDirectory,
        });
        assert.equal(reread.kind, "prepared");
        if (reread.kind !== "prepared") {
          throw new Error("整批回执无法作为已验收原件读取");
        }
        assert.equal(reread.receipt.acceptance?.consumption, "passed");
      }
      const events = (await readFile(eventLog, "utf8")).trim().split("\n");
      assert.deepEqual(
        events.toSorted(),
        [
          "base:prepack",
          "dependent:prepack",
          "base:postinstall",
          "dependent:postinstall",
          "base:consume",
          "dependent:consume",
        ].toSorted(),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("任一目标消费失败时不写入整批回执", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-failure-"),
    );
    const baseRoot = path.join(workspace, "base");
    const dependentRoot = path.join(workspace, "dependent");
    const baseOutput = path.join(workspace, "artifacts", "base");
    const dependentOutput = path.join(workspace, "artifacts", "dependent");
    const eventLog = path.join(workspace, "lifecycle.log");
    await mkdir(baseRoot, { recursive: true });
    await mkdir(dependentRoot, { recursive: true });
    await makeBatchPackage(baseRoot, {
      name: "@example/failure-base",
      value: "base",
    });
    await makeBatchPackage(dependentRoot, {
      name: "@example/failure-dependent",
      value: "dependent",
      dependencies: { "@example/failure-base": "1.0.0" },
      consumerExpectations: { "@example/failure-base": "base" },
    });

    try {
      const base = await prepareArtifact({
        packageRoot: baseRoot,
        outputDirectory: baseOutput,
      });
      const dependent = await prepareArtifact({
        packageRoot: dependentRoot,
        outputDirectory: dependentOutput,
      });
      assert.equal(base.kind, "prepared");
      assert.equal(dependent.kind, "prepared");
      if (base.kind !== "prepared" || dependent.kind !== "prepared") {
        throw new Error("依赖批次制品准备失败");
      }
      const manifestPath = path.join(dependentRoot, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["publication:consume"] = 'node -e "process.exit(37)"';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        acceptArtifact({
          packageRoot: baseRoot,
          artifactPath: base.artifactPath,
          additionalArtifacts: [
            {
              packageRoot: dependentRoot,
              artifactPath: dependent.artifactPath,
            },
          ],
          env: { ...process.env, NPM_PUBLICATION_EVENT_LOG: eventLog },
        }),
        /退出状态 37/u,
      );
      assert.deepEqual(
        await Promise.all([
          sha512(base.artifactPath),
          sha512(dependent.artifactPath),
        ]),
        [base.sha512, dependent.sha512],
      );
      for (const output of [baseOutput, dependentOutput]) {
        const receipt = JSON.parse(
          await readFile(
            path.join(output, "publication-preparation.json"),
            "utf8",
          ),
        ) as { readonly acceptance?: unknown };
        assert.equal(receipt.acceptance, undefined);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("未发布且未选依赖安装失败时提示显式补选", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-unselected-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    await mkdir(packageRoot, { recursive: true });
    await makeBatchPackage(packageRoot, {
      name: "@example/unselected-consumer",
      value: "consumer",
      dependencies: { "@example/not-selected": "1.0.0" },
    });

    try {
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") {
        throw new Error("未选依赖制品准备失败");
      }

      await assert.rejects(
        acceptArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
          env: { npm_config_offline: "true" },
        }),
        /@example\/unselected-consumer.*@example\/not-selected@1\.0\.0.*ENOTCACHED/isu,
      );
      assert.equal(await sha512(prepared.artifactPath), prepared.sha512);
      const receipt = JSON.parse(
        await readFile(
          path.join(outputDirectory, "publication-preparation.json"),
          "utf8",
        ),
      ) as { readonly acceptance?: unknown };
      assert.equal(receipt.acceptance, undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("正常安装生命周期失败时保留原错误且不要求补选", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-batch-postinstall-failure-"),
    );
    const packageRoot = path.join(workspace, "package");
    const outputDirectory = path.join(workspace, "artifacts");
    await mkdir(packageRoot, { recursive: true });
    await makeBatchPackage(packageRoot, {
      name: "@example/postinstall-failure",
      value: "postinstall-failure",
      postinstallCommand: 'node -e "process.exit(37)"',
    });

    try {
      const prepared = await prepareArtifact({
        packageRoot,
        outputDirectory,
      });
      assert.equal(prepared.kind, "prepared");
      if (prepared.kind !== "prepared") {
        throw new Error("postinstall 失败用例制品准备失败");
      }

      await assert.rejects(
        acceptArtifact({
          packageRoot,
          artifactPath: prepared.artifactPath,
          env: { npm_config_offline: "true" },
        }),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          assert.match(message, /postinstall|退出状态/u);
          assert.doesNotMatch(message, /补选|显式加入|ENOTCACHED|ETARGET/u);
          return true;
        },
      );
      assert.equal(await sha512(prepared.artifactPath), prepared.sha512);
      const receipt = JSON.parse(
        await readFile(
          path.join(outputDirectory, "publication-preparation.json"),
          "utf8",
        ),
      ) as { readonly acceptance?: unknown };
      assert.equal(receipt.acceptance, undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("通过正式入口按原生筛选生产并验收多包同一批原件", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-formal-batch-"),
    );
    const packagesRoot = path.join(workspace, "packages");
    const artifactRoot = path.join(workspace, "artifacts");
    const eventLog = path.join(workspace, "lifecycle.log");
    const externalWriteLog = path.join(workspace, "external-writes.log");
    const baseRoot = path.join(packagesRoot, "base");
    const dependentRoot = path.join(packagesRoot, "dependent");
    const unselectedRoot = path.join(packagesRoot, "unselected");
    const prepareCommand =
      "node --conditions=source --experimental-strip-types --import @ykdz/reference-npm-publication/prepare";

    await mkdir(baseRoot, { recursive: true });
    await mkdir(dependentRoot, { recursive: true });
    await mkdir(unselectedRoot, { recursive: true });
    await writeFile(
      path.join(workspace, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\nverifyDepsBeforeRun: false\n",
    );
    await writeFile(
      path.join(workspace, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/formal-workspace",
          private: true,
          packageManager: "pnpm@12.9.1",
          devDependencies: { turbo: "2.11.10" },
          scripts: {
            "publication:artifact":
              "node --conditions=source --experimental-strip-types --import @ykdz/reference-npm-publication/artifact --eval '' --",
          },
        },
        null,
        2,
      )}\n`,
    );
    await makeTurboWorkspace(workspace, { buildGraph: true });
    await makeBatchPackage(baseRoot, {
      name: "@example/batch-base",
      version: "2.4.0",
      value: "base",
      prepareCommand,
      buildCommand: "node lifecycle.mjs build",
    });
    await makeBatchPackage(dependentRoot, {
      name: "@example/batch-dependent",
      version: "7.1.0",
      value: "dependent",
      dependencies: { "@example/batch-base": "workspace:^" },
      consumerExpectations: { "@example/batch-base": "base" },
      prepareCommand,
      buildCommand: "node lifecycle.mjs build",
    });
    await makeBatchPackage(unselectedRoot, {
      name: "@example/not-selected-package",
      value: "unselected",
      prepareCommand: 'node -e "process.exit(79)"',
    });
    await installPnpmFixtureDependencies(workspace);
    await linkPublicationOwner(workspace);
    await writeFile(externalWriteLog, "");
    const commandShims = await makePublicationCommandShims({
      root: workspace,
      logPath: externalWriteLog,
    });

    try {
      const result = await execFileAsync(
        "pnpm",
        [
          "run",
          "publication:artifact",
          "--",
          "--filter",
          "@example/batch-dependent",
          "--filter",
          "@example/batch-base",
        ],
        {
          cwd: workspace,
          env: {
            ...commandShims.env,
            NPM_PUBLICATION_EVENT_LOG: eventLog,
            npm_config_offline: "true",
            PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: artifactRoot,
          },
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const reportLine = result.stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith("NPM_PUBLICATION_ACCEPTED_JSON:"));
      assert.ok(reportLine, result.stdout);
      const report = JSON.parse(
        reportLine.slice("NPM_PUBLICATION_ACCEPTED_JSON:".length),
      ) as {
        readonly artifacts: readonly {
          readonly packageRoot: string;
          readonly packageName: string;
          readonly artifactVersion: string;
          readonly artifactPath: string;
          readonly receiptPath: string;
          readonly sha512: string;
        }[];
      };
      assert.deepEqual(
        report.artifacts.map((artifact) => artifact.packageName).toSorted(),
        ["@example/batch-base", "@example/batch-dependent"].toSorted(),
      );
      assert.deepEqual(
        report.artifacts.map((artifact) => artifact.artifactVersion).toSorted(),
        ["2.4.0", "7.1.0"].toSorted(),
      );
      assert.deepEqual(
        await Promise.all(
          report.artifacts.map((artifact) => sha512(artifact.artifactPath)),
        ),
        report.artifacts.map((artifact) => artifact.sha512),
      );
      const acceptedList = JSON.parse(
        await readFile(
          path.join(artifactRoot, "publication-accepted-artifacts.json"),
          "utf8",
        ),
      ) as {
        readonly artifacts: readonly {
          readonly packageRoot: string;
          readonly packageName: string;
          readonly artifactVersion: string;
          readonly artifactPath: string;
          readonly receiptPath: string;
          readonly sha512: string;
        }[];
      };
      assert.deepEqual(
        acceptedList.artifacts.map((artifact) => artifact.packageName),
        report.artifacts.map((artifact) => artifact.packageName),
      );
      for (const acceptedArtifact of acceptedList.artifacts) {
        const reportArtifact = report.artifacts.find(
          (artifact) => artifact.packageName === acceptedArtifact.packageName,
        );
        assert.ok(reportArtifact);
        assert.equal(
          path.resolve(workspace, acceptedArtifact.packageRoot),
          reportArtifact.packageRoot,
        );
        assert.equal(
          path.resolve(artifactRoot, acceptedArtifact.artifactPath),
          reportArtifact.artifactPath,
        );
        assert.equal(
          path.resolve(artifactRoot, acceptedArtifact.receiptPath),
          reportArtifact.receiptPath,
        );
        assert.equal(acceptedArtifact.sha512, reportArtifact.sha512);
      }
      const events = (await readFile(eventLog, "utf8")).trim().split("\n");
      assert.deepEqual(
        events.toSorted(),
        [
          "base:build",
          "base:prepack",
          "dependent:build",
          "dependent:prepack",
          "base:postinstall",
          "dependent:postinstall",
          "base:consume",
          "dependent:consume",
        ].toSorted(),
        `${result.stdout}\n${JSON.stringify(events)}`,
      );
      assert.ok(
        events.filter((event) => event === "base:build").length === 1,
        "一次原生 Turbo 图应只构建所选依赖包一次",
      );
      assert.ok(
        events.filter((event) => event === "dependent:build").length === 1,
        "一次原生 Turbo 图应只构建所选目标一次",
      );
      assert.ok(
        events.indexOf("base:prepack") < events.indexOf("dependent:prepack"),
        "pnpm 原生 --sort 应先准备所选依赖包",
      );
      assert.ok(
        !events.some((event) => event.startsWith("unselected:")),
        "pnpm 原生 filter 不应自动扩大到未选目标",
      );
      const externalCommands = (await readFile(externalWriteLog, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly command: string;
              readonly arguments: readonly string[];
              readonly write: boolean;
            },
        );
      assert.ok(externalCommands.length > 0);
      assert.ok(externalCommands.every((command) => !command.write));
      assert.equal(
        externalCommands.filter(
          (command) =>
            command.command === "pnpm" && command.arguments[0] === "pack",
        ).length,
        2,
      );
      assert.equal(
        externalCommands.filter(
          (command) =>
            command.command === "npm" && command.arguments[0] === "install",
        ).length,
        1,
      );
      assert.equal(
        externalCommands.filter(
          (command) =>
            command.command === "npm" &&
            command.arguments[0] === "run" &&
            command.arguments.at(-1) === "publication:consume",
        ).length,
        2,
      );
      for (const artifact of report.artifacts) {
        const accepted = await readAcceptedArtifact({
          packageRoot: artifact.packageRoot,
          artifactPath: artifact.artifactPath,
        });
        assert.equal(accepted.kind, "prepared");
        if (accepted.kind !== "prepared") {
          throw new Error("正式批次回执没有保留 accepted 事实");
        }
        assert.equal(accepted.sha512, artifact.sha512);
        assert.equal(accepted.receiptPath, artifact.receiptPath);
      }

      const singleArtifactRoot = path.join(workspace, "single-artifacts");
      const singleEventLog = path.join(workspace, "single-lifecycle.log");
      const singleExternalWriteLog = path.join(
        workspace,
        "single-external-writes.log",
      );
      await writeFile(singleExternalWriteLog, "");
      const singleResult = await execFileAsync(
        "pnpm",
        [
          "run",
          "publication:artifact",
          "--",
          "--filter",
          "@example/batch-base",
        ],
        {
          cwd: workspace,
          env: {
            ...commandShims.env,
            NPM_PUBLICATION_EXTERNAL_WRITE_LOG: singleExternalWriteLog,
            NPM_PUBLICATION_EVENT_LOG: singleEventLog,
            npm_config_offline: "true",
            PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: singleArtifactRoot,
          },
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const singleReportLine = singleResult.stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith("NPM_PUBLICATION_ACCEPTED_JSON:"));
      assert.ok(singleReportLine, singleResult.stdout);
      const singleReport = JSON.parse(
        singleReportLine.slice("NPM_PUBLICATION_ACCEPTED_JSON:".length),
      ) as {
        readonly artifacts: readonly {
          readonly packageName: string;
          readonly artifactPath: string;
          readonly receiptPath: string;
          readonly sha512: string;
        }[];
      };
      assert.equal(singleReport.artifacts.length, 1);
      assert.equal(
        singleReport.artifacts[0]?.packageName,
        "@example/batch-base",
      );
      assert.equal(
        await sha512(singleReport.artifacts[0]!.artifactPath),
        singleReport.artifacts[0]!.sha512,
      );
      const singleAccepted = await readAcceptedArtifact({
        packageRoot: baseRoot,
        artifactPath: singleReport.artifacts[0]!.artifactPath,
      });
      assert.equal(singleAccepted.kind, "prepared");
      if (singleAccepted.kind !== "prepared") {
        throw new Error("单包正式入口没有写入验收事实");
      }
      assert.equal(
        singleAccepted.receiptPath,
        singleReport.artifacts[0]!.receiptPath,
      );
      const singleExternalCommands = (
        await readFile(singleExternalWriteLog, "utf8")
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly command: string;
              readonly arguments: readonly string[];
              readonly write: boolean;
            },
        );
      assert.ok(singleExternalCommands.every((command) => !command.write));
      assert.equal(
        singleExternalCommands.filter(
          (command) =>
            command.command === "pnpm" && command.arguments[0] === "pack",
        ).length,
        1,
      );
      assert.equal(
        singleExternalCommands.filter(
          (command) =>
            command.command === "npm" && command.arguments[0] === "install",
        ).length,
        1,
      );
      assert.deepEqual(
        (await readFile(singleEventLog, "utf8")).trim().split("\n"),
        ["base:build", "base:prepack", "base:postinstall", "base:consume"],
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("正式批入口为未选且不可安装的依赖报告补选并拒绝验收", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "npm-publication-formal-batch-missing-dependency-"),
    );
    const packagesRoot = path.join(workspace, "packages");
    const artifactRoot = path.join(workspace, "artifacts");
    const eventLog = path.join(workspace, "lifecycle.log");
    const externalWriteLog = path.join(workspace, "external-writes.log");
    const consumerRoot = path.join(packagesRoot, "consumer");
    const unselectedRoot = path.join(packagesRoot, "unselected");
    const prepareCommand =
      "node --conditions=source --experimental-strip-types --import @ykdz/reference-npm-publication/prepare";

    await mkdir(consumerRoot, { recursive: true });
    await mkdir(unselectedRoot, { recursive: true });
    await writeFile(
      path.join(workspace, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\nverifyDepsBeforeRun: false\n",
    );
    await writeFile(
      path.join(workspace, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/missing-dependency-workspace",
          private: true,
          packageManager: "pnpm@12.9.1",
          devDependencies: { turbo: "2.11.10" },
          scripts: {
            "publication:artifact":
              "node --conditions=source --experimental-strip-types --import @ykdz/reference-npm-publication/artifact --eval '' --",
          },
        },
        null,
        2,
      )}\n`,
    );
    await makeTurboWorkspace(workspace);
    await makeBatchPackage(consumerRoot, {
      name: "@example/unselected-consumer",
      version: "5.6.7",
      value: "consumer",
      dependencies: { "@example/not-selected": "workspace:^3.2.0" },
      prepareCommand,
    });
    await makeBatchPackage(unselectedRoot, {
      name: "@example/not-selected",
      version: "3.2.0",
      value: "unselected",
      prepareCommand: 'node -e "process.exit(79)"',
    });
    await installPnpmFixtureDependencies(workspace);
    await linkPublicationOwner(workspace);
    await writeFile(externalWriteLog, "");
    const commandShims = await makePublicationCommandShims({
      root: workspace,
      logPath: externalWriteLog,
    });

    try {
      let failure:
        | (Error & {
            readonly code?: number;
            readonly stdout?: string;
            readonly stderr?: string;
          })
        | undefined;
      try {
        await execFileAsync(
          "pnpm",
          [
            "run",
            "publication:artifact",
            "--",
            "--filter",
            "@example/unselected-consumer",
          ],
          {
            cwd: workspace,
            env: {
              ...commandShims.env,
              NPM_PUBLICATION_EVENT_LOG: eventLog,
              npm_config_offline: "true",
              PUBLICATION_ARTIFACT_OUTPUT_DIRECTORY: artifactRoot,
            },
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      assert.ok(failure, "未选且不可安装的依赖应阻断正式批验收");
      assert.equal(failure.code, 1);
      const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      assert.match(
        output,
        /@example\/unselected-consumer.*@example\/not-selected@\^3\.2\.0.*ENOTCACHED/isu,
      );
      assert.doesNotMatch(output, /NPM_PUBLICATION_ACCEPTED_JSON:/u);
      assert.deepEqual(
        (await readFile(eventLog, "utf8")).trim().split("\n"),
        ["consumer:prepack"],
        failure.stdout,
      );
      const receipt = JSON.parse(
        await readFile(
          path.join(artifactRoot, "publication-preparation.json"),
          "utf8",
        ),
      ) as {
        readonly artifact: { readonly path: string; readonly sha512: string };
        readonly acceptance?: unknown;
      };
      assert.equal(receipt.acceptance, undefined);
      assert.equal(
        await sha512(path.join(artifactRoot, receipt.artifact.path)),
        receipt.artifact.sha512,
      );
      const externalCommands = (await readFile(externalWriteLog, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly command: string;
              readonly arguments: readonly string[];
              readonly write: boolean;
            },
        );
      assert.ok(externalCommands.length > 0);
      assert.ok(externalCommands.every((command) => !command.write));
      assert.equal(
        externalCommands.filter(
          (command) =>
            command.command === "pnpm" && command.arguments[0] === "pack",
        ).length,
        1,
      );
      assert.equal(
        externalCommands.filter(
          (command) =>
            command.command === "npm" && command.arguments[0] === "install",
        ).length,
        1,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

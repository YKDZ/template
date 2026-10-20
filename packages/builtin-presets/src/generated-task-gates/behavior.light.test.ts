import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { renderNewProject } from "@ykdz/template-core/renderer";
import { releaseToolchainSnapshot } from "@ykdz/template-workspace/release-toolchain-snapshot";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "../foundation.ts";

const runtimeToolchain = {
  nodeLtsMajor: releaseToolchainSnapshot.nodeVersion.slice(
    0,
    releaseToolchainSnapshot.nodeVersion.indexOf("."),
  ),
  packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  nodeVersion: releaseToolchainSnapshot.nodeVersion,
};
async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`未在期限内生成进程探针文件：${filePath}`);
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 进程组已经退出。
  }
}

async function assertProcessExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`进程 ${pid} 未退出`);
}

void describe("生成任务公共入口", () => {
  void it("为每个初始化预设投影四个公共入口", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-gates-"));

    try {
      for (const definition of builtInPresetRegistry.all()) {
        const targetRoot = path.join(workspace, definition.metadata.name);
        const context = createGenerationContext({
          targetDir: targetRoot,
          defaultPackageScope: "generated",
          toolchain: runtimeToolchain,
        });
        const plan = planGeneratedRepositoryInitialization({
          definition,
          context,
        });

        await renderNewProject({
          targetRoot,
          operations: [...plan.operations],
        });

        const rootManifest = JSON.parse(
          await readFile(path.join(targetRoot, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const turbo = JSON.parse(
          await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
        ) as {
          readonly tasks: Readonly<
            Record<string, { readonly tags?: readonly string[] }>
          >;
        };

        assert.deepStrictEqual(
          {
            check: rootManifest.scripts.check,
            "check:heavy": rootManifest.scripts["check:heavy"],
            "check:full": rootManifest.scripts["check:full"],
            fix: rootManifest.scripts.fix,
          },
          {
            check: "node --conditions=source scripts/task-gates.ts check",
            "check:heavy":
              "node --conditions=source scripts/task-gates.ts check:heavy",
            "check:full":
              "node --conditions=source scripts/task-gates.ts check:full",
            fix: "node --conditions=source scripts/task-gates.ts fix",
          },
        );

        for (const gate of ["check", "check:heavy", "check:full"]) {
          assert.deepStrictEqual(turbo.tasks[`//#${gate}`]?.tags, [
            "quality:entry",
          ]);
        }
        assert.deepStrictEqual(turbo.tasks["//#fix"]?.tags, ["work:repair"]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  for (const runnerKind of ["boundaries", "cargo"] as const) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      void it(
        `forwards parent ${signal} through the generated ${runnerKind} process tree`,
        { skip: process.platform === "win32", timeout: 15_000 },
        async () => {
          const workspace = await mkdtemp(
            path.join(tmpdir(), `template-${runnerKind}-signal-`),
          );
          const targetRoot = path.join(workspace, "generated-repository");
          const definition = builtInPresetRegistry.require(
            runnerKind === "boundaries" ? "ts-lib" : "rust-bin",
          );
          const context = createGenerationContext({
            targetDir: targetRoot,
            defaultPackageScope: "generated",
            toolchain: runtimeToolchain,
          });
          const initialization = planGeneratedRepositoryInitialization({
            definition,
            context,
          });
          let runnerPid: number | undefined;
          let toolPid: number | undefined;
          try {
            await renderNewProject({
              targetRoot,
              operations: [...initialization.operations],
            });

            const runnerCwd =
              runnerKind === "boundaries"
                ? targetRoot
                : path.join(targetRoot, "packages/app");
            const runnerScript =
              runnerKind === "boundaries"
                ? path.join(targetRoot, "scripts/run-turbo-boundaries.ts")
                : path.join(runnerCwd, "scripts/run-rust-tests.ts");
            const commandName = runnerKind === "boundaries" ? "pnpm" : "cargo";
            const binDirectory = path.join(workspace, "fake-bin");
            const fakeTool = path.join(workspace, "fake-tool.cjs");
            const processRecord = path.join(workspace, "processes.txt");
            const childReady = path.join(workspace, "child-ready.txt");
            const childSignal = path.join(workspace, "child-signal.txt");
            await mkdir(binDirectory, { recursive: true });
            await writeFile(
              path.join(binDirectory, commandName),
              '#!/bin/sh\nexec node "$FAKE_TOOL_SCRIPT"\n',
              { mode: 0o755 },
            );
            await chmod(path.join(binDirectory, commandName), 0o755);
            await writeFile(
              fakeTool,
              [
                'const { spawn } = require("node:child_process");',
                'const { existsSync, writeFileSync } = require("node:fs");',
                "const childSource = [",
                '  "const { writeFileSync } = require(\\\"node:fs\\\");",',
                '  "for (const signal of [\\\"SIGINT\\\", \\\"SIGTERM\\\"]) process.on(signal, () => { writeFileSync(process.env.CHILD_SIGNAL_FILE, signal); process.exit(0); });",',
                '  "writeFileSync(process.env.CHILD_READY_FILE, \\\"ready\\\");",',
                '  "setInterval(() => {}, 1000);",',
                '].join("\\n");',
                'const child = spawn(process.execPath, ["-e", childSource], { stdio: "ignore" });',
                "const waitForReady = async () => {",
                "  while (!existsSync(process.env.CHILD_READY_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));",
                "  writeFileSync(process.env.CHILD_PID_FILE, `${process.pid}\\n${child.pid}`);",
                "};",
                'const finishAfterChild = () => child.once("exit", () => process.exit(0));',
                'process.on("SIGINT", finishAfterChild);',
                'process.on("SIGTERM", finishAfterChild);',
                "void waitForReady();",
                "setInterval(() => {}, 1000);",
                "",
              ].join("\n"),
            );

            const environment = {
              ...process.env,
              CHILD_PID_FILE: processRecord,
              CHILD_READY_FILE: childReady,
              CHILD_SIGNAL_FILE: childSignal,
              FAKE_TOOL_SCRIPT: fakeTool,
              PATH: [
                binDirectory,
                path.dirname(process.execPath),
                process.env.PATH,
              ]
                .filter((entry) => entry !== undefined)
                .join(path.delimiter),
            };
            const runner = spawn(
              process.execPath,
              ["--conditions=source", runnerScript],
              {
                cwd: runnerCwd,
                detached: true,
                env: environment,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            runnerPid = runner.pid;
            let stdout = "";
            let stderr = "";
            assert.ok(runner.stdout !== null && runner.stderr !== null);
            runner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
              stdout += chunk;
            });
            runner.stderr.setEncoding("utf8").on("data", (chunk: string) => {
              stderr += chunk;
            });
            const closeResult = new Promise<{
              readonly code: number | null;
              readonly signal: NodeJS.Signals | null;
            }>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("运行器未在期限内退出")),
                10_000,
              );
              runner.once("error", (error) => {
                clearTimeout(timeout);
                reject(error);
              });
              runner.once("close", (code, childSignalCode) => {
                clearTimeout(timeout);
                resolve({ code, signal: childSignalCode });
              });
            });

            const pids = (await waitForFile(processRecord))
              .trim()
              .split("\n")
              .map(Number);
            const [directToolPid, childPid] = pids;
            assert.ok(directToolPid !== undefined && childPid !== undefined);
            toolPid = directToolPid;
            assert.strictEqual(runner.kill(signal), true);
            const result = await closeResult;
            assert.deepStrictEqual(
              result,
              {
                code: signal === "SIGINT" ? 130 : 143,
                signal: null,
              },
              `${stdout}\n${stderr}`,
            );
            assert.strictEqual(await readFile(childSignal, "utf8"), signal);
            await assertProcessExited(directToolPid);
            await assertProcessExited(childPid);
          } finally {
            killProcessGroup(toolPid);
            killProcessGroup(runnerPid);
            await rm(workspace, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

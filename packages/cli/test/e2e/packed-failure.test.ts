import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

// 从原 packed-publication 验收迁回 CLI 所属包，复用正式旅程执行器。
void test("真实制品命令成功后，失败旅程保留输出、原始原因和生成现场", async () => {
  const installedBin = process.env.TEMPLATE_CLI_PACKED_BIN;
  assert.ok(installedBin, "packed 失败探针需要已安装制品的 CLI 入口");
  const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(e2eRoot, "../..");
  const workspace = await mkdtemp(
    path.join(tmpdir(), "template-packed-failure-probe-"),
  );
  const fixture = path.join(workspace, "cli");
  const fixturesE2e = path.join(fixture, "test/e2e");
  const journeys = path.join(fixturesE2e, "journeys");
  let passed = false;
  try {
    await mkdir(journeys, { recursive: true });
    await symlink(
      path.join(packageRoot, "node_modules"),
      path.join(fixture, "node_modules"),
      "dir",
    );
    await cp(
      path.join(packageRoot, "package.json"),
      path.join(fixture, "package.json"),
    );
    for (const file of ["run-journeys.ts", "journey.ts"]) {
      await cp(path.join(e2eRoot, file), path.join(fixturesE2e, file));
    }
    const shim = path.join(workspace, "fail-after-command.cjs");
    await writeFile(
      shim,
      [
        'const { spawn } = require("node:child_process");',
        "const [executable, ...args] = process.argv.slice(2);",
        'const child = spawn(executable, args, { shell: process.platform === "win32", stdio: "inherit" });',
        'child.once("error", (error) => { console.error(error); process.exitCode = 1; });',
        'child.once("exit", (code) => { process.exitCode = code === 0 ? 79 : (code ?? 1); });',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(journeys, "packed-failure.journey.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { templateContent } from "@ykdz/template-content";',
        'const preset = templateContent.find((candidate) => "kind" in candidate && candidate.operations.includes("init") && Object.keys(candidate.nodes).length === 1);',
        'if (preset === undefined) throw new Error("没有可初始化的单节点预设");',
        "export default {",
        '  name: "packed-failure-probe",',
        '  modes: ["packed"],',
        "  async setup() {},",
        "  commands() { return [{",
        '    name: "生成项目后注入退出错误",',
        "    executable: process.execPath,",
        '    args: [process.env.TEMPLATE_CLI_PACKED_FAILURE_SHIM, process.env.TEMPLATE_CLI_PACKED_BIN, "init", "project", "--preset", preset.metadata.alias, "--scope", "acme", "--no-todo"],',
        "  }]; },",
        "  async assertions({ results }) {",
        "    assert.strictEqual(results[0]?.exitCode, 79);",
        '    assert.match(results[0]?.stdout ?? "", /"variant":"initialized"/u);',
        '    throw new Error("注入的 packed 旅程断言失败", { cause: new Error("原始 packed 旅程错误") });',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.TEMPLATE_CLI_JOURNEY_WORKER_PID_FILE;
    const result = await execa(
      process.execPath,
      [
        "--conditions=source",
        "--test",
        "--test-reporter=tap",
        path.join(fixturesE2e, "run-journeys.ts"),
      ],
      {
        cwd: fixture,
        env: {
          ...environment,
          TEMPLATE_CLI_JOURNEY_MODE: "packed",
          TEMPLATE_CLI_PACKED_BIN: installedBin,
          TEMPLATE_CLI_PACKED_FAILURE_SHIM: shim,
          TEMPLATE_CLI_JOURNEY_DIAGNOSTICS_DIR: path.join(
            workspace,
            "diagnostics",
          ),
        },
        extendEnv: false,
        reject: false,
        timeout: 120_000,
        killDescendants: true,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.exitCode, 0, output);
    assert.match(output, /# fail 1/u);
    const diagnostic = output.match(/CLI_JOURNEY_DIAGNOSTICS=(.+)/u)?.[1];
    assert.ok(diagnostic, output);
    const report = JSON.parse(
      await readFile(path.join(diagnostic, "journey-report.json"), "utf8"),
    ) as {
      readonly journey: string;
      readonly workspace: string;
      readonly error: {
        readonly message: string;
        readonly cause?: { readonly cause?: { readonly message: string } };
      };
      readonly results: readonly {
        readonly exitCode: number;
        readonly stdout: string;
      }[];
    };
    assert.equal(report.journey, "packed-failure-probe");
    assert.equal(report.results[0]?.exitCode, 79);
    assert.equal(report.error.cause?.cause?.message, "原始 packed 旅程错误");
    assert.match(report.error.message, /"variant":"initialized"/u);
    assert.match(report.results[0]?.stdout ?? "", /"variant":"initialized"/u);
    assert.ok(
      JSON.parse(
        await readFile(
          path.join(report.workspace, "project/package.json"),
          "utf8",
        ),
      ),
    );
    passed = true;
  } finally {
    if (passed) await rm(workspace, { recursive: true, force: true });
    else
      process.stderr.write(`PACKED_FAILURE_PROBE_DIAGNOSTICS=${workspace}\n`);
  }
});

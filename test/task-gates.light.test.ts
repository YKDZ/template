import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const taskGatesPath = fileURLToPath(
  import.meta.resolve("@ykdz/template-builtin-presets/task-gates"),
);
const turboExecutablePath = fileURLToPath(import.meta.resolve("turbo"));
const gateEntries = [
  {
    label: "模板直接入口",
    scriptPath: taskGatesPath,
    command: "node --conditions=source scripts/task-gates.ts",
  },
  {
    label: "源码包装入口",
    scriptPath: fileURLToPath(
      new URL("../scripts/run-task-gate.ts", import.meta.url),
    ),
    command:
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts",
  },
];

function taskScript(gate: string): string {
  return `node record.cjs ${gate}`;
}

async function readRuns(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "runs.log"), "utf8"))
      .trim()
      .split("\n")
      .filter((run) => run.length > 0);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function createWorkspace(
  options: {
    readonly entryCommand?: string;
    readonly invalidCheckCustom?: boolean;
    readonly commandOnlyTask?: boolean;
    readonly failRootLight?: boolean;
    readonly waitRootLight?: boolean;
    readonly failRootHeavy?: boolean;
    readonly withConditionalHeavyTask?: boolean;
    readonly reportConditionalTask?: boolean;
  } = {},
): Promise<string> {
  const entryCommand =
    options.entryCommand ?? "node --conditions=source scripts/task-gates.ts";
  const root = await mkdtemp(path.join(os.tmpdir(), "template-task-gates-"));
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts", "task-gates.ts"),
    await readFile(taskGatesPath),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "task-gates-fixture",
        private: true,
        type: "module",
        packageManager: "pnpm@12.9.1",
        scripts: {
          check: `${entryCommand} check`,
          "check:heavy": `${entryCommand} check:heavy`,
          "check:full": `${entryCommand} check:full`,
          "format:check": taskScript(
            options.failRootLight === true
              ? "root-light-failure"
              : options.waitRootLight === true
                ? "root-light-wait"
                : "root-light",
          ),
          typecheck: taskScript("root-typecheck"),
          build: taskScript("root-build"),
          test: taskScript(
            options.failRootHeavy === true
              ? "root-heavy-failure"
              : "root-heavy",
          ),
          "verify:generated": taskScript("root-custom-light"),
          fix: `${entryCommand} fix`,
          dev: taskScript("root-dev"),
          publish: taskScript("root-release"),
          ...(options.invalidCheckCustom === true
            ? { "check:custom": taskScript("root-check-custom") }
            : {}),
        },
        devDependencies: { turbo: "2.11.7" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    'packages: ["packages/*"]\nverifyDepsBeforeRun: false\n',
  );
  await writeFile(
    path.join(root, "packages", "app", "package.json"),
    JSON.stringify(
      {
        name: "@task-gates/app",
        private: true,
        scripts: {
          build: "node ../../record.cjs package-build",
          "format:check": "node ../../record.cjs package-light",
          test: "node ../../record.cjs package-heavy",
          "verify:generated": "node ../../record.cjs package-custom-light",
          prepare: "node ../../record.cjs package-lifecycle",
          ...(options.withConditionalHeavyTask === true ||
          options.reportConditionalTask === true
            ? {
                "verify:conditional":
                  "node ../../record.cjs package-conditional",
              }
            : {}),
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "packages", "app", "turbo.json"),
    JSON.stringify(
      {
        extends: ["//"],
        tags: ["task-gates-app"],
        tasks: {
          build: { dependsOn: [], tags: ["work:preparation"] },
          "format:check": {
            dependsOn: ["build"],
            tags: ["quality:light"],
          },
          test: {
            dependsOn: [],
            tags: ["quality:heavy"],
            ...(options.withConditionalHeavyTask === true
              ? { with: ["verify:conditional"] }
              : {}),
          },
          "verify:generated": {
            dependsOn: [],
            tags: ["quality:light"],
          },
          prepare: { dependsOn: [], tags: ["work:lifecycle"] },
          ...(options.withConditionalHeavyTask === true ||
          options.reportConditionalTask === true
            ? {
                "verify:conditional": {
                  dependsOn: [],
                  tags: ["quality:conditional"],
                },
              }
            : {}),
          ...(options.commandOnlyTask === true
            ? {
                "verify:command": {
                  command: ["node", "../../record.cjs", "package-command-only"],
                  tags: ["quality:light"],
                },
              }
            : {}),
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "turbo.json"),
    JSON.stringify(
      {
        futureFlags: { experimentalTaskCommand: true },
        tags: ["task-gates-root"],
        tasks: {
          "//#check": { tags: ["quality:entry"] },
          "//#check:heavy": { tags: ["quality:entry"] },
          "//#check:full": { tags: ["quality:entry"] },
          "//#format:check": { tags: ["quality:light"] },
          "//#typecheck": { tags: ["quality:light"] },
          "//#build": { tags: ["work:preparation"] },
          "//#test": { tags: ["quality:heavy"] },
          "//#verify:generated": { tags: ["quality:light"] },
          "//#fix": { tags: ["work:repair"] },
          "//#dev": { tags: ["work:development"] },
          "//#publish": { tags: ["work:release"] },
          ...(options.invalidCheckCustom === true
            ? { "//#check:custom": { tags: ["work:repair"] } }
            : {}),
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "record.cjs"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'fs.appendFileSync(path.join(__dirname, "runs.log"), `${process.argv[2]}\\n`);',
      'if (process.argv[2].endsWith("-failure")) process.exitCode = 1;',
      'if (process.argv[2] === "root-light-wait") {',
      '  for (const signal of ["SIGINT", "SIGTERM"]) {',
      "    process.on(signal, () => {",
      '      fs.appendFileSync(path.join(__dirname, "runs.log"), "root-light-signal-" + signal + "\\n");',
      '      process.exit(signal === "SIGINT" ? 130 : 143);',
      "    });",
      "  }",
      "  setInterval(() => {}, 1000);",
      "}",
      "",
    ].join("\n"),
  );

  try {
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await symlink(
      turboExecutablePath,
      path.join(root, "node_modules", ".bin", "turbo"),
    );
    await writeFile(path.join(root, "runs.log"), "");
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return root;
}

async function addRootTask(
  root: string,
  name: string,
  tags: readonly string[] = [],
): Promise<void> {
  const packagePath = path.join(root, "package.json");
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts: Record<string, string>;
  };
  packageManifest.scripts[name] = taskScript(name);
  await writeFile(packagePath, JSON.stringify(packageManifest, null, 2));

  const turboPath = path.join(root, "turbo.json");
  const turboConfig = JSON.parse(await readFile(turboPath, "utf8")) as {
    tasks: Record<string, unknown>;
  };
  turboConfig.tasks[`//#${name}`] = { tags };
  await writeFile(turboPath, JSON.stringify(turboConfig, null, 2));
}

for (const entry of gateEntries) {
  void it(`${entry.label} 拒绝缺失、未知及多余参数且不执行任务`, async () => {
    const root = await createWorkspace({ entryCommand: entry.command });
    try {
      for (const args of [[], ["unknown"], ["check", "unexpected"]]) {
        const result = await execa(
          "node",
          ["--conditions=source", entry.scriptPath, ...args],
          { cwd: root, reject: false },
        );
        assert.equal(result.exitCode, 2, result.stderr);
        assert.equal(
          result.stderr,
          `用法：${entry.command} <check|check:heavy|check:full|fix>`,
        );
        assert.deepEqual(await readRuns(root), []);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it(`${entry.label} 按公共范围执行并传递任务退出状态`, async () => {
    const root = await createWorkspace({
      entryCommand: entry.command,
      failRootHeavy: true,
    });
    try {
      const light = await execa(
        "node",
        ["--conditions=source", entry.scriptPath, "check"],
        { cwd: root, reject: false },
      );
      assert.equal(light.exitCode, 0, light.stderr);
      assert.ok((await readRuns(root)).includes("root-light"));
      assert.ok(!(await readRuns(root)).includes("root-heavy-failure"));

      const heavy = await execa(
        "node",
        ["--conditions=source", entry.scriptPath, "check:heavy"],
        { cwd: root, reject: false },
      );
      assert.equal(heavy.exitCode, 1, heavy.stderr);
      assert.ok((await readRuns(root)).includes("root-heavy-failure"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("check runs light tasks and their native preparation dependencies", async () => {
  const root = await createWorkspace();
  try {
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    assert.deepEqual(
      new Set(runs),
      new Set([
        "package-build",
        "root-light",
        "root-typecheck",
        "root-custom-light",
        "package-light",
        "package-custom-light",
      ]),
      `${result.stdout}\n${result.stderr}`,
    );
    assert.ok(runs.indexOf("package-build") < runs.indexOf("package-light"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("拒绝无命令节点上的悬空职责标签", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turboConfig = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turboConfig.tasks["//#orphan-root"] = {
      tags: ["work:preparation"],
    };
    await writeFile(turboPath, JSON.stringify(turboConfig, null, 2));

    const appTurboPath = path.join(root, "packages", "app", "turbo.json");
    const appTurboConfig = JSON.parse(await readFile(appTurboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    appTurboConfig.tasks["verify:placeholder"] = {
      tags: ["work:repair"],
    };
    await writeFile(appTurboPath, JSON.stringify(appTurboConfig, null, 2));

    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.match(result.stderr, /#orphan-root/u);
    assert.match(result.stderr, /work:preparation/u);
    assert.match(result.stderr, /@task-gates\/app#verify:placeholder/u);
    assert.match(result.stderr, /work:repair/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("保留无职责中转节点的原生依赖遍历", async () => {
  const root = await createWorkspace();
  try {
    await mkdir(path.join(root, "packages", "provider"), { recursive: true });
    await mkdir(path.join(root, "packages", "upstream"), { recursive: true });

    const appManifestPath = path.join(root, "packages", "app", "package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    appManifest.dependencies = { "@task-gates/provider": "workspace:*" };
    await writeFile(appManifestPath, JSON.stringify(appManifest, null, 2));

    const appTurboPath = path.join(root, "packages", "app", "turbo.json");
    const appTurboConfig = JSON.parse(await readFile(appTurboPath, "utf8")) as {
      tasks: Record<
        string,
        {
          readonly dependsOn?: readonly string[];
          readonly tags?: readonly string[];
        }
      >;
    };
    appTurboConfig.tasks["verify:generated"] = {
      ...appTurboConfig.tasks["verify:generated"],
      dependsOn: ["@task-gates/provider#build"],
    };
    await writeFile(appTurboPath, JSON.stringify(appTurboConfig, null, 2));

    await writeFile(
      path.join(root, "packages", "provider", "package.json"),
      JSON.stringify(
        {
          name: "@task-gates/provider",
          private: true,
          dependencies: { "@task-gates/upstream": "workspace:*" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, "packages", "provider", "turbo.json"),
      JSON.stringify(
        {
          extends: ["//"],
          tags: ["task-gates-provider"],
          tasks: { build: { dependsOn: ["^build"] } },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, "packages", "upstream", "package.json"),
      JSON.stringify(
        {
          name: "@task-gates/upstream",
          private: true,
          scripts: { build: "node ../../record.cjs provider-upstream-build" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, "packages", "upstream", "turbo.json"),
      JSON.stringify(
        {
          extends: ["//"],
          tags: ["task-gates-upstream"],
          tasks: {
            build: { dependsOn: [], tags: ["work:preparation"] },
          },
        },
        null,
        2,
      ),
    );

    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);

    const runs = await readRuns(root);
    assert.ok(runs.includes("provider-upstream-build"), result.stdout);
    assert.ok(
      runs.indexOf("provider-upstream-build") <
        runs.indexOf("package-custom-light"),
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("check:heavy runs heavy verification tasks without light tasks", async () => {
  const root = await createWorkspace();
  try {
    const result = await execa("pnpm", ["run", "check:heavy"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    assert.deepEqual(
      new Set(runs),
      new Set(["root-heavy", "package-heavy"]),
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("check:full runs the light layer before the heavy layer", async () => {
  const root = await createWorkspace();
  try {
    const result = await execa("pnpm", ["run", "check:full"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    const lightTasks = [
      "root-light",
      "root-typecheck",
      "root-custom-light",
      "package-light",
      "package-custom-light",
    ];
    const heavyTasks = ["root-heavy", "package-heavy"];
    assert.ok(
      lightTasks.every((task) => runs.includes(task)),
      runs.join("\n"),
    );
    assert.ok(
      heavyTasks.every((task) => runs.includes(task)),
      runs.join("\n"),
    );
    assert.ok(
      Math.max(...lightTasks.map((task) => runs.indexOf(task))) <
        Math.min(...heavyTasks.map((task) => runs.indexOf(task))),
      runs.join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("does not start the heavy layer after a light task fails", async () => {
  const root = await createWorkspace({ failRootLight: true });
  try {
    const result = await execa("pnpm", ["run", "check:full"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);

    const runs = await readRuns(root);
    assert.ok(runs.includes("root-light-failure"), runs.join("\n"));
    assert.ok(!runs.includes("root-heavy"), runs.join("\n"));
    assert.ok(!runs.includes("package-heavy"), runs.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function verifyFullGateCancellation(
  signal: NodeJS.Signals,
  expectedExitCode: number,
): Promise<void> {
  const root = await createWorkspace({ waitRootLight: true });
  const child = spawn(
    "node",
    ["--experimental-strip-types", taskGatesPath, "check:full"],
    { cwd: root, stdio: "pipe" },
  );
  const childOutput: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) =>
    childOutput.push(chunk.toString()),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    childOutput.push(chunk.toString()),
  );
  try {
    let started = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        const runs = await readFile(path.join(root, "runs.log"), "utf8");
        if (runs.includes("root-light-wait")) {
          started = true;
          break;
        }
      } catch {
        // 工作区生命周期任务尚未创建日志。
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.ok(
      started,
      `the selected light task did not start:\n${childOutput.join("")}`,
    );

    const exited = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveExit) =>
      child.once("close", (code, signal) => resolveExit({ code, signal })),
    );
    assert.equal(child.kill(signal), true);
    let exitTimeout: NodeJS.Timeout | undefined;
    let result: Awaited<typeof exited>;
    try {
      result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          exitTimeout = setTimeout(
            () =>
              reject(
                new Error(`the quality gate did not exit after ${signal}`),
              ),
            30000,
          );
        }),
      ]);
    } finally {
      if (exitTimeout !== undefined) {
        clearTimeout(exitTimeout);
      }
    }
    assert.equal(result.code, expectedExitCode);
    assert.equal(result.signal, null);

    const runs = await readRuns(root);
    assert.ok(
      runs.includes(
        `root-light-signal-${signal === "SIGTERM" ? "SIGINT" : signal}`,
      ),
      runs.join("\n"),
    );
    assert.ok(!runs.includes("root-heavy"), runs.join("\n"));
    assert.ok(!runs.includes("package-heavy"), runs.join("\n"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolveExit) =>
        child.once("close", () => resolveExit()),
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  void it(`forwards ${signal} through the active Turbo process tree before starting the next layer`, async () => {
    await verifyFullGateCancellation(signal, exitCode);
  });
}

void it("continues independent heavy tasks after one task fails", async () => {
  const root = await createWorkspace({ failRootHeavy: true });
  try {
    const result = await execa("pnpm", ["run", "check:heavy"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);

    const runs = await readRuns(root);
    assert.ok(runs.includes("root-heavy-failure"), runs.join("\n"));
    assert.ok(runs.includes("package-heavy"), runs.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects a light task whose native dependency closure includes heavy verification", async () => {
  const root = await createWorkspace();
  try {
    const packageTurboPath = path.join(root, "packages", "app", "turbo.json");
    const packageTurbo = JSON.parse(
      await readFile(packageTurboPath, "utf8"),
    ) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    packageTurbo.tasks["format:check"]!.dependsOn = ["test"];
    await writeFile(packageTurboPath, JSON.stringify(packageTurbo, null, 2));

    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /轻检查不能间接启动重验收/);

    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("preflights with closures and does not run light work when heavy includes a conditional task", async () => {
  const root = await createWorkspace({ withConditionalHeavyTask: true });
  try {
    const result = await execa("pnpm", ["run", "check:full"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /常规验收不能间接启动条件验收/);

    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("reports conditional tasks as unexecuted when ordinary checks exclude them", async () => {
  const root = await createWorkspace({ reportConditionalTask: true });
  try {
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stderr,
      /条件验收未执行：@task-gates\/app#verify:conditional/,
    );

    const runs = await readRuns(root);
    assert.ok(!runs.includes("package-conditional"), runs.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("runs quality-tagged native command tasks without package scripts", async () => {
  const root = await createWorkspace({ commandOnlyTask: true });
  try {
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    assert.ok(
      runs.includes("package-command-only"),
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects custom check-family tasks assigned to a work role before execution", async () => {
  const root = await createWorkspace({ invalidCheckCustom: true });
  try {
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /保留验收任务.*非验收职责 work:repair/);
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects custom test-family tasks assigned to a work role before execution", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "test:custom", ["work:repair"]);
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /\/\/#test:custom 是保留验收任务.*work:repair/);
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const name of ["lint", "typecheck", "format:check"]) {
  void it(`rejects ${name} when assigned to a work role`, async () => {
    const root = await createWorkspace();
    try {
      await addRootTask(root, name, ["work:repair"]);
      const result = await execa("pnpm", ["run", "check"], {
        cwd: root,
        reject: false,
      });

      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, new RegExp(`${name}.*保留验收任务`));
      const runs = await readRuns(root);
      assert.deepEqual(runs, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("拒绝仅新增在根 manifest 中的无职责 script", async () => {
  const root = await createWorkspace();
  try {
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["verify:unclassified"] = taskScript("unclassified");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /\/\/#verify:unclassified 缺少唯一职责标签/);
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects an executable root task with an unknown role", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:unknown", ["quality:unknown"]);
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /\/\/#verify:unknown 使用未知职责标签 quality:unknown/,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects an executable root task with conflicting roles", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:conflicting", [
      "quality:light",
      "work:repair",
    ]);
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /\/\/#verify:conflicting 有多个职责标签/);
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("拒绝清除所属任务职责的包任务", async () => {
  const root = await createWorkspace();
  try {
    const packageTurboPath = path.join(root, "packages", "app", "turbo.json");
    const packageTurbo = JSON.parse(
      await readFile(packageTurboPath, "utf8"),
    ) as { tasks: Record<string, Record<string, unknown>> };
    const generatedTask = packageTurbo.tasks["verify:generated"];
    assert.ok(generatedTask);
    packageTurbo.tasks["verify:generated"] = { ...generatedTask, tags: [] };
    await writeFile(packageTurboPath, JSON.stringify(packageTurbo, null, 2));
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /@task-gates\/app#verify:generated 缺少唯一职责标签/,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("limits quality:entry to the three public root gate tasks", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:entry", ["quality:entry"]);
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /\/\/#verify:entry 不能使用 quality:entry/);
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("fix 按职责发现异名修复任务，并保留必要轻检查与准备", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "rewrite:generated", [
      "work:repair",
      "area:generated",
    ]);
    const turboPath = path.join(root, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    turbo.tasks["//#rewrite:generated"]!.dependsOn = ["typecheck", "build"];
    await writeFile(turboPath, JSON.stringify(turbo));

    const packagePath = path.join(root, "packages", "app", "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["normalize:assets"] =
      "node ../../record.cjs package-repair";
    await writeFile(packagePath, JSON.stringify(manifest));
    const packageTurboPath = path.join(root, "packages", "app", "turbo.json");
    const packageTurbo = JSON.parse(
      await readFile(packageTurboPath, "utf8"),
    ) as {
      tasks: Record<string, unknown>;
    };
    packageTurbo.tasks["normalize:assets"] = {
      tags: ["work:repair"],
      dependsOn: ["build"],
    };
    await writeFile(packageTurboPath, JSON.stringify(packageTurbo));

    const result = await execa("pnpm", ["run", "fix"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const runs = await readRuns(root);
    assert.deepEqual(
      new Set(runs),
      new Set([
        "rewrite:generated",
        "root-typecheck",
        "root-build",
        "package-repair",
        "package-build",
      ]),
    );
    assert.ok(
      runs.indexOf("root-typecheck") < runs.indexOf("rewrite:generated"),
    );
    assert.ok(runs.indexOf("package-build") < runs.indexOf("package-repair"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("fix 拒绝仅新增在 manifest 的无职责 script，包标签不能代替任务职责", async () => {
  const root = await createWorkspace();
  try {
    const packagePath = path.join(root, "packages", "app", "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["unclassified"] = "node ../../record.cjs unclassified";
    await writeFile(packagePath, JSON.stringify(manifest));
    const turboPath = path.join(root, "packages", "app", "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tags: string[];
    };
    turbo.tags.push("quality:light");
    await writeFile(turboPath, JSON.stringify(turbo));

    const result = await execa("pnpm", ["run", "fix"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /@task-gates\/app#unclassified 缺少唯一职责标签/u,
    );
    assert.deepEqual(await readRuns(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("允许任意附加标签和显式按需任务，叶任务仍可直接调用", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "inspect:cache", [
      "work:on-demand",
      "area:local",
      "custom-label",
    ]);
    await addRootTask(root, "verify:custom", [
      "quality:light",
      "area:local",
      "custom-label",
    ]);
    const check = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(check.exitCode, 0, check.stderr);
    const runs = await readRuns(root);
    assert.ok(runs.includes("verify:custom"));
    assert.ok(!runs.includes("inspect:cache"));

    const direct = await execa("pnpm", ["run", "inspect:cache"], {
      cwd: root,
      reject: false,
    });
    assert.equal(direct.exitCode, 0, direct.stderr);
    assert.ok((await readRuns(root)).includes("inspect:cache"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("有职责的无命令聚合节点可以通过原生图承载实际工作", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turbo.tasks["//#verify:aggregate"] = {
      tags: ["quality:light"],
      dependsOn: ["build"],
    };
    await writeFile(turboPath, JSON.stringify(turbo));
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok((await readRuns(root)).includes("root-build"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("无命令聚合节点的职责也必须符合入口闭包", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, { tags?: string[]; dependsOn?: string[] }>;
    };
    turbo.tasks["//#release:aggregate"] = {
      tags: ["work:release"],
      dependsOn: ["build"],
    };
    turbo.tasks["//#format:check"]!.dependsOn = ["release:aggregate"];
    await writeFile(turboPath, JSON.stringify(turbo));
    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /release:aggregate.*不允许间接启动职责 work:release/u,
    );
    assert.deepEqual(await readRuns(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [gate, role] of [
  ["check", "work:repair"],
  ["check:heavy", "work:development"],
  ["fix", "quality:heavy"],
  ["fix", "work:on-demand"],
] as const) {
  void it(`${gate} 拒绝从原生依赖图间接运行 ${role}`, async () => {
    const root = await createWorkspace();
    try {
      await addRootTask(root, "dependency:custom", [role]);
      await addRootTask(root, "entry:custom", [
        gate === "fix"
          ? "work:repair"
          : gate === "check"
            ? "quality:light"
            : "quality:heavy",
      ]);
      const turboPath = path.join(root, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { dependsOn?: string[] }>;
      };
      turbo.tasks["//#entry:custom"]!.dependsOn = ["dependency:custom"];
      await writeFile(turboPath, JSON.stringify(turbo));
      const result = await execa("pnpm", ["run", gate], {
        cwd: root,
        reject: false,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /dependency:custom.*不允许间接启动职责/u);
      assert.deepEqual(await readRuns(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const entry of ["check", "fix"]) {
  void it(`拒绝依赖回流公共入口 ${entry}`, async () => {
    const root = await createWorkspace();
    try {
      const turboPath = path.join(root, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { dependsOn?: string[] }>;
      };
      turbo.tasks["//#format:check"]!.dependsOn = [entry];
      await writeFile(turboPath, JSON.stringify(turbo));
      const result = await execa("pnpm", ["run", "check"], {
        cwd: root,
        reject: false,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /叶任务不能依赖公共聚合入口/u);
      assert.deepEqual(await readRuns(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const mutation of ["missing", "script", "command", "role"] as const) {
  void it(`直接调用共享实现仍发现公共入口接线错误：${mutation}`, async () => {
    const root = await createWorkspace();
    try {
      const manifestPath = path.join(root, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      const turboPath = path.join(root, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { tags?: string[]; command?: string[] }>;
      };
      if (mutation === "missing") {
        delete manifest.scripts["check"];
        delete turbo.tasks["//#check"];
      } else if (mutation === "script") {
        manifest.scripts["check"] = taskScript("bypassed-check");
      } else if (mutation === "command") {
        turbo.tasks["//#check"]!.command = [
          "node",
          "record.cjs",
          "bypassed-check",
        ];
      } else {
        turbo.tasks["//#check"]!.tags = ["quality:light"];
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(turboPath, JSON.stringify(turbo));
      const result = await execa("node", ["scripts/task-gates.ts", "fix"], {
        cwd: root,
        reject: false,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /公共.*入口/u);
      assert.deepEqual(await readRuns(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("轻检查为空失败，重验收和修复为空则明确跳过", async () => {
  const root = await createWorkspace();
  try {
    for (const directory of [root, path.join(root, "packages", "app")]) {
      const manifestPath = path.join(directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      const turboPath = path.join(directory, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { tags?: string[] }>;
      };
      for (const [name, task] of Object.entries(turbo.tasks)) {
        if (
          task.tags?.some(
            (tag) => tag === "quality:light" || tag === "quality:heavy",
          ) === true
        ) {
          delete turbo.tasks[name];
          delete manifest.scripts[name.replace(/^\/\/#/u, "")];
        }
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(turboPath, JSON.stringify(turbo));
    }
    for (const gate of ["check", "check:full", "check:heavy", "fix"]) {
      const result = await execa("pnpm", ["run", gate], {
        cwd: root,
        reject: false,
      });
      if (gate === "check" || gate === "check:full") {
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr, /轻检查没有选中有效任务/u);
      } else {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stderr, /没有选中任务，跳过执行/u);
      }
    }
    assert.deepEqual(await readRuns(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { runQualityGate } from "@ykdz/template-builtin-presets/quality-gates";
import { execa } from "execa";

const qualityGatesPath = fileURLToPath(
  import.meta.resolve("@ykdz/template-builtin-presets/quality-gates"),
);

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
    readonly invalidCheckCustom?: boolean;
    readonly commandOnlyTask?: boolean;
    readonly failRootLight?: boolean;
    readonly waitRootLight?: boolean;
    readonly failRootHeavy?: boolean;
    readonly withConditionalHeavyTask?: boolean;
    readonly reportConditionalTask?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-quality-gates-"));
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "quality-gates-fixture",
        private: true,
        packageManager: "pnpm@12.9.1",
        scripts: {
          check: `node --experimental-strip-types ${qualityGatesPath} check`,
          "check:heavy": `node --experimental-strip-types ${qualityGatesPath} check:heavy`,
          "check:full": `node --experimental-strip-types ${qualityGatesPath} check:full`,
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
          fix: taskScript("root-fix"),
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
    'packages: ["packages/*"]\n',
  );
  await writeFile(
    path.join(root, "packages", "app", "package.json"),
    JSON.stringify(
      {
        name: "@quality-gates/app",
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
        tags: ["quality-gates-app"],
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
        tags: ["quality-gates-root"],
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
    const lockfile = await execa(
      "pnpm",
      ["install", "--offline", "--lockfile-only"],
      { cwd: root, reject: false },
    );
    assert.equal(lockfile.exitCode, 0, lockfile.stderr);

    const install = await execa(
      "pnpm",
      ["install", "--offline", "--frozen-lockfile"],
      { cwd: root, reject: false },
    );
    assert.equal(install.exitCode, 0, install.stderr);

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

void runQualityGate;

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

void it("ignores a native task placeholder that has no script or command", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turboConfig = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turboConfig.tasks["verify:placeholder"] = { tags: ["quality:unknown"] };
    await writeFile(turboPath, JSON.stringify(turboConfig, null, 2));

    const result = await execa("pnpm", ["run", "check"], {
      cwd: root,
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
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
    ["--experimental-strip-types", qualityGatesPath, "check:full"],
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
      /条件验收未执行：@quality-gates\/app#verify:conditional/,
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

void it("rejects an executable root task with no quality or work role", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:unclassified");
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

void it("rejects package tasks that explicitly clear their owning role", async () => {
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
      /@quality-gates\/app#verify:generated 缺少唯一职责标签/,
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

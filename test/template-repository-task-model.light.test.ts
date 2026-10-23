import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { inspectTaskGate } from "@ykdz/reference-workspace-root/task-gates";
import { execa } from "execa";
import { parse } from "yaml";

type Manifest = {
  readonly packageManager?: string;
  readonly scripts: Record<string, string>;
};

type WorkspaceConfig = {
  readonly dedupeInjectedDeps?: boolean;
  readonly injectWorkspacePackages?: boolean;
  readonly syncInjectedDepsAfterScripts?: readonly string[];
};

type NativeTask = {
  readonly command: string | null;
  readonly fullName: string;
  readonly name: string;
  readonly script: string | null;
  readonly tags: readonly string[];
};

type NativePackage = {
  readonly name: string;
  readonly path: string;
  readonly tags: readonly string[];
  readonly tasks: { readonly items: readonly NativeTask[] };
};

type NativeTaskDirectory = {
  readonly data: {
    readonly packages: { readonly items: readonly NativePackage[] };
  };
};

type PlannedTask = {
  readonly command: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
  readonly resolvedTaskDefinition: {
    readonly cache: boolean;
    readonly dependsOn: readonly string[];
    readonly env: readonly string[];
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly passThroughEnv: readonly string[] | null;
    readonly persistent: boolean;
  };
  readonly taskId: string;
};

type TaskPlan = { readonly tasks: readonly PlannedTask[] };

const nativeTaskQuery =
  "query { packages { items { name path tags tasks { items { name fullName tags script command } } } } }";

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function queryNativeTaskDirectory(): Promise<NativeTaskDirectory> {
  const result = await execa("pnpm", [
    "exec",
    "turbo",
    "query",
    nativeTaskQuery,
  ]);
  return JSON.parse(result.stdout) as NativeTaskDirectory;
}

async function runTurboDryRun(...args: string[]): Promise<TaskPlan> {
  const result = await execa("pnpm", [
    "exec",
    "turbo",
    "run",
    ...args,
    "--dry-run=json",
  ]);
  return JSON.parse(result.stdout) as TaskPlan;
}

function nativeTaskByName(
  directory: NativeTaskDirectory,
): Map<string, NativeTask> {
  return new Map(
    directory.data.packages.items.flatMap(({ tasks }) =>
      tasks.items.map((task) => [task.fullName, task] as const),
    ),
  );
}

void describe("Template Repository native task model", () => {
  void it("keeps the Package Manager Pin consumable by repository automation", async () => {
    const manifest = await readJson<Manifest>("package.json");
    const pnpm = await execa("pnpm", ["--version"], { reject: true });

    assert.ok(manifest.packageManager !== undefined);
    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
    assert.strictEqual(manifest.packageManager, `pnpm@${pnpm.stdout.trim()}`);
  });

  void it("通过 Turbo 原生能力解析包标签和构建合同", async () => {
    const workspace = parse(
      await readFile("pnpm-workspace.yaml", "utf8"),
    ) as WorkspaceConfig;

    assert.strictEqual(workspace.injectWorkspacePackages, false);
    assert.strictEqual(workspace.dedupeInjectedDeps, false);
    assert.ok(workspace.syncInjectedDepsAfterScripts?.includes("build"));

    const directory = await queryNativeTaskDirectory();
    const packageTags = new Map(
      directory.data.packages.items.map(({ name, tags }) => [name, tags]),
    );
    for (const [name, tag] of [
      ["@ykdz/template", "template-cli"],
      ["@ykdz/template-checks", "template-checks"],
      ["@ykdz/template-core", "template-core"],
      ["@ykdz/template-workspace", "template-workspace"],
    ] as const)
      assert.ok(packageTags.get(name)?.includes(tag));
    assert.ok(packageTags.has("@ykdz/reference-tooling-config"));

    for (const task of nativeTaskByName(directory).values()) {
      if (task.command !== null) {
        assert.strictEqual(
          task.tags.filter(
            (tag) => tag.startsWith("quality:") || tag.startsWith("work:"),
          ).length,
          1,
          `${task.fullName} 应恰有一个任务职责`,
        );
      }
    }

    const buildPlan = await runTurboDryRun("build", "--filter=!//");
    const buildTasks = new Map(
      buildPlan.tasks.map((task) => [task.taskId, task]),
    );
    const buildIds = [
      "@ykdz/template#build",
      "@ykdz/template-checks#build",
      "@ykdz/template-core#build",
      "@ykdz/template-workspace#build",
    ];
    for (const taskId of buildIds) {
      const task = buildTasks.get(taskId);
      assert.ok(task, `${taskId} 应出现在原生构建计划中`);
      assert.equal(task.resolvedTaskDefinition.cache, true);
      assert.deepEqual(task.resolvedTaskDefinition.outputs, ["dist/**"]);
      assert.ok(Object.hasOwn(task.inputs, "package.json"));
      assert.ok(Object.hasOwn(task.inputs, "tsconfig.build.json"));
      assert.ok(
        Object.keys(task.inputs).some((input) => input.startsWith("src/")),
      );
      assert.ok(
        task.resolvedTaskDefinition.inputs.every(
          (input) => !input.startsWith("../"),
        ),
      );
    }
    const configBuild = buildTasks.get("@ykdz/reference-tooling-config#build");
    assert.ok(configBuild);
    assert.equal(configBuild.command, "<NONEXISTENT>");
    assert.deepEqual(configBuild.resolvedTaskDefinition.dependsOn, []);
    assert.deepEqual(
      nativeTaskByName(directory).get("@ykdz/reference-tooling-config#build")
        ?.tags,
      [],
    );
    for (const [consumer, dependencies] of [
      [
        "@ykdz/template#build",
        [
          "@ykdz/reference-tooling-config#build",
          "@ykdz/template-content#build",
          "@ykdz/template-core#build",
          "@ykdz/template-workspace#build",
        ],
      ],
      [
        "@ykdz/template-checks#build",
        [
          "@ykdz/reference-ts-cli#build",
          "@ykdz/reference-tooling-config#build",
          "@ykdz/template-content#build",
          "@ykdz/template-core#build",
          "@ykdz/template-generator#build",
          "@ykdz/template-workspace#build",
          "@ykdz/template-workspace-authoring#build",
          "@ykdz/reference-workspace-root#build",
        ],
      ],
    ] as const)
      for (const dependency of dependencies)
        assert.ok(
          buildTasks.get(consumer)?.dependencies.includes(dependency),
          `${consumer} 缺少 ${dependency}`,
        );
    assert.deepEqual(
      buildTasks.get("@ykdz/template-core#build")?.dependencies,
      [],
    );
  });

  void it("公共检查和修复复用同一执行器，轻重测试按目录递归发现", async () => {
    const manifest = await readJson<Manifest>("package.json");
    const scripts = manifest.scripts;

    assert.strictEqual(
      scripts.check,
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check",
    );
    assert.strictEqual(
      scripts["check:heavy"],
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:heavy",
    );
    assert.strictEqual(
      scripts["check:full"],
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts check:full",
    );
    assert.strictEqual(
      scripts.fix,
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts fix",
    );
    assert.strictEqual(
      scripts.build,
      "turbo run build --filter=!// --output-logs=errors-only --log-order=grouped",
    );
    assert.strictEqual(scripts.boundaries, "turbo boundaries");
    assert.match(scripts.test ?? "", /test\/\*\*\/\*\.light\.test\.ts/u);
    assert.strictEqual(
      scripts["test:integration"],
      "node --conditions=source scripts/run-root-integration.ts",
    );
    assert.match(scripts.test ?? "", /--test-concurrency=2/u);

    const cliManifest = await readJson<Manifest>("packages/cli/package.json");
    assert.match(cliManifest.scripts.test ?? "", /--test-concurrency=2/u);

    for (const task of [
      "format:check",
      "format:write",
      "lint",
      "lint:fix",
      "typecheck",
      "test",
    ]) {
      assert.ok(scripts[task] !== undefined, `root ${task} script`);
      assert.ok(
        !scripts[task].includes("turbo run"),
        `root ${task} is a leaf command`,
      );
    }
    for (const task of ["format:check", "format:write"]) {
      const script = scripts[task];
      assert.ok(script !== undefined);
      assert.ok(script.includes("scripts"));
      assert.ok(script.includes("test"));
    }
  });

  void it("joins root and package leaf tasks in one Turbo action graph", async () => {
    const nativeTasks = nativeTaskByName(await queryNativeTaskDirectory());
    assert.deepStrictEqual(nativeTasks.get("//#build")?.tags, [
      "work:preparation",
    ]);
    assert.deepStrictEqual(nativeTasks.get("//#test")?.tags, ["quality:light"]);
    assert.deepStrictEqual(nativeTasks.get("//#check")?.tags, [
      "quality:entry",
    ]);
    assert.deepStrictEqual(nativeTasks.get("@ykdz/template#test")?.tags, [
      "quality:light",
    ]);
    assert.deepStrictEqual(
      nativeTasks.get("@ykdz/template#test:e2e:source")?.tags,
      ["quality:conditional"],
    );
    assert.deepStrictEqual(
      nativeTasks.get("@ykdz/template-checks#check:evidence-health")?.tags,
      ["quality:conditional"],
    );

    const actionGraph = await runTurboDryRun(
      "format:check",
      "lint",
      "typecheck",
      "test",
    );
    const taskIds = actionGraph.tasks.map((task) => task.taskId);

    assert.ok(!taskIds.includes("//#boundaries"));
    assert.ok(taskIds.includes("//#format:check"));
    assert.ok(taskIds.includes("//#lint"));
    assert.ok(taskIds.includes("//#typecheck"));
    assert.ok(taskIds.includes("//#test"));
    assert.ok(!taskIds.includes("//#test:e2e"));
    assert.ok(taskIds.includes("@ykdz/template-core#format:check"));
    assert.ok(taskIds.includes("@ykdz/template-core#typecheck"));
    assert.ok(taskIds.includes("@ykdz/template-workspace#test"));
    assert.ok(taskIds.includes("@ykdz/template-checks#test"));
    assert.ok(
      !actionGraph.tasks
        .find(({ taskId }) => taskId === "@ykdz/template-checks#lint")
        ?.dependencies.includes("@ykdz/template-core#build"),
    );
    assert.strictEqual(
      taskIds.some((taskId) => taskId.includes("transit")),
      false,
    );
  });

  void it("keeps registry and Template Source checks under the checks owner", async () => {
    const checks = await readJson<Manifest>("packages/checks/package.json");

    const templateCheckScript = checks.scripts["check:templates"];
    assert.ok(templateCheckScript !== undefined);

    const result = await execa(
      "pnpm",
      ["exec", "turbo", "run", "check:templates", "--dry-run=json"],
      { reject: true },
    );
    const actionGraph = JSON.parse(result.stdout) as {
      readonly tasks: readonly {
        readonly command: string;
        readonly dependencies: readonly string[];
        readonly taskId: string;
      }[];
    };
    const taskIds = actionGraph.tasks.map((task) => task.taskId);
    const executableTemplateChecks = actionGraph.tasks.filter(
      ({ command, taskId }) =>
        taskId.endsWith("#check:templates") && command !== "<NONEXISTENT>",
    );

    assert.strictEqual(executableTemplateChecks.length, 1);
    assert.strictEqual(
      executableTemplateChecks[0]?.taskId,
      "@ykdz/template-checks#check:templates",
    );
    assert.ok(!taskIds.includes("//#test"));
    assert.ok(!taskIds.includes("@ykdz/template#build"));

    const requiredTasks = [
      "check:generated",
      "check:focused",
      "check:deployment",
      "check:capabilities",
    ];
    const registryGraphResult = await execa(
      "pnpm",
      ["exec", "turbo", "run", ...requiredTasks, "--dry-run=json"],
      { reject: true },
    );
    const registryGraph = JSON.parse(registryGraphResult.stdout) as {
      readonly tasks: readonly {
        readonly taskId: string;
        readonly dependencies: readonly string[];
      }[];
    };
    assert.deepStrictEqual(
      registryGraph.tasks.map((task) => task.taskId).sort(),
      requiredTasks.map((name) => `@ykdz/template-checks#${name}`).sort(),
    );
    for (const task of registryGraph.tasks)
      assert.deepStrictEqual(task.dependencies, []);
    const matrixGraphResult = await execa(
      "pnpm",
      ["exec", "turbo", "run", "diagnose:matrix", "--dry-run=json"],
      { reject: true },
    );
    const matrixGraph = JSON.parse(matrixGraphResult.stdout) as {
      readonly tasks: readonly { readonly taskId: string }[];
    };
    assert.deepStrictEqual(
      matrixGraph.tasks.map((task) => task.taskId),
      ["@ykdz/template-checks#diagnose:matrix"],
    );
  });

  void it("builds every package without scheduling the recursive root build script", async () => {
    const result = await execa(
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=!//", "--dry-run=json"],
      { reject: true },
    );
    const actionGraph = JSON.parse(result.stdout) as {
      readonly tasks: readonly { readonly taskId: string }[];
    };
    const taskIds = actionGraph.tasks.map((task) => task.taskId);

    assert.ok(!taskIds.includes("//#build"));
    for (const packageName of [
      "@ykdz/template",
      "@ykdz/template-checks",
      "@ykdz/template-core",
      "@ykdz/template-workspace",
    ]) {
      assert.ok(taskIds.includes(`${packageName}#build`));
    }
  });

  void it("lets the public CLI prepack select itself while Turbo builds dependencies", async () => {
    const cli = await readJson<Manifest>("packages/cli/package.json");

    assert.strictEqual(cli.scripts.prepack, "pnpm run build:distribution");
    assert.match(
      cli.scripts["build:distribution"] ?? "",
      /^pnpm exec turbo run build --filter=\. && /u,
    );

    const result = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "build",
        "--filter=@ykdz/template",
        "--dry-run=json",
      ],
      { reject: true },
    );
    const tasks = (
      JSON.parse(result.stdout) as {
        readonly tasks: readonly { readonly taskId: string }[];
      }
    ).tasks.map(({ taskId }) => taskId);
    assert.ok(tasks.includes("@ykdz/template#build"));
    assert.ok(tasks.includes("@ykdz/template-core#build"));
    assert.ok(tasks.includes("@ykdz/template-workspace#build"));
  });

  void it("源码旅程不造候选，正式 tgz 负责 compiled CLI 消费", async () => {
    const directory = nativeTaskByName(await queryNativeTaskDirectory());
    const root = await readJson<Manifest>("package.json");
    const cli = await readJson<Manifest>("packages/cli/package.json");
    const source = await runTurboDryRun(
      "test",
      "test:e2e:source",
      "--filter=@ykdz/template",
    );
    assert.ok(source.tasks.every((task) => !task.taskId.endsWith("#build")));
    assert.deepEqual(directory.get("@ykdz/template#test:e2e:source")?.tags, [
      "quality:conditional",
    ]);
    assert.deepEqual(
      directory.get("@ykdz/template#test:e2e:distribution")?.tags,
      ["quality:conditional"],
    );
    assert.equal(
      root.scripts["test:e2e:cli"],
      "pnpm --filter @ykdz/template run test:e2e:resolution && pnpm --filter @ykdz/template run test:e2e:source",
    );
    assert.deepEqual(directory.get("//#test:e2e:cli")?.tags, ["quality:heavy"]);
    const gate = inspectTaskGate(
      "check:heavy",
      process.cwd(),
      "node --conditions=source --experimental-strip-types scripts/run-task-gate.ts",
    );
    const heavyTasks = new Set(
      gate.plans.flatMap((plan) => plan.tasks.map((task) => task.fullName)),
    );
    assert.ok(heavyTasks.has("//#test:e2e:cli"));

    const cliJourney = await runTurboDryRun("test:e2e:cli");
    const cliJourneyTaskIds = new Set(
      cliJourney.tasks.map((task) => task.taskId),
    );
    assert.ok(cliJourneyTaskIds.has("//#test:e2e:cli"));
    assert.ok(!cliJourneyTaskIds.has("@ykdz/template#build"));
    assert.ok(cli.scripts["test:e2e:source"]?.includes("--conditions=source"));
    assert.ok(
      !cli.scripts["test:e2e:distribution"]?.includes("--conditions=source"),
    );
  });
});

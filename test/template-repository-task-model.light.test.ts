import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

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

  void it("resolves package labels and build contracts through native Turbo", async () => {
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
    assert.deepStrictEqual(
      [...packageTags].sort(([a], [b]) => a.localeCompare(b)),
      [
        ["@ykdz/template", ["template-cli"]],
        ["@ykdz/template-builtin-presets", ["template-builtin-presets"]],
        ["@ykdz/template-checks", ["template-checks"]],
        ["@ykdz/template-core", ["template-core"]],
        ["//", ["template-root"]],
      ],
    );

    for (const task of nativeTaskByName(directory).values()) {
      if (task.command !== null) {
        assert.strictEqual(
          task.tags.length,
          1,
          `${task.fullName} has one task role`,
        );
      }
    }

    const buildPlan = await runTurboDryRun("build", "--filter=!//");
    const buildTasks = new Map(
      buildPlan.tasks.map((task) => [task.taskId, task]),
    );
    const buildIds = [
      "@ykdz/template#build",
      "@ykdz/template-builtin-presets#build",
      "@ykdz/template-checks#build",
      "@ykdz/template-core#build",
    ];
    assert.deepStrictEqual([...buildTasks.keys()].sort(), [...buildIds].sort());

    for (const taskId of buildIds.filter(
      (id) => id !== "@ykdz/template-core#build",
    )) {
      const task = buildTasks.get(taskId);
      assert.ok(task, `${taskId} is in the native build plan`);
      assert.deepStrictEqual(task.resolvedTaskDefinition.dependsOn, ["^build"]);
      assert.strictEqual(task.resolvedTaskDefinition.cache, true);
      assert.deepStrictEqual(task.resolvedTaskDefinition.outputs, ["dist/**"]);
      assert.deepStrictEqual([...task.resolvedTaskDefinition.inputs].sort(), [
        "../../tsconfig.base.json",
        "../../tsconfig.json",
      ]);
    }

    const coreBuild = buildTasks.get("@ykdz/template-core#build");
    assert.ok(coreBuild);
    assert.deepStrictEqual(
      [...coreBuild.resolvedTaskDefinition.inputs].sort(),
      [
        "../../Cargo.lock",
        "../../Cargo.toml",
        "../../pnpm-workspace.yaml",
        "../../tsconfig.base.json",
        "../../tsconfig.json",
      ],
    );
    assert.deepStrictEqual(
      buildIds.map((taskId) => [
        taskId,
        [...(buildTasks.get(taskId)?.dependencies ?? [])].sort(),
      ]),
      [
        [
          "@ykdz/template#build",
          ["@ykdz/template-builtin-presets#build", "@ykdz/template-core#build"],
        ],
        ["@ykdz/template-builtin-presets#build", ["@ykdz/template-core#build"]],
        [
          "@ykdz/template-checks#build",
          ["@ykdz/template-builtin-presets#build", "@ykdz/template-core#build"],
        ],
        ["@ykdz/template-core#build", []],
      ],
    );
  });

  void it("exposes one public quality-gate runner and recursive light/heavy test scripts", async () => {
    const manifest = await readJson<Manifest>("package.json");
    const scripts = manifest.scripts;

    assert.strictEqual(
      scripts.check,
      "node --conditions=source --experimental-strip-types scripts/run-quality-gate.ts check",
    );
    assert.strictEqual(
      scripts["check:heavy"],
      "node --conditions=source --experimental-strip-types scripts/run-quality-gate.ts check:heavy",
    );
    assert.strictEqual(
      scripts["check:full"],
      "node --conditions=source --experimental-strip-types scripts/run-quality-gate.ts check:full",
    );
    assert.strictEqual(
      scripts.fix,
      "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
    );
    assert.strictEqual(
      scripts.build,
      "turbo run build --filter=!// --output-logs=errors-only --log-order=grouped",
    );
    assert.strictEqual(
      scripts.boundaries,
      "node --conditions=source --experimental-strip-types scripts/run-turbo-boundaries.ts",
    );
    assert.match(scripts.test ?? "", /test\/\*\*\/\*\.light\.test\.ts/u);
    assert.strictEqual(
      scripts["test:integration"],
      "node --conditions=source --experimental-strip-types scripts/run-root-integration.ts",
    );
    assert.strictEqual(
      scripts["test:packed-publication"],
      "node --conditions=source --experimental-strip-types scripts/run-packed-publication-test.ts",
    );
    assert.ok(
      scripts.test?.includes(
        "@ykdz/template-builtin-presets/node-test-count-reporter",
      ),
    );
    assert.match(scripts.test ?? "", /--test-concurrency=2/u);

    const builtinPresetsManifest = await readJson<Manifest>(
      "packages/builtin-presets/package.json",
    );
    assert.match(
      builtinPresetsManifest.scripts.test ?? "",
      /--test-concurrency=2/u,
    );

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
    assert.ok(!Object.keys(scripts).includes("check:boundaries"));
    assert.ok(!Object.keys(scripts).includes("check:format"));
    assert.ok(!Object.keys(scripts).includes("check:lint"));
    assert.ok(!Object.keys(scripts).includes("format:check:root"));
    assert.ok(!Object.keys(scripts).includes("format:write:root"));
    assert.ok(!Object.keys(scripts).includes("lint:root"));
    assert.ok(!Object.keys(scripts).includes("lint:fix:root"));
    assert.ok(!Object.keys(scripts).includes("typecheck:root"));
    assert.ok(!Object.keys(scripts).includes("check:templates:shared-oxc"));
    assert.ok(!Object.keys(scripts).includes("check:templates:static-source"));

    for (const command of Object.values(scripts)) {
      assert.ok(!command.includes(":root"));
      assert.ok(!command.includes(":run"));
      assert.ok(!command.includes("transit"));
    }

    for (const task of ["format:check", "format:write"]) {
      const script = scripts[task];
      assert.ok(script !== undefined);
      assert.ok(script.includes("git ls-files -- ':!packages/**'"));
      assert.ok(!script.includes("packages/builtin-presets"));
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
    assert.deepStrictEqual(nativeTasks.get("@ykdz/template#test:e2e")?.tags, [
      "quality:heavy",
    ]);
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
    assert.ok(
      !actionGraph.tasks
        .find(({ taskId }) => taskId === "@ykdz/template#lint")
        ?.dependencies.includes("@ykdz/template-builtin-presets#build"),
    );
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
    const [checks, builtInPresets] = await Promise.all([
      readJson<Manifest>("packages/checks/package.json"),
      readJson<Manifest>("packages/builtin-presets/package.json"),
    ]);

    const templateCheckScript = checks.scripts["check:templates"];
    assert.ok(templateCheckScript !== undefined);
    assert.ok(!templateCheckScript.includes("@ykdz/template-builtin-presets"));
    assert.strictEqual(builtInPresets.scripts["check:templates"], undefined);
    assert.strictEqual(
      builtInPresets.scripts["check:templates:boundary"],
      undefined,
    );

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
    assert.ok(taskIds.includes("@ykdz/template-checks#prepare:rustfmt"));
    assert.ok(
      executableTemplateChecks[0]?.dependencies.includes(
        "@ykdz/template-checks#prepare:rustfmt",
      ),
    );
    assert.ok(
      !taskIds.includes(
        "@ykdz/template-builtin-presets#check:templates:boundary",
      ),
    );
    assert.ok(!taskIds.includes("//#test"));
    assert.ok(!taskIds.includes("@ykdz/template-core#build"));
    assert.ok(!taskIds.includes("@ykdz/template-builtin-presets#build"));
    assert.ok(!taskIds.includes("@ykdz/template#build"));

    const registryGraphResult = await execa(
      "pnpm",
      ["exec", "turbo", "run", "check:deployment", "--dry-run=json"],
      { reject: true },
    );
    const registryGraph = JSON.parse(registryGraphResult.stdout) as {
      readonly tasks: readonly {
        readonly dependencies: readonly string[];
        readonly taskId: string;
      }[];
    };
    const taskById = new Map(
      registryGraph.tasks.map((task) => [task.taskId, task]),
    );
    assert.ok(
      taskById
        .get("@ykdz/template-checks#check:focused")
        ?.dependencies.includes("@ykdz/template-checks#check:generated"),
    );
    assert.ok(
      taskById
        .get("@ykdz/template-checks#check:fixtures")
        ?.dependencies.includes("@ykdz/template-checks#check:focused"),
    );
    assert.ok(
      taskById
        .get("@ykdz/template-checks#check:deployment")
        ?.dependencies.includes("@ykdz/template-checks#check:fixtures"),
    );

    const focusedGraphResult = await execa(
      "pnpm",
      ["exec", "turbo", "run", "check:focused", "--dry-run=json"],
      { reject: true },
    );
    const focusedGraph = JSON.parse(focusedGraphResult.stdout) as {
      readonly tasks: readonly {
        readonly taskId: string;
      }[];
    };
    assert.ok(
      focusedGraph.tasks.some(
        ({ taskId }) => taskId === "@ykdz/template-checks#check:generated",
      ),
    );
    assert.ok(
      !focusedGraph.tasks.some(({ taskId }) =>
        ["check:fixtures", "check:deployment"].some(
          (task) => taskId === `@ykdz/template-checks#${task}`,
        ),
      ),
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
      "@ykdz/template-builtin-presets",
      "@ykdz/template-checks",
      "@ykdz/template-core",
    ]) {
      assert.ok(taskIds.includes(`${packageName}#build`));
    }
  });

  void it("lets the public CLI prepack select itself while Turbo builds dependencies", async () => {
    const cli = await readJson<Manifest>("packages/cli/package.json");

    assert.strictEqual(
      cli.scripts.prepack,
      "pnpm exec turbo run build --filter=.",
    );
    assert.ok(!cli.scripts.prepack.includes("@ykdz/template-core"));
    assert.ok(!cli.scripts.prepack.includes("@ykdz/template-builtin-presets"));

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
    assert.ok(tasks.includes("@ykdz/template-builtin-presets#build"));
  });

  void it("keeps source tests build-free and orders distribution e2e through Turbo", async () => {
    const cli = await readJson<Manifest>("packages/cli/package.json");
    const result = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "test",
        "test:e2e",
        "--filter=@ykdz/template",
        "--dry-run=json",
      ],
      { reject: true },
    );
    const tasks = (
      JSON.parse(result.stdout) as {
        readonly tasks: readonly {
          readonly taskId: string;
          readonly dependencies: readonly string[];
        }[];
      }
    ).tasks;

    assert.deepStrictEqual(
      tasks.find(({ taskId }) => taskId === "@ykdz/template#test")
        ?.dependencies,
      [],
    );
    assert.ok(
      tasks
        .find(({ taskId }) => taskId === "@ykdz/template#test:e2e")
        ?.dependencies.includes("@ykdz/template#build"),
    );
    assert.strictEqual(
      cli.scripts["test:e2e"],
      "node --conditions=source test/e2e/check-source-and-distribution.ts",
    );
  });
});

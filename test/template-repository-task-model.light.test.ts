import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { execa } from "execa";
import { parse } from "yaml";

type Manifest = {
  readonly packageManager?: string;
  readonly scripts: Record<string, string>;
};

type TurboTask = {
  readonly cache?: boolean;
  readonly dependsOn?: readonly string[];
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly passThroughEnv?: readonly string[];
  readonly tags?: readonly string[];
};

type TurboConfig = {
  readonly concurrency?: string;
  readonly tags?: readonly string[];
  readonly tasks: Record<string, TurboTask>;
};

type WorkspaceConfig = {
  readonly dedupeInjectedDeps?: boolean;
  readonly injectWorkspacePackages?: boolean;
  readonly syncInjectedDepsAfterScripts?: readonly string[];
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

void describe("Template Repository native task model", () => {
  void it("keeps the Package Manager Pin consumable by repository automation", async () => {
    const manifest = await readJson<Manifest>("package.json");
    const pnpm = await execa("pnpm", ["--version"], { reject: true });

    assert.ok(manifest.packageManager !== undefined);
    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
    assert.strictEqual(manifest.packageManager, `pnpm@${pnpm.stdout.trim()}`);
  });

  void it("caches distribution builds with the root snapshots core copies", async () => {
    const workspace = parse(
      await readFile("pnpm-workspace.yaml", "utf8"),
    ) as WorkspaceConfig;
    const turbo = await readJson<TurboConfig>("turbo.json");
    const coreTurbo = await readJson<TurboConfig>("packages/core/turbo.json");

    assert.strictEqual(workspace.injectWorkspacePackages, false);
    assert.strictEqual(workspace.dedupeInjectedDeps, false);
    assert.ok(workspace.syncInjectedDepsAfterScripts?.includes("build"));
    assert.notStrictEqual(turbo.tasks.build?.cache, false);
    assert.deepStrictEqual(turbo.tasks.build?.inputs, [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/tsconfig.json",
      "$TURBO_ROOT$/tsconfig.base.json",
    ]);
    assert.deepStrictEqual(turbo.tasks.build?.outputs, ["dist/**"]);
    assert.deepStrictEqual(turbo.tasks["format:check"]?.inputs, [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/oxfmt.config.ts",
    ]);
    assert.deepStrictEqual(turbo.tasks.lint?.inputs, [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/oxlint.config.ts",
    ]);
    assert.deepStrictEqual(turbo.tasks.typecheck?.inputs, [
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/tsconfig.json",
      "$TURBO_ROOT$/tsconfig.base.json",
    ]);
    assert.deepStrictEqual(coreTurbo.tags, ["template-core"]);
    assert.deepStrictEqual(coreTurbo.tasks.build?.inputs, [
      "$TURBO_EXTENDS$",
      "$TURBO_ROOT$/pnpm-workspace.yaml",
      "$TURBO_ROOT$/Cargo.toml",
      "$TURBO_ROOT$/Cargo.lock",
    ]);
    const builtinPresetsTurbo = await readJson<TurboConfig>(
      "packages/builtin-presets/turbo.json",
    );
    assert.deepStrictEqual(builtinPresetsTurbo.tasks.lint?.inputs, [
      "$TURBO_EXTENDS$",
      "$TURBO_ROOT$/oxlint.template-source.config.ts",
    ]);
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
    for (const alias of [
      "check:fixtures",
      "check:focused",
      "check:generated",
      "check:deployment",
      "check:templates",
      "check:templates:boundary",
      "check:templates:github-yaml",
    ]) {
      assert.strictEqual(scripts[alias], undefined, `root ${alias} alias`);
    }
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
    const turbo = await readJson<TurboConfig>("turbo.json");
    const tasks = turbo.tasks;

    assert.strictEqual(turbo.concurrency, "2");

    for (const task of [
      "format:check",
      "format:write",
      "lint",
      "lint:fix",
      "typecheck",
      "test",
    ]) {
      assert.notStrictEqual(
        tasks[`//#${task}`],
        undefined,
        `root ${task} configuration`,
      );
    }
    assert.deepStrictEqual(tasks.build?.tags, ["quality:light"]);
    assert.deepStrictEqual(tasks["//#build"]?.tags, ["work:preparation"]);
    assert.strictEqual(tasks.transit, undefined);
    assert.strictEqual(tasks["check:templates:shared-oxc"], undefined);
    assert.strictEqual(tasks["check:templates:static-source"], undefined);
    assert.ok(tasks.typecheck?.dependsOn?.includes("^typecheck"));
    assert.ok(!(tasks.typecheck?.dependsOn ?? []).includes("^build"));
    assert.deepStrictEqual(tasks["//#typecheck"]?.dependsOn, ["^typecheck"]);
    assert.ok(tasks.build?.dependsOn?.includes("^build"));
    assert.ok(!(tasks.lint?.dependsOn ?? []).includes("^build"));
    assert.ok(!(tasks.test?.dependsOn ?? []).includes("build"));
    assert.ok(!(tasks["//#test"]?.dependsOn ?? []).includes("^build"));
    assert.ok(tasks["//#test"]?.dependsOn?.includes("@ykdz/template#build"));
    assert.ok(!(tasks["check:templates"]?.dependsOn ?? []).includes("//#test"));
    assert.strictEqual(tasks["//#test:e2e"], undefined);
    assert.ok(tasks["test:e2e"]?.dependsOn?.includes("build"));
    assert.strictEqual(tasks["test:e2e"]?.cache, false);
    assert.deepStrictEqual(tasks.test?.tags, ["quality:light"]);
    assert.deepStrictEqual(tasks["test:integration"]?.tags, ["quality:heavy"]);
    assert.deepStrictEqual(tasks["test:packed-publication"]?.tags, [
      "quality:heavy",
    ]);
    assert.deepStrictEqual(tasks["//#test"]?.tags, ["quality:light"]);
    assert.deepStrictEqual(tasks["//#test:integration"]?.tags, [
      "quality:heavy",
    ]);
    assert.deepStrictEqual(tasks["//#test:packed-publication"]?.tags, [
      "quality:heavy",
    ]);
    assert.deepStrictEqual(tasks["check:evidence-health"]?.tags, [
      "quality:conditional",
    ]);
    assert.strictEqual(tasks["check:evidence-health"]?.cache, false);
    assert.ok(
      tasks["//#test:integration"]?.dependsOn?.includes("@ykdz/template#build"),
    );
    assert.ok(
      tasks["//#test:packed-publication"]?.dependsOn?.includes(
        "@ykdz/template#build",
      ),
    );
    for (const task of [
      "check:fixtures",
      "check:generated",
      "check:focused",
      "check:deployment",
      "check:templates",
      "check:templates:boundary",
      "check:templates:github-yaml",
    ]) {
      assert.ok(!(tasks[task]?.dependsOn ?? []).includes("^build"));
    }
    for (const task of [
      "check:fixtures",
      "check:generated",
      "check:focused",
      "check:deployment",
    ]) {
      assert.strictEqual(tasks[task]?.cache, false, `${task} cache`);
      assert.deepStrictEqual(tasks[task]?.passThroughEnv, [
        "TEMPLATE_FIXTURE_BUILDKIT_CACHE_DIR",
        "TEMPLATE_FIXTURE_CARGO_CACHE_DIR",
        "TEMPLATE_FIXTURE_CONCURRENCY",
        "TEMPLATE_FIXTURE_DEVELOPMENT_CONTAINER_SESSIONS",
        "TEMPLATE_FIXTURE_EVIDENCE_DIR",
        "TEMPLATE_FIXTURE_EVIDENCE_READ",
        "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
        "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
        "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
        "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
        "TEMPLATE_FIXTURE_PNPM_CACHE_DIR",
        "TEMPLATE_FIXTURE_WORKSPACE_DIR",
        "TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY",
        "TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY",
        "TEMPLATE_FIXTURE_TURBO_TEAM",
        "TEMPLATE_FIXTURE_TURBO_TOKEN",
      ]);
    }
    assert.ok(tasks["format:write"]?.dependsOn?.includes("lint:fix"));
    assert.strictEqual(tasks["format:write"]?.cache, false);
    assert.strictEqual(tasks["lint:fix"]?.cache, false);

    const result = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "format:check",
        "lint",
        "typecheck",
        "test",
        "--dry-run=json",
      ],
      { reject: true },
    );
    const actionGraph = JSON.parse(result.stdout) as {
      readonly tasks: readonly {
        readonly dependencies: readonly string[];
        readonly taskId: string;
      }[];
    };
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
    assert.ok(
      !taskIds.includes(
        "@ykdz/template-builtin-presets#check:templates:boundary",
      ),
    );
    assert.ok(!taskIds.includes("//#test"));
    assert.ok(!taskIds.includes("@ykdz/template-core#build"));
    assert.ok(!taskIds.includes("@ykdz/template-builtin-presets#build"));
    assert.ok(!taskIds.includes("@ykdz/template#build"));
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

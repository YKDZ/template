import { readFile } from "node:fs/promises";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

type Manifest = {
  readonly scripts: Record<string, string>;
};

type TurboTask = {
  readonly cache?: boolean;
  readonly dependsOn?: readonly string[];
  readonly passThroughEnv?: readonly string[];
};

type TurboConfig = {
  readonly tasks: Record<string, TurboTask>;
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

describe("Template Repository native task model", () => {
  it("uses conventional root leaf tasks and one native check/fix invocation", async () => {
    const manifest = await readJson<Manifest>("package.json");
    const scripts = manifest.scripts;

    expect(scripts.check).toBe(
      "turbo run boundaries format:check lint typecheck build test test:e2e check:generated check:templates check:templates:boundary check:templates:github-yaml --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
    );
    expect(scripts.fix).toBe(
      "turbo run lint:fix format:write --continue=dependencies-successful --output-logs=full --log-order=grouped --log-prefix=task",
    );
    expect(scripts.build).toBe(
      "turbo run build --filter=!// --output-logs=errors-only --log-order=grouped",
    );
    expect(scripts["check:focused"]).toBe(
      "turbo run check:focused --output-logs=errors-only --log-order=grouped",
    );
    expect(scripts.check).not.toContain("check:focused");

    for (const task of [
      "boundaries",
      "format:check",
      "format:write",
      "lint",
      "lint:fix",
      "typecheck",
      "test",
    ]) {
      expect(scripts[task], `root ${task} script`).toBeDefined();
      expect(scripts[task], `root ${task} is a leaf command`).not.toContain(
        "turbo run",
      );
    }
    expect(Object.keys(scripts)).not.toContain("check:boundaries");
    expect(Object.keys(scripts)).not.toContain("check:format");
    expect(Object.keys(scripts)).not.toContain("check:lint");
    expect(Object.keys(scripts)).not.toContain("format:check:root");
    expect(Object.keys(scripts)).not.toContain("format:write:root");
    expect(Object.keys(scripts)).not.toContain("lint:root");
    expect(Object.keys(scripts)).not.toContain("lint:fix:root");
    expect(Object.keys(scripts)).not.toContain("typecheck:root");
    expect(Object.keys(scripts)).not.toContain("check:templates:shared-oxc");
    expect(Object.keys(scripts)).not.toContain("check:templates:static-source");

    for (const command of Object.values(scripts)) {
      expect(command).not.toContain(":root");
      expect(command).not.toContain(":run");
      expect(command).not.toContain("transit");
    }

    for (const task of ["format:check", "format:write"]) {
      expect(scripts[task]).toContain("git ls-files -- ':!packages/**'");
      expect(scripts[task]).not.toContain("packages/builtin-presets");
    }
  });

  it("joins root and package leaf tasks in one Turbo action graph", async () => {
    const turbo = await readJson<TurboConfig>("turbo.json");
    const tasks = turbo.tasks;

    for (const task of [
      "boundaries",
      "format:check",
      "format:write",
      "lint",
      "lint:fix",
      "typecheck",
      "test",
    ]) {
      expect(tasks[`//#${task}`], `root ${task} configuration`).toBeDefined();
    }
    expect(tasks["//#build"]).toBeUndefined();
    expect(tasks.transit).toBeUndefined();
    expect(tasks["check:templates:shared-oxc"]).toBeUndefined();
    expect(tasks["check:templates:static-source"]).toBeUndefined();
    expect(tasks.typecheck?.dependsOn).toContain("^typecheck");
    expect(tasks.typecheck?.dependsOn).not.toContain("^build");
    expect(tasks["//#typecheck"]?.dependsOn).toEqual(["^typecheck"]);
    expect(tasks.build?.dependsOn).toContain("^build");
    expect(tasks.lint?.dependsOn ?? []).not.toContain("^build");
    expect(tasks.test?.dependsOn ?? []).not.toContain("build");
    expect(tasks["//#test"]?.dependsOn ?? []).not.toContain("^build");
    expect(tasks["//#test"]?.dependsOn).toContain("@ykdz/template#build");
    expect(tasks["check:templates"]?.dependsOn).toContain("//#test");
    expect(tasks["//#test:e2e"]).toBeUndefined();
    expect(tasks["test:e2e"]?.dependsOn ?? []).not.toContain("build");
    expect(tasks["test:e2e"]?.cache).toBe(false);
    for (const task of [
      "check:fixtures",
      "check:generated",
      "check:focused",
      "check:deployment",
      "check:templates",
      "check:templates:boundary",
      "check:templates:github-yaml",
      "check:toolchain:online",
    ]) {
      expect(tasks[task]?.dependsOn ?? []).not.toContain("^build");
    }
    for (const task of [
      "check:fixtures",
      "check:generated",
      "check:focused",
      "check:deployment",
    ]) {
      expect(tasks[task]?.cache, `${task} cache`).toBe(false);
      expect(tasks[task]?.passThroughEnv).toEqual([
        "TEMPLATE_FIXTURE_CONCURRENCY",
        "TEMPLATE_FIXTURE_EVIDENCE_DIR",
        "TEMPLATE_FIXTURE_EVIDENCE_READ",
        "TEMPLATE_FIXTURE_EVIDENCE_WRITE",
        "TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR",
        "TEMPLATE_FIXTURE_EVIDENCE_RUN_ID",
        "TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT",
      ]);
    }
    expect(tasks["format:write"]?.dependsOn).toContain("lint:fix");
    expect(tasks.boundaries?.cache).toBe(false);
    expect(tasks["format:write"]?.cache).toBe(false);
    expect(tasks["lint:fix"]?.cache).toBe(false);

    const result = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "boundaries",
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

    expect(taskIds).toContain("//#boundaries");
    expect(taskIds).toContain("//#format:check");
    expect(taskIds).toContain("//#lint");
    expect(taskIds).toContain("//#typecheck");
    expect(taskIds).toContain("//#test");
    expect(taskIds).not.toContain("//#test:e2e");
    expect(taskIds).toContain("@ykdz/template-core#format:check");
    expect(taskIds).toContain("@ykdz/template-core#typecheck");
    expect(
      actionGraph.tasks.find(({ taskId }) => taskId === "@ykdz/template#lint")
        ?.dependencies,
    ).not.toContain("@ykdz/template-builtin-presets#build");
    expect(
      actionGraph.tasks.find(
        ({ taskId }) => taskId === "@ykdz/template-checks#lint",
      )?.dependencies,
    ).not.toContain("@ykdz/template-core#build");
    expect(taskIds.some((taskId) => taskId.includes("transit"))).toBe(false);
  });

  it("discovers independently owned template checks without package aggregation", async () => {
    const [checks, builtInPresets] = await Promise.all([
      readJson<Manifest>("packages/checks/package.json"),
      readJson<Manifest>("packages/builtin-presets/package.json"),
    ]);

    expect(checks.scripts["check:templates"]).not.toContain(
      "@ykdz/template-builtin-presets",
    );
    expect(builtInPresets.scripts["check:templates"]).not.toContain(
      "check:templates:boundary",
    );

    const result = await execa(
      "pnpm",
      ["exec", "turbo", "run", "check:templates", "--dry-run=json"],
      { reject: true },
    );
    const actionGraph = JSON.parse(result.stdout) as {
      readonly tasks: readonly { readonly taskId: string }[];
    };
    const taskIds = actionGraph.tasks.map((task) => task.taskId);

    expect(
      taskIds.filter(
        (task) => task === "@ykdz/template-checks#check:templates",
      ),
    ).toHaveLength(1);
    expect(
      taskIds.filter(
        (task) => task === "@ykdz/template-builtin-presets#check:templates",
      ),
    ).toHaveLength(1);
    expect(taskIds).not.toContain(
      "@ykdz/template-builtin-presets#check:templates:boundary",
    );
    expect(taskIds).toContain("@ykdz/template-core#build");
    expect(taskIds).toContain("@ykdz/template-builtin-presets#build");
    expect(taskIds).toContain("@ykdz/template#build");
  });

  it("builds every package without scheduling the recursive root build script", async () => {
    const result = await execa(
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=!//", "--dry-run=json"],
      { reject: true },
    );
    const actionGraph = JSON.parse(result.stdout) as {
      readonly tasks: readonly { readonly taskId: string }[];
    };
    const taskIds = actionGraph.tasks.map((task) => task.taskId);

    expect(taskIds).not.toContain("//#build");
    for (const packageName of [
      "@ykdz/template",
      "@ykdz/template-builtin-presets",
      "@ykdz/template-checks",
      "@ykdz/template-core",
      "@ykdz/template-shared",
    ]) {
      expect(taskIds).toContain(`${packageName}#build`);
    }
  });

  it("lets the public CLI prepack select itself while Turbo builds dependencies", async () => {
    const cli = await readJson<Manifest>("packages/cli/package.json");

    expect(cli.scripts.prepack).toBe("pnpm exec turbo run build --filter=.");
    expect(cli.scripts.prepack).not.toContain("@ykdz/template-core");
    expect(cli.scripts.prepack).not.toContain("@ykdz/template-builtin-presets");

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
    expect(tasks).toContain("@ykdz/template#build");
    expect(tasks).toContain("@ykdz/template-core#build");
    expect(tasks).toContain("@ykdz/template-builtin-presets#build");
  });

  it("keeps source tests build-free and orders distribution e2e through Turbo", async () => {
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

    expect(
      tasks.find(({ taskId }) => taskId === "@ykdz/template#test")
        ?.dependencies,
    ).toEqual([]);
    expect(
      tasks.find(({ taskId }) => taskId === "@ykdz/template#test:e2e")
        ?.dependencies,
    ).toContain("@ykdz/template#build");
    expect(cli.scripts["test:e2e"]).toBe(
      "node --conditions=source test/e2e/check-source-and-distribution.ts",
    );
  });
});

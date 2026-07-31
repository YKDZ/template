import assert from "node:assert/strict";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";

import type { CliJourney } from "../journey.ts";

const fallbackEnvironment = {
  TEMPLATE_TOOLCHAIN_RESOLUTION: "bundled-fallback",
};

type WorkspaceEntry = {
  readonly path: string;
  readonly mode: number;
  readonly type: "directory" | "file" | "symlink";
  readonly content?: string;
};

async function workspaceSnapshot(
  root: string,
  relative = "",
): Promise<readonly WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    const entryPath = path.join(root, child);
    const metadata = await lstat(entryPath);
    const normalizedPath = child.split(path.sep).join("/");
    if (metadata.isDirectory()) {
      entries.push({
        path: normalizedPath,
        mode: metadata.mode & 0o777,
        type: "directory",
      });
      entries.push(...(await workspaceSnapshot(root, child)));
    } else if (metadata.isSymbolicLink()) {
      entries.push({
        path: normalizedPath,
        mode: metadata.mode & 0o777,
        type: "symlink",
        content: await readlink(entryPath),
      });
    } else if (metadata.isFile()) {
      entries.push({
        path: normalizedPath,
        mode: metadata.mode & 0o777,
        type: "file",
        content: (await readFile(entryPath)).toString("base64"),
      });
    }
  }
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

function diagnosticScenario(): {
  readonly basePreset: string;
  readonly diagnosticPreset: string;
  readonly firstPackagePath: string;
  readonly secondPackagePath: string;
} {
  const context = createGenerationContext({
    targetDir: "project",
    scope: "acme",
    toolchain: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.11.0" },
  });
  const base = builtInPresetRegistry
    .all()
    .find(
      (definition) =>
        planGeneratedRepositoryInitialization({ definition, context })
          .ciDiagnosticArtifacts.length === 0,
    );
  const diagnostic = builtInPresetRegistry.all().find((definition) => {
    if (definition.planPackageAddition === undefined) return false;
    const packagePath = definition.defaultPackagePath?.({
      context,
      packageLeafName: "web",
    });
    if (packagePath === undefined) return false;
    return (
      (definition.planPackageAddition({
        context,
        packageLeafName: "web",
        packagePath,
      }).ciDiagnosticArtifacts?.length ?? 0) > 0
    );
  });
  if (base === undefined || diagnostic === undefined) {
    throw new Error(
      "diagnostic-add-package journey requires registry-derived base and diagnostic Package Addition capabilities",
    );
  }
  const firstPackagePath = diagnostic.defaultPackagePath?.({
    context,
    packageLeafName: "web",
  });
  const secondPackagePath = diagnostic.defaultPackagePath?.({
    context,
    packageLeafName: "admin",
  });
  if (firstPackagePath === undefined || secondPackagePath === undefined) {
    throw new Error(
      "diagnostic-add-package journey requires default paths for diagnostic Package Addition",
    );
  }
  return {
    basePreset: base.metadata.name,
    diagnosticPreset: diagnostic.metadata.name,
    firstPackagePath,
    secondPackagePath,
  };
}

const scenario = diagnosticScenario();

const journey: CliJourney = {
  name: "diagnostic-add-package",
  modes: ["packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    const workflow = path.join(project, ".github/workflows/check.yml");
    return [
      {
        name: "initialize no-diagnostic base",
        args: [
          "init",
          "project",
          "--preset",
          scenario.basePreset,
          "--scope",
          "acme",
          "--yes",
        ],
        env: fallbackEnvironment,
      },
      {
        name: "dry-run first diagnostic addition",
        async prepare() {
          await writeFile(
            workflow,
            `# user workflow policy\n${await readFile(workflow, "utf8")}`,
          );
          await writeFile(
            path.join(context.workDir, "before-dry-run.json"),
            JSON.stringify(await workspaceSnapshot(project)),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          scenario.diagnosticPreset,
          "--name",
          "web",
          "--path",
          scenario.firstPackagePath,
          "--dry-run",
          "--json",
        ],
        cwd: project,
        env: fallbackEnvironment,
      },
      {
        name: "apply first diagnostic addition",
        async prepare() {
          assert.deepEqual(
            await workspaceSnapshot(project),
            JSON.parse(
              await readFile(
                path.join(context.workDir, "before-dry-run.json"),
                "utf8",
              ),
            ),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          scenario.diagnosticPreset,
          "--name",
          "web",
          "--path",
          scenario.firstPackagePath,
          "--json",
        ],
        cwd: project,
        env: fallbackEnvironment,
      },
      {
        name: "JSON diagnostic overlap conflict",
        async prepare() {
          await writeFile(
            workflow,
            (await readFile(workflow, "utf8")).replace(
              `            ${scenario.firstPackagePath}`,
              `            services/custom\n            ${scenario.firstPackagePath}`,
            ),
          );
          await writeFile(
            path.join(context.workDir, "before-conflict.yml"),
            await readFile(workflow, "utf8"),
          );
          await writeFile(
            path.join(context.workDir, "before-conflict.json"),
            JSON.stringify(await workspaceSnapshot(project)),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          scenario.diagnosticPreset,
          "--name",
          "admin",
          "--path",
          scenario.secondPackagePath,
          "--json",
        ],
        cwd: project,
        env: fallbackEnvironment,
      },
      {
        name: "install generated workspace after diagnostic addition",
        async prepare() {
          assert.deepEqual(
            await workspaceSnapshot(project),
            JSON.parse(
              await readFile(
                path.join(context.workDir, "before-conflict.json"),
                "utf8",
              ),
            ),
          );
        },
        executable: "pnpm",
        args: ["install"],
        cwd: project,
      },
      {
        name: "run final generated Root Check",
        executable: "pnpm",
        args: ["run", "check"],
        cwd: project,
      },
    ];
  },
  async assertions({ context, results }) {
    const project = path.join(context.workDir, "project");
    const workflowPath = path.join(project, ".github/workflows/check.yml");
    assert.equal(results[0]?.exitCode, 0);

    const preview = JSON.parse(results[1]?.stdout ?? "") as {
      readonly status: string;
      readonly dryRun: boolean;
      readonly actions: readonly { readonly path: string }[];
    };
    assert.equal(results[1]?.exitCode, 0);
    assert.equal(preview.status, "success");
    assert.equal(preview.dryRun, true);
    assert.ok(
      preview.actions.some(
        (action) => action.path === ".github/workflows/check.yml",
      ),
    );
    assert.match(
      await readFile(workflowPath, "utf8"),
      /^# user workflow policy\n/u,
    );

    assert.equal(results[2]?.exitCode, 0);
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /^# user workflow policy\n/u);
    assert.match(
      workflow,
      /name: Run Root Check\n        run: pnpm run check/u,
    );
    assert.match(workflow, /DIAGNOSTIC_OWNER_PATHS: \|-/u);
    assert.match(workflow, new RegExp(scenario.firstPackagePath, "u"));
    assert.match(workflow, /name: Stage Root Check diagnostics/u);
    assert.match(workflow, /path: \.template-ci-diagnostics/u);

    const conflict = JSON.parse(results[3]?.stdout ?? "") as {
      readonly status: string;
      readonly actions: readonly unknown[];
      readonly conflicts: readonly {
        readonly path: string;
        readonly driver: string;
        readonly region?: unknown;
      }[];
    };
    assert.equal(results[3]?.exitCode, 1);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.actions, []);
    assert.ok(
      conflict.conflicts.some(
        (entry) =>
          entry.path === ".github/workflows/check.yml" &&
          entry.driver === "text" &&
          entry.region !== undefined,
      ),
    );
    assert.equal(
      await readFile(workflowPath, "utf8"),
      await readFile(path.join(context.workDir, "before-conflict.yml"), "utf8"),
    );
    assert.equal(results[4]?.exitCode, 0);
    assert.equal(results[5]?.exitCode, 0);
  },
};

export default journey;

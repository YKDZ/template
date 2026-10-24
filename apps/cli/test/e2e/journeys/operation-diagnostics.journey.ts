import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney, CliJourneyCommand } from "../journey.ts";

async function snapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await snapshot(root, child)));
    } else if (entry.isFile()) {
      files.push({
        path: child.split(path.sep).join("/"),
        content: (await readFile(path.join(root, child))).toString("base64"),
      });
    }
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

const journey: CliJourney = {
  name: "operation-diagnostics",
  modes: ["source", "distribution"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "binding-project");
    const snapshotPath = path.join(context.workDir, "binding-before-add.json");
    const commands: CliJourneyCommand[] = [
      {
        name: "创建必要绑定反例项目",
        args: [
          "init",
          "binding-project",
          "--preset",
          "ts-lib",
          "--scope",
          "acme",
        ],
      },
      {
        name: "必要绑定缺失时运行实际 CLI 加包进程",
        cwd: project,
        async prepare() {
          const generationPath = path.join(
            project,
            ".template/generation.json",
          );
          const generation = JSON.parse(
            await readFile(generationPath, "utf8"),
          ) as {
            readonly packages: {
              readonly contentIdentity: { readonly packageName: string };
              readonly packageDefinitionId: string;
              readonly dependencyBindings: Record<string, string>;
            }[];
          };
          const library = generation.packages.find(
            (record) =>
              record.contentIdentity.packageName === "@ykdz/reference-ts-lib",
          );
          const configuration = generation.packages.find(
            (record) =>
              record.contentIdentity.packageName ===
              "@ykdz/reference-tooling-config",
          );
          if (library === undefined || configuration === undefined) {
            throw new Error("生成记录缺少预期的共享配置包实例");
          }
          const configurationKey = Object.entries(
            library.dependencyBindings,
          ).find(
            ([, packageDefinitionId]) =>
              packageDefinitionId === configuration.packageDefinitionId,
          )?.[0];
          if (configurationKey === undefined) {
            throw new Error("生成记录没有共享配置包绑定");
          }
          delete library.dependencyBindings[configurationKey];
          await writeFile(
            generationPath,
            `${JSON.stringify(generation, null, 2)}\n`,
          );
          await writeFile(
            snapshotPath,
            JSON.stringify(await snapshot(project)),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          "ts-lib",
          "--name",
          "rejected",
          "--path",
          "packages/rejected",
        ],
      },
    ];
    return commands;
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr);
    const bindingFailure = results[1];
    assert.equal(bindingFailure?.exitCode, 1);
    assert.equal(bindingFailure?.stdout, "");
    const bindingEnvelope = JSON.parse(bindingFailure?.stderr ?? "");
    assert.equal(bindingEnvelope.variant, "operationFailed");
    assert.match(bindingEnvelope.data.error.message, /生成记录.*依赖绑定/u);
    assert.match(bindingEnvelope.data.error.suggestion, /配置.*目录/u);
    assert.doesNotMatch(
      bindingEnvelope.data.error.message,
      /file:\/\/|\/(?:tmp|workspaces|root)\//u,
    );
    const project = path.join(context.workDir, "binding-project");
    assert.deepEqual(
      await snapshot(project),
      JSON.parse(
        await readFile(
          path.join(context.workDir, "binding-before-add.json"),
          "utf8",
        ),
      ),
    );
    await assert.rejects(stat(path.join(project, "packages/rejected")), {
      code: "ENOENT",
    });
  },
};

export default journey;

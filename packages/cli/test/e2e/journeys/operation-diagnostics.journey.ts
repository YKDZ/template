import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentIdentityKey } from "@ykdz/template-core/content-identity";

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

const configurationIdentity = {
  namespace: "ykdz",
  packageName: "@ykdz/reference-tooling-config",
  exportPath: "./template",
} as const;
const configurationKey = contentIdentityKey(configurationIdentity);

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
              readonly bindings: Record<string, string>;
            }[];
          };
          const library = generation.packages.find(
            (record) =>
              record.contentIdentity.packageName === "@ykdz/reference-ts-lib",
          );
          assert.notEqual(library, undefined);
          assert.ok(Object.hasOwn(library!.bindings, configurationKey));
          delete library!.bindings[configurationKey];
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
    assert.equal(bindingEnvelope.data.phase, "metadata");
    assert.match(
      bindingEnvelope.data.error.message,
      /@ykdz\/reference-ts-lib.*缺少必要实例绑定.*@ykdz\/reference-tooling-config/u,
    );
    assert.match(bindingEnvelope.data.error.suggestion, /生成记录|包绑定/u);
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

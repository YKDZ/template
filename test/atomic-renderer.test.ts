import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { materializeProjectProjection } from "@ykdz/template-core/project-projection";
import {
  createAtomicProjectRenderer,
  createTemplateSourceHandle,
  renderProject,
  type RenderOperation,
} from "@ykdz/template-core/renderer";

void describe("atomic renderer", () => {
  void it("commits only planned paths and rolls them all back after a commit failure", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-atomic-rollback-"),
    );
    const committedPaths: string[] = [];

    try {
      await Promise.all([
        writeFile(path.join(targetRoot, "first.json"), '{"state":"before"}\n'),
        writeFile(path.join(targetRoot, "second.json"), '{"state":"before"}\n'),
        writeFile(path.join(targetRoot, "unplanned.txt"), "untouched\n"),
      ]);
      const renderAtomically = createAtomicProjectRenderer({
        async commitPath(options) {
          committedPaths.push(options.relativePath);
          if (options.relativePath === "second.json") {
            throw new Error("injected commit failure");
          }
          await options.commit();
        },
      });

      await assert.rejects(
        renderAtomically({
          targetRoot,
          operations: [
            {
              kind: "writeJson",
              to: "first.json",
              value: { state: "after" },
              overwrite: true,
            },
            {
              kind: "writeJson",
              to: "second.json",
              value: { state: "after" },
              overwrite: true,
            },
          ],
        }),
        (error: unknown) =>
          error instanceof Error &&
          /injected commit failure/u.test(error.message),
      );

      assert.equal(
        await readFile(path.join(targetRoot, "first.json"), "utf8"),
        '{"state":"before"}\n',
      );
      assert.equal(
        await readFile(path.join(targetRoot, "second.json"), "utf8"),
        '{"state":"before"}\n',
      );
      assert.equal(
        await readFile(path.join(targetRoot, "unplanned.txt"), "utf8"),
        "untouched\n",
      );
      assert.deepEqual(committedPaths, ["first.json", "second.json"]);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("replaces variables in a checked JSON template before merging", async () => {
    const sourceRoot = await mkdtemp(
      path.join(tmpdir(), "template-json-source-"),
    );
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-json-target-"),
    );

    try {
      await Promise.all([
        writeFile(
          path.join(sourceRoot, "turbo-tasks.json"),
          `${JSON.stringify({
            tasks: {
              "{{APPLICATION}}#build": {
                dependsOn: ["{{DATABASE}}#build"],
              },
            },
          })}\n`,
        ),
        writeFile(
          path.join(sourceRoot, "static-tasks.json"),
          `${JSON.stringify({ tasks: { plain: { cache: false } } })}\n`,
        ),
        writeFile(
          path.join(targetRoot, "turbo.json"),
          `${JSON.stringify({ tasks: { build: { dependsOn: ["^build"] } } })}\n`,
        ),
      ]);

      const operation = {
        kind: "mergeJsonTemplate",
        source: createTemplateSourceHandle(sourceRoot),
        from: "turbo-tasks.json",
        to: "turbo.json",
        replacements: {
          APPLICATION: "@example/app",
          DATABASE: "@example/database",
        },
      } satisfies RenderOperation;

      await renderProject({ targetRoot, operations: [operation] });

      assert.deepStrictEqual(
        JSON.parse(await readFile(path.join(targetRoot, "turbo.json"), "utf8")),
        {
          tasks: {
            build: { dependsOn: ["^build"] },
            "@example/app#build": {
              dependsOn: ["@example/database#build"],
            },
          },
        },
      );

      await assert.rejects(
        renderProject({
          targetRoot,
          operations: [
            {
              ...operation,
              replacements: { APPLICATION: "@example/app" },
            },
          ],
        }),
        /JSON 模板缺少变量：DATABASE/u,
      );
      const projected = await materializeProjectProjection({
        operations: [operation],
      });
      const changedProjection = await materializeProjectProjection({
        operations: [
          {
            ...operation,
            replacements: {
              APPLICATION: "@example/other-app",
              DATABASE: "@example/database",
            },
          },
        ],
      });
      assert.notDeepStrictEqual(projected.entries, changedProjection.entries);

      await renderProject({
        targetRoot,
        operations: [
          {
            kind: "mergeJsonTemplate",
            source: operation.source,
            from: "static-tasks.json",
            to: "static-turbo.json",
          },
        ],
      });
      assert.deepStrictEqual(
        JSON.parse(
          await readFile(path.join(targetRoot, "static-turbo.json"), "utf8"),
        ),
        { tasks: { plain: { cache: false } } },
      );
    } finally {
      await Promise.all([
        rm(sourceRoot, { recursive: true, force: true }),
        rm(targetRoot, { recursive: true, force: true }),
      ]);
    }
  });
});

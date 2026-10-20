import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { materializeProjectProjection } from "@ykdz/template-core/project-projection";
import {
  createTemplateSourceHandle,
  renderProject,
  type RenderOperation,
} from "@ykdz/template-core/renderer";

void describe("renderer", () => {
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
          `${JSON.stringify({
            literal: "{{UNCHANGED_LITERAL}}",
            tasks: { plain: { cache: false } },
          })}\n`,
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
        {
          literal: "{{UNCHANGED_LITERAL}}",
          tasks: { plain: { cache: false } },
        },
      );
    } finally {
      await Promise.all([
        rm(sourceRoot, { recursive: true, force: true }),
        rm(targetRoot, { recursive: true, force: true }),
      ]);
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";

import { prepareDevelopmentContainerDockerfile } from "../src/development-container-tool-layer.ts";

void it("校验开发容器资源后返回普通文本操作", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "environment-dockerfile-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  try {
    await writeFile(
      path.join(sourceRoot, "base.Dockerfile"),
      "FROM node:24\nENV CI=true\n",
    );
    await writeFile(
      path.join(sourceRoot, "optional.Dockerfile"),
      "RUN corepack enable\n",
    );
    const source = createTemplateSourceHandle(sourceRoot);
    const operation = prepareDevelopmentContainerDockerfile({
      layers: [
        {
          kind: "base",
          identity: "node-pnpm",
          dockerfile: { source, from: "base.Dockerfile" },
        },
        {
          kind: "optional",
          identity: "tooling",
          dockerfile: { source, from: "optional.Dockerfile" },
        },
      ],
    });

    assert.deepStrictEqual(operation, {
      kind: "writeText",
      to: ".devcontainer/Dockerfile",
      text: "FROM node:24\nENV CI=true\n\nRUN corepack enable\n",
    });

    await writeFile(
      path.join(sourceRoot, "optional.Dockerfile"),
      "COPY hidden .\n",
    );
    assert.throws(
      () =>
        prepareDevelopmentContainerDockerfile({
          layers: [
            {
              kind: "base",
              identity: "node-pnpm",
              dockerfile: { source, from: "base.Dockerfile" },
            },
            {
              kind: "optional",
              identity: "tooling",
              dockerfile: { source, from: "optional.Dockerfile" },
            },
          ],
        }),
      /must not use Dockerfile instruction COPY/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

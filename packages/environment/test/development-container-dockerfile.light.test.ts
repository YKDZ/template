import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";

import {
  developmentContainerDockerfileFromText,
  planDevelopmentContainerToolLayersFromTexts,
  prepareDevelopmentContainerToolLayerTexts,
} from "../src/development-container-tool-layer.ts";

void it("校验开发容器资源并返回 Dockerfile 内容", async () => {
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
    const baseLayer = {
      identity: "node-pnpm",
      dockerfile: { source, from: "base.Dockerfile" },
    };
    const layers = [
      {
        identity: "tooling",
        dockerfile: { source, from: "optional.Dockerfile" },
      },
    ];
    const fragmentTexts = await prepareDevelopmentContainerToolLayerTexts({
      baseLayer,
      layers,
    });
    const plan = planDevelopmentContainerToolLayersFromTexts({
      baseLayer,
      layers,
      fragmentTexts,
    });
    const dockerfile = developmentContainerDockerfileFromText({
      layers: plan.layers,
      fragmentTexts,
    });

    assert.equal(
      dockerfile,
      "FROM node:24\nENV CI=true\n\nRUN corepack enable\n",
    );

    await writeFile(
      path.join(sourceRoot, "optional.Dockerfile"),
      "COPY hidden .\n",
    );
    await assert.rejects(async () => {
      const invalidTexts = await prepareDevelopmentContainerToolLayerTexts({
        baseLayer,
        layers,
      });
      planDevelopmentContainerToolLayersFromTexts({
        baseLayer,
        layers,
        fragmentTexts: invalidTexts,
      });
    }, /must not use Dockerfile instruction COPY/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

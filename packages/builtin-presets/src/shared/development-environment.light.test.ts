import assert from "node:assert/strict";
import { it } from "node:test";

import { materializeProjectProjection } from "@ykdz/template-core/project-projection";

import {
  builtInEditorCustomization,
  planBuiltInDevelopmentContainer,
  rustDevelopmentContainerToolLayer,
  shellCheckDevelopmentContainerToolLayer,
} from "./development-container.ts";

void it("按声明组合可独立消费的工具能力、缓存和编辑器投影", async () => {
  const plan = planBuiltInDevelopmentContainer({
    nodeVersion: "24.21.0",
    layers: [
      rustDevelopmentContainerToolLayer("1.99.0"),
      shellCheckDevelopmentContainerToolLayer(),
    ],
  });
  assert.deepStrictEqual(
    Object.fromEntries(
      plan.buildArguments.map(({ name, value }) => [name, value]),
    ),
    { NODE_VERSION: "24.21.0", RUST_TOOLCHAIN: "1.99.0" },
  );
  assert.deepStrictEqual(
    plan.mounts.map(({ source, target }) => ({ source, target })),
    [
      { source: "${devcontainerId}-pnpm-store", target: "/pnpm/store" },
      { source: "${devcontainerId}-cargo-git", target: "/usr/local/cargo/git" },
      {
        source: "${devcontainerId}-cargo-registry",
        target: "/usr/local/cargo/registry",
      },
    ],
  );
  assert.partialDeepStrictEqual(plan.features, {
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {},
  });
  assert.ok(
    plan.probes.some(
      ({ command, args }) => command === "cargo" && args?.[0] === "fmt",
    ),
  );
  assert.ok(
    plan.probes.some(
      ({ command, args }) => command === "cargo" && args?.[0] === "clippy",
    ),
  );
  const projection = await materializeProjectProjection({
    operations: [plan.dockerfileOperation],
  });
  const dockerfile = Buffer.from(projection.entries[0]!.content).toString(
    "utf8",
  );
  assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\}-bookworm-slim/u);
  assert.match(
    dockerfile,
    /apt-get install[^\n]*--no-install-recommends shellcheck/u,
  );
  assert.match(dockerfile, /--component rustfmt --component clippy/u);
  assert.deepStrictEqual(
    builtInEditorCustomization(["rust-tooling", "oxc-format-lint"]).extensions,
    ["oxc.oxc-vscode", "rust-lang.rust-analyzer", "tamasfe.even-better-toml"],
  );
});

void it("拒绝没有投影声明的编辑器能力", () => {
  assert.throws(
    () => builtInEditorCustomization(["oxc-format-lint", "missing-capability"]),
    /missing-capability/u,
  );
});

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";
import {
  planDevelopmentContainerToolLayersFromTexts,
  prepareDevelopmentContainerToolLayerTexts,
  type DevelopmentContainerToolLayer,
} from "@ykdz/template-environment/development-container-tool-layer";

const source = createTemplateSourceHandle(
  path.resolve("test/fixtures/development-container-tool-layers"),
);

async function planDevelopmentContainerToolLayers(options: {
  readonly baseLayer: DevelopmentContainerToolLayer;
  readonly layers?: readonly DevelopmentContainerToolLayer[];
}) {
  const fragmentTexts =
    await prepareDevelopmentContainerToolLayerTexts(options);
  return planDevelopmentContainerToolLayersFromTexts({
    ...options,
    fragmentTexts,
  });
}

function layer(
  options: Omit<DevelopmentContainerToolLayer, "dockerfile"> & {
    readonly from: string;
  },
): DevelopmentContainerToolLayer {
  const { from, ...descriptor } = options;
  return {
    ...descriptor,
    dockerfile: { source, from },
  };
}

void describe("Development Container Tool Layer Contract", () => {
  void it("plans source-backed layers and their structured capability facts", async () => {
    const plan = await planDevelopmentContainerToolLayers({
      baseLayer: layer({
        identity: "node-pnpm",
        from: "base.Dockerfile",
        buildArguments: [{ name: "NODE_VERSION", value: "24" }],
        mounts: [
          {
            identity: "pnpm-store",
            type: "volume",
            source: "${devcontainerId}-pnpm-store",
            target: "/pnpm/store",
          },
        ],
        probes: [
          {
            identity: "pnpm",
            command: "pnpm",
            args: ["--version"],
          },
        ],
      }),
      layers: [
        layer({
          identity: "rust",
          from: "rust.Dockerfile",
          requires: ["node-pnpm"],
          buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
          probes: [
            {
              identity: "cargo",
              command: "cargo",
              args: ["--version"],
            },
          ],
        }),
      ],
    });

    assert.deepStrictEqual(
      plan.layers.map(({ identity }) => identity),
      ["node-pnpm", "rust"],
    );
    assert.deepStrictEqual(plan.buildArguments, [
      { name: "NODE_VERSION", value: "24" },
      { name: "RUST_TOOLCHAIN", value: "stable" },
    ]);
    assert.deepStrictEqual(plan.mounts, [
      {
        identity: "pnpm-store",
        type: "volume",
        source: "${devcontainerId}-pnpm-store",
        target: "/pnpm/store",
      },
    ]);
    assert.deepStrictEqual(
      plan.probes.map(({ identity }) => identity),
      ["pnpm", "cargo"],
    );
  });

  for (const [instruction, from] of [
    ["COPY", "hidden-copy.Dockerfile"],
    ["ADD", "hidden-add-backtick.Dockerfile"],
  ] as const) {
    void it(`rejects a hidden ${instruction} instruction reconstructed from logical lines`, async () => {
      await assert.rejects(
        planDevelopmentContainerToolLayers({
          baseLayer: layer({
            identity: "node-pnpm",
            from: "base.Dockerfile",
          }),
          layers: [
            layer({
              identity: `hidden-${instruction.toLowerCase()}`,
              from,
            }),
          ],
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `must not use Dockerfile instruction ${instruction}; allowed instructions are ARG, ENV, and RUN.`,
          ),
      );
    });
  }

  void it("orders equivalent dependency graphs independently of registration order", async () => {
    const descriptors = [
      layer({
        identity: "zeta",
        from: "run-only.Dockerfile",
      }),
      layer({
        identity: "cargo-tools",
        from: "run-only.Dockerfile",
        requires: ["rust"],
      }),
      layer({
        identity: "rust",
        from: "rust.Dockerfile",
        requires: ["node-pnpm"],
        buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
      }),
      layer({
        identity: "alpha",
        from: "run-only.Dockerfile",
      }),
    ];
    const plan = (layers: readonly DevelopmentContainerToolLayer[]) =>
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
        }),
        layers,
      });

    const [forward, reverse] = await Promise.all([
      plan(descriptors),
      plan(descriptors.toReversed()),
    ]);

    assert.deepStrictEqual(
      forward.layers.map(({ identity }) => identity),
      ["node-pnpm", "alpha", "rust", "cargo-tools", "zeta"],
    );
    assert.deepStrictEqual(
      reverse.layers.map(({ identity }) => identity),
      forward.layers.map(({ identity }) => identity),
    );
  });

  void it("deduplicates equivalent normalized layer identities", async () => {
    const first = layer({
      identity: "rust",
      from: "rust.Dockerfile",
      requires: ["node-pnpm"],
      buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
      probes: [
        { identity: "rustc", command: "rustc" },
        { identity: "cargo", command: "cargo", args: ["--version"] },
      ],
    });
    const equivalent = layer({
      identity: "rust",
      from: "rust.Dockerfile",
      requires: ["node-pnpm"],
      buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
      probes: [
        { identity: "cargo", command: "cargo", args: ["--version"] },
        { identity: "rustc", command: "rustc", args: [] },
      ],
    });

    const plan = await planDevelopmentContainerToolLayers({
      baseLayer: layer({
        identity: "node-pnpm",
        from: "base.Dockerfile",
      }),
      layers: [first, equivalent],
    });

    assert.deepStrictEqual(
      plan.layers.map(({ identity }) => identity),
      ["node-pnpm", "rust"],
    );
    assert.deepStrictEqual(
      plan.probes.map(({ identity }) => identity),
      ["cargo", "rustc"],
    );
  });

  void it("rejects conflicting reuse of a stable layer identity", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
        }),
        layers: [
          layer({
            identity: "rust",
            from: "rust.Dockerfile",
            buildArguments: [{ name: "RUST_TOOLCHAIN", value: "stable" }],
          }),
          layer({
            identity: "rust",
            from: "rust.Dockerfile",
            buildArguments: [{ name: "RUST_TOOLCHAIN", value: "nightly" }],
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer identity rust has conflicting descriptors.",
        ),
    );
  });

  void it("rejects a missing layer dependency by identity", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
        }),
        layers: [
          layer({
            identity: "rust",
            from: "rust.Dockerfile",
            requires: ["system-packages"],
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer rust requires missing layer system-packages.",
        ),
    );
  });

  void it("rejects dependencies declared by the unique base foundation", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
          requires: ["system-packages"],
        }),
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer node-pnpm is the base foundation and must not require other layers.",
        ),
    );
  });

  void it("rejects dependency cycles", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
        }),
        layers: [
          layer({
            identity: "alpha",
            from: "run-only.Dockerfile",
            requires: ["beta"],
          }),
          layer({
            identity: "beta",
            from: "run-only.Dockerfile",
            requires: ["alpha"],
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer dependency cycle involves: alpha, beta.",
        ),
    );
  });

  void it("rejects build-argument ownership collisions", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
          buildArguments: [{ name: "NODE_VERSION", value: "24" }],
        }),
        layers: [
          layer({
            identity: "duplicate-node",
            from: "duplicate-node-arg.Dockerfile",
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer build argument NODE_VERSION is declared by both node-pnpm and duplicate-node.",
        ),
    );
  });

  void it("rejects duplicate build arguments within one layer", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
          buildArguments: [
            { name: "NODE_VERSION", value: "22" },
            { name: "NODE_VERSION", value: "24" },
          ],
        }),
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer node-pnpm declares build argument NODE_VERSION more than once.",
        ),
    );
  });

  void it("rejects environment ownership collisions", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
        }),
        layers: [
          layer({
            identity: "duplicate-pnpm-environment",
            from: "duplicate-pnpm-env.Dockerfile",
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer environment PNPM_HOME is declared by both node-pnpm and duplicate-pnpm-environment.",
        ),
    );
  });

  void it("rejects mount target collisions", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
          mounts: [
            {
              identity: "pnpm-store",
              type: "volume",
              source: "${devcontainerId}-pnpm",
              target: "/cache",
            },
          ],
        }),
        layers: [
          layer({
            identity: "rust",
            from: "rust.Dockerfile",
            mounts: [
              {
                identity: "cargo-registry",
                type: "volume",
                source: "${devcontainerId}-cargo",
                target: "/cache",
              },
            ],
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer mount target /cache is declared by both node-pnpm and rust.",
        ),
    );
  });

  void it("requires the base layer to establish exactly one image", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "no-from.Dockerfile",
        }),
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer node-pnpm base fragment no-from.Dockerfile must contain exactly one FROM instruction; found 0.",
        ),
    );
  });

  for (const [instruction, from] of [
    ["FROM", "optional-from.Dockerfile"],
    ["SHELL", "optional-shell.Dockerfile"],
  ] as const) {
    void it(`reserves the ${instruction} instruction for the base layer`, async () => {
      await assert.rejects(
        planDevelopmentContainerToolLayers({
          baseLayer: layer({
            identity: "node-pnpm",
            from: "base.Dockerfile",
          }),
          layers: [
            layer({
              identity: `forbidden-${instruction.toLowerCase()}`,
              from,
            }),
          ],
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(
            `must not use Dockerfile instruction ${instruction}`,
          ),
      );
    });
  }

  void it("rejects legacy non-Dockerfile fragment paths", async () => {
    await assert.rejects(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
        }),
        layers: [
          layer({
            identity: "legacy-inline-fragment",
            from: "legacy-fragment.txt",
          }),
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Development Container Tool Layer legacy-inline-fragment must reference checked .Dockerfile template source; received legacy-fragment.txt.",
        ),
    );
  });
});

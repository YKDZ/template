import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  planDevelopmentContainerToolLayers,
  type DevelopmentContainerToolLayer,
} from "#template-core/development-container-tool-layer";
import {
  createTemplateSourceHandle,
  renderProject,
} from "#template-core/renderer";

const source = createTemplateSourceHandle(
  path.resolve("test/fixtures/development-container-tool-layers"),
);

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

describe("Development Container Tool Layer Contract", () => {
  it("plans source-backed layers and their structured capability facts", async () => {
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

    expect(plan.layers.map(({ identity }) => identity)).toEqual([
      "node-pnpm",
      "rust",
    ]);
    expect(plan.buildArguments).toEqual([
      { name: "NODE_VERSION", value: "24" },
      { name: "RUST_TOOLCHAIN", value: "stable" },
    ]);
    expect(plan.mounts).toEqual([
      {
        identity: "pnpm-store",
        type: "volume",
        source: "${devcontainerId}-pnpm-store",
        target: "/pnpm/store",
      },
    ]);
    expect(plan.probes.map(({ identity }) => identity)).toEqual([
      "pnpm",
      "cargo",
    ]);
  });

  it.each([
    ["COPY", "hidden-copy.Dockerfile"],
    ["ADD", "hidden-add-backtick.Dockerfile"],
  ])(
    "rejects a hidden %s instruction reconstructed from logical lines",
    async (instruction, from) => {
      await expect(
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
      ).rejects.toThrow(
        `must not use Dockerfile instruction ${instruction}; allowed instructions are ARG, ENV, and RUN.`,
      );
    },
  );

  it("validates current Dockerfile fragment operations before writing generated files", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-development-container-tool-layer-"),
    );
    const earlierGeneratedFile = path.join(targetRoot, "generated-first.txt");
    const dockerfilePath = path.join(targetRoot, ".devcontainer/Dockerfile");

    try {
      await expect(
        renderProject({
          targetRoot,
          operations: [
            {
              kind: "writeText",
              to: "generated-first.txt",
              text: "must not be written\n",
            },
            {
              kind: "writeTextFromFragments",
              to: ".devcontainer/Dockerfile",
              validation: "development-container-dockerfile",
              fragments: [
                { source, from: "base.Dockerfile" },
                { source, from: "hidden-copy.Dockerfile" },
              ],
            },
          ],
        }),
      ).rejects.toThrow(
        "must not use Dockerfile instruction COPY; allowed instructions are ARG, ENV, and RUN.",
      );
      await expect(access(earlierGeneratedFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(dockerfilePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("orders equivalent dependency graphs independently of registration order", async () => {
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

    expect(forward.layers.map(({ identity }) => identity)).toEqual([
      "node-pnpm",
      "alpha",
      "rust",
      "cargo-tools",
      "zeta",
    ]);
    expect(reverse.layers.map(({ identity }) => identity)).toEqual(
      forward.layers.map(({ identity }) => identity),
    );
  });

  it("deduplicates equivalent normalized layer identities", async () => {
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

    expect(plan.layers.map(({ identity }) => identity)).toEqual([
      "node-pnpm",
      "rust",
    ]);
    expect(plan.probes.map(({ identity }) => identity)).toEqual([
      "cargo",
      "rustc",
    ]);
  });

  it("rejects conflicting reuse of a stable layer identity", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer identity rust has conflicting descriptors.",
    );
  });

  it("rejects a missing layer dependency by identity", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer rust requires missing layer system-packages.",
    );
  });

  it("rejects dependencies declared by the unique base foundation", async () => {
    await expect(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "base.Dockerfile",
          requires: ["system-packages"],
        }),
      }),
    ).rejects.toThrow(
      "Development Container Tool Layer node-pnpm is the base foundation and must not require other layers.",
    );
  });

  it("rejects dependency cycles", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer dependency cycle involves: alpha, beta.",
    );
  });

  it("rejects build-argument ownership collisions", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer build argument NODE_VERSION is declared by both node-pnpm and duplicate-node.",
    );
  });

  it("rejects duplicate build arguments within one layer", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer node-pnpm declares build argument NODE_VERSION more than once.",
    );
  });

  it("rejects environment ownership collisions", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer environment PNPM_HOME is declared by both node-pnpm and duplicate-pnpm-environment.",
    );
  });

  it("rejects mount target collisions", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer mount target /cache is declared by both node-pnpm and rust.",
    );
  });

  it("requires the base layer to establish exactly one image", async () => {
    await expect(
      planDevelopmentContainerToolLayers({
        baseLayer: layer({
          identity: "node-pnpm",
          from: "no-from.Dockerfile",
        }),
      }),
    ).rejects.toThrow(
      "Development Container Tool Layer node-pnpm base fragment no-from.Dockerfile must contain exactly one FROM instruction; found 0.",
    );
  });

  it.each([
    ["FROM", "optional-from.Dockerfile"],
    ["SHELL", "optional-shell.Dockerfile"],
  ])(
    "reserves the %s instruction for the base layer",
    async (instruction, from) => {
      await expect(
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
      ).rejects.toThrow(`must not use Dockerfile instruction ${instruction}`);
    },
  );

  it("rejects legacy non-Dockerfile fragment paths", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Development Container Tool Layer legacy-inline-fragment must reference checked .Dockerfile template source; received legacy-fragment.txt.",
    );
  });
});

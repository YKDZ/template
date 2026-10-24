import assert from "node:assert/strict";
import { it } from "node:test";

import { composeApplicationRequirements } from "../src/application-requirements.ts";

void it("合并相同的Rust需求并指出冲突来源", () => {
  const rustToolchain = {
    toolchain: "1.98.0",
    components: ["rustfmt", "clippy"],
    configurationText:
      '[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n',
  };

  assert.deepEqual(
    composeApplicationRequirements([
      { source: "Rust参考包", requirements: { rustToolchain } },
      {
        source: "Rust预设",
        requirements: { rustToolchain: { ...rustToolchain } },
      },
    ]),
    { rustToolchain },
  );
  assert.throws(
    () =>
      composeApplicationRequirements([
        { source: "Rust参考包", requirements: { rustToolchain } },
        {
          source: "Rust预设",
          requirements: {
            rustToolchain: { ...rustToolchain, toolchain: "1.97.0" },
          },
        },
      ]),
    /工作区 Rust 工具链要求冲突：来源 Rust参考包 与 Rust预设/u,
  );
});

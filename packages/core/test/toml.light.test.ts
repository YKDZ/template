import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectTomlStringValues } from "../src/toml.ts";

void describe("原生 TOML 字符串投影", () => {
  void it("更新 Cargo 身份和工具链时保留注释、数组及无关包", () => {
    const source = `# Cargo owns this file.
[toolchain]
channel = 'stable' # follow the root
components = ["rustfmt", "clippy"]

[[package]]
name = "anyhow"
version = "1.0.104"

[[package]]
name = "app" # local binary
dependencies = [
 "anyhow",
]
`;
    assert.equal(
      projectTomlStringValues(source, [
        { path: ["toolchain", "channel"], value: "1.99.0" },
        { path: ["package", 1, "name"], value: "worker" },
      ]),
      `# Cargo owns this file.
[toolchain]
channel = "1.99.0" # follow the root
components = ["rustfmt", "clippy"]

[[package]]
name = "anyhow"
version = "1.0.104"

[[package]]
name = "worker" # local binary
dependencies = [
 "anyhow",
]
`,
    );
    const identity = "[package]\n'name' = 'app' # kept\n";
    assert.equal(
      projectTomlStringValues(identity, [
        { path: ["package", "name"], value: "app" },
      ]),
      identity,
    );
  });

  void it("拒绝缺失或非字符串字段，不猜测配置位置", () => {
    for (const source of ["[toolchain]\n", "[toolchain]\nchannel = 1\n"]) {
      assert.throws(
        () =>
          projectTomlStringValues(source, [
            { path: ["toolchain", "channel"], value: "stable" },
          ]),
        /已有字符串字段/u,
      );
    }
  });
});

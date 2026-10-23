import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseRustToolchainDeclaration,
  projectRustToolchainDeclaration,
  resolveRustToolchainRequirements,
} from "@ykdz/reference-rust-bin/template";

void describe("Rust 工具链共同事实", () => {
  void it("解析 channel 与组件并保留原始声明", () => {
    const source =
      '# maintainer note\n[toolchain]\nchannel = "1.99.0" # pinned\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';

    assert.deepEqual(parseRustToolchainDeclaration(source), {
      channel: "1.99.0",
      components: ["rustfmt", "clippy"],
      declaration: source,
    });
    assert.throws(
      () => parseRustToolchainDeclaration('[toolchain]\nchannel = "   "\n'),
      /channel 必须是非空字符串/u,
    );
    assert.throws(
      () => parseRustToolchainDeclaration("[toolchain\nchannel = 'stable'\n"),
      /不是有效 TOML/u,
    );
    assert.throws(
      () =>
        parseRustToolchainDeclaration(
          '[toolchain]\nchannel = "stable"\ncomponents = "rustfmt"\n',
        ),
      /components 必须是字符串数组/u,
    );
  });

  void it("只接受兼容的 Rust 需求并在加包时保留合法根声明字节", () => {
    const configurationText =
      '[toolchain]\nchannel = "1.99.0"\ncomponents = ["rustfmt", "clippy"]\n';
    const requirement = {
      toolchain: "1.98.0",
      components: ["rustfmt", "clippy"],
      configurationText,
    };
    const existingDeclaration =
      '# user extension\n[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';

    assert.deepEqual(
      resolveRustToolchainRequirements([requirement, { ...requirement }]),
      requirement,
    );
    assert.equal(
      projectRustToolchainDeclaration({
        requirement,
        existingDeclaration,
      }),
      existingDeclaration,
    );
    assert.equal(
      projectRustToolchainDeclaration({ requirement }),
      '[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n',
    );
    assert.throws(
      () =>
        resolveRustToolchainRequirements([
          requirement,
          { ...requirement, toolchain: "1.97.0" },
        ]),
      /相互兼容/u,
    );
  });
});

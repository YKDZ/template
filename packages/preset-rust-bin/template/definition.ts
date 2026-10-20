import { referencePackage } from "@ykdz/reference-rust-bin/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";

import presetPackage from "../package.json" with { type: "json" };

export const preset = definePreset({
  metadata: {
    alias: "rust-bin",
    title: "Rust 二进制程序",
    description: "包含 rustfmt、clippy 和 cargo 测试的 Rust 原生二进制工作区。",
  },
  operations: ["init", "add"],
  owner: presetOwnerFromManifest(presetPackage),
  nodes: {
    binary: { reference: referencePackage },
  },
});

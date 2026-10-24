import { referencePackage } from "@ykdz/reference-rust-bin/template";
import {
  definePreset,
  presetOwnerFromManifest,
  type PresetDefinition,
  type PresetReference,
} from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };

const rustBinaryPreset: PresetDefinition<PresetReference> = definePreset({
  metadata: {
    alias: "rust-bin",
    title: "Rust 二进制程序",
    description: "包含 rustfmt、clippy 和 cargo 测试的 Rust 原生二进制工作区。",
  },
  operations: ["init", "add"],
  owner: presetOwnerFromManifest(presetPackage, "./template"),
  nodes: {
    binary: { reference: referencePackage },
  },
});

export const preset = defineNativeContentArtifact(rustBinaryPreset, {
  manifest: presetPackage,
  resourceRoot: new URL("../", import.meta.url),
  exportPath: "./template",
  executionDependencies: ["@ykdz/template-workspace-authoring"],
});

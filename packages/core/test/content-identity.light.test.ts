import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contentIdentityKey,
  createContentIndex,
  deriveContentMembers,
  type LoadedContentMember,
} from "../src/content-identity.ts";

type Definition = { readonly value: string };

function member(options: {
  readonly namespace: string;
  readonly packageName: string;
  readonly exportPath: string;
  readonly alias: string;
  readonly kind: "reference" | "preset";
  readonly value: string;
}): LoadedContentMember<Definition> {
  return {
    identity: {
      namespace: options.namespace,
      packageName: options.packageName,
      exportPath: options.exportPath,
    },
    kind: options.kind,
    alias: options.alias,
    definition: { value: options.value },
    source: {
      specifier: `${options.packageName}${options.exportPath === "." ? "" : options.exportPath.slice(1)}`,
      moduleURL: `file:///${options.value}.js`,
      manifestURL: `file:///${options.value}/package.json`,
    },
  };
}

void describe("规范内容身份索引", () => {
  void it("按唯一集合保留参考包和预设定义的类型关联", () => {
    const reference: LoadedContentMember<
      { readonly marker: "reference" },
      "reference"
    > = {
      ...member({
        namespace: "typed",
        packageName: "@example/reference",
        exportPath: "./template",
        alias: "reference",
        kind: "reference",
        value: "reference",
      }),
      kind: "reference",
      definition: { marker: "reference" },
    };
    const preset: LoadedContentMember<{ readonly marker: 42 }, "preset"> = {
      ...member({
        namespace: "typed",
        packageName: "@example/preset",
        exportPath: "./template",
        alias: "preset",
        kind: "preset",
        value: "preset",
      }),
      kind: "preset",
      definition: { marker: 42 },
    };
    const derived = deriveContentMembers([reference, preset] as const);
    const referenceMarker: "reference" =
      derived.referencePackages[0]!.definition.marker;
    const presetMarker: 42 = derived.presets[0]!.definition.marker;
    // @ts-expect-error 参考包派生结果不能包含预设定义。
    const invalidReference: 42 =
      derived.referencePackages[0]!.definition.marker;
    // @ts-expect-error 预设派生结果不能包含参考包定义。
    const invalidPreset: "reference" = derived.presets[0]!.definition.marker;

    assert.deepEqual(derived.referencePackages, [reference]);
    assert.deepEqual(derived.presets, [preset]);
    assert.equal(referenceMarker, "reference");
    assert.equal(presetMarker, 42);
    void invalidReference;
    void invalidPreset;
  });

  void it("使用三个身份分量编码，并按限定别名或规范身份精确选择", () => {
    const alpha = member({
      namespace: "alpha",
      packageName: "@example/shared",
      exportPath: "./template",
      alias: "shared",
      kind: "reference",
      value: "alpha",
    });
    const beta = member({
      namespace: "beta",
      packageName: "@example/shared",
      exportPath: "./template",
      alias: "shared",
      kind: "reference",
      value: "beta",
    });
    const index = createContentIndex([alpha, beta]);

    assert.strictEqual(
      contentIdentityKey(alpha.identity),
      '["alpha","@example/shared","./template"]',
    );
    assert.strictEqual(
      index.resolve({ alias: "shared", namespace: "beta" }, "reference"),
      beta,
    );
    assert.strictEqual(index.resolve(beta.identity, "reference"), beta);
  });

  void it("拒绝未限定歧义、错误种类与重复规范身份", () => {
    const reference = member({
      namespace: "first",
      packageName: "@example/content",
      exportPath: "./template",
      alias: "content",
      kind: "reference",
      value: "first",
    });
    const sameAlias = member({
      namespace: "second",
      packageName: "@example/content",
      exportPath: "./template",
      alias: "content",
      kind: "preset",
      value: "second",
    });
    const index = createContentIndex([reference, sameAlias]);

    assert.throws(() => index.resolve("content", "reference"), /歧义/u);
    assert.throws(
      () => index.resolve(sameAlias.identity, "reference"),
      /种类不符/u,
    );
    assert.throws(
      () =>
        createContentIndex([
          reference,
          {
            ...reference,
            source: { ...reference.source, moduleURL: "file:///revision.js" },
          },
        ]),
      /来源修订/u,
    );
  });

  void it("已知来源命名空间优先关联同一实际定义", () => {
    const alpha = member({
      namespace: "alpha",
      packageName: "@example/shared",
      exportPath: "./template",
      alias: "shared",
      kind: "reference",
      value: "physical-source",
    });
    const beta = {
      ...alpha,
      identity: { ...alpha.identity, namespace: "beta" },
    };
    const index = createContentIndex([alpha, beta]);

    assert.strictEqual(
      index.fromDefinition(alpha.definition, "reference", {
        namespace: "beta",
      }),
      beta,
    );
    assert.throws(
      () => index.fromDefinition(alpha.definition, "reference"),
      /属于多个命名空间/u,
    );
    assert.strictEqual(
      createContentIndex([alpha]).fromDefinition(
        alpha.definition,
        "reference",
        { namespace: "beta" },
      ),
      alpha,
    );
    const betaEntry = {
      ...beta,
      identity: { ...beta.identity, exportPath: "./another-entry" },
    };
    assert.throws(
      () =>
        createContentIndex([alpha, beta, betaEntry]).fromDefinition(
          alpha.definition,
          "reference",
          { namespace: "beta" },
        ),
      /多个规范入口/u,
    );
  });
});

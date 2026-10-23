import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProjectBlueprintDraft,
  validateProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";

const firstPackageId = `package-${"1".repeat(64)}` as const;
const secondPackageId = `package-${"2".repeat(64)}` as const;
const missingPackageId = `package-${"3".repeat(64)}` as const;

function packageDefinition(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
  packageDefinitionId = firstPackageId,
) {
  return { packageDefinitionId, name, path: packagePath, role } as const;
}

function blueprintWithPackages(
  packages: readonly unknown[],
  packageLinkIntents: readonly unknown[] = [],
) {
  return {
    schemaVersion: 4,
    packages,
    packageLinkIntents,
  } as const;
}

function blueprintWithPackage(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
) {
  return blueprintWithPackages([packageDefinition(name, packagePath, role)]);
}

void describe("项目蓝图包身份", () => {
  void it("保留通用包名称与角色，并接受安全相对路径", () => {
    const blueprint = blueprintWithPackage(
      "north:overview",
      "docs/guides/overview",
      "documentation",
    );

    assert.deepStrictEqual(validateProjectBlueprint(blueprint), {
      ok: true,
      value: blueprint,
    });
  });

  void it("要求包角色为字符串", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint(
        blueprintWithPackages([
          {
            packageDefinitionId: firstPackageId,
            name: "@demo/tool",
            path: "packages/tool",
            role: 42,
          },
        ]),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].role",
            message: "字段类型或结构不符合蓝图要求",
          },
        ],
      },
    );
  });

  for (const [field, duplicateValue, message] of [
    ["name", "@demo/tool", "软件包名称必须唯一：@demo/tool"],
    ["path", "packages/tool", "软件包路径必须唯一：packages/tool"],
  ] as const) {
    void it(`拒绝重复包${field === "name" ? "名称" : "路径"}并定位双方`, () => {
      const existing = packageDefinition("@demo/tool");
      const requested = packageDefinition(
        field === "name" ? duplicateValue : "@demo/other",
        field === "path" ? duplicateValue : "packages/other",
        "cli-tool",
        secondPackageId,
      );

      assert.deepStrictEqual(
        validateProjectBlueprint(blueprintWithPackages([existing, requested])),
        {
          ok: false,
          issues: [
            {
              path: ".packages",
              message,
              packageIdentityIssue: {
                kind: "duplicate",
                field,
                existing: {
                  name: existing.name,
                  path: existing.path,
                  role: existing.role,
                },
                requested: {
                  name: requested.name,
                  path: requested.path,
                  role: requested.role,
                },
              },
            },
          ],
        },
      );
    });
  }

  for (const [label, packageDefinitionId] of [
    ["空值", ""],
    ["短值", "package-short"],
    ["大写摘要", `package-${"G".repeat(64)}`],
  ] as const) {
    void it(`拒绝格式错误的持久实例标识：${label}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackages([
            {
              ...packageDefinition("@demo/tool"),
              packageDefinitionId,
            },
          ]),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].packageDefinitionId",
              message: "字段类型或结构不符合蓝图要求",
            },
          ],
        },
      );
    });
  }

  void it("拒绝缺失的持久实例标识", () => {
    const definition = {
      ...packageDefinition("@demo/tool"),
    } as Record<string, unknown>;
    delete definition.packageDefinitionId;

    assert.deepStrictEqual(
      validateProjectBlueprint(blueprintWithPackages([definition])),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].packageDefinitionId",
            message: "蓝图缺少必需字段",
          },
        ],
      },
    );
  });

  void it("独立拒绝重复实例标识", () => {
    const original = packageDefinition("@demo/tool");

    assert.deepStrictEqual(
      validateProjectBlueprint(
        blueprintWithPackages([
          original,
          packageDefinition(
            "@demo/other",
            "packages/other",
            "cli-tool",
            firstPackageId,
          ),
        ]),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packages[1].packageDefinitionId",
            message: `包实例标识必须唯一：${firstPackageId}`,
          },
        ],
      },
    );
  });
});

void describe("项目蓝图路径", () => {
  for (const packagePath of [
    "",
    "../escape",
    "/absolute/path",
    "C:/outside",
    "packages\\tool",
    "packages//tool",
    "packages/./tool",
    "packages/tool/",
  ]) {
    void it(`拒绝不安全相对路径 ${JSON.stringify(packagePath)}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackage("@demo/tool", packagePath),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].path",
              message: "软件包路径必须是规范化的安全相对路径",
              packageIdentityIssue: { kind: "invalid", field: "path" },
            },
          ],
        },
      );
    });
  }

  void it("在分配持久实例标识前拒绝不安全路径", () => {
    assert.throws(
      () =>
        assertProjectBlueprintDraft({
          schemaVersion: 4,
          packages: [
            {
              name: "north:overview",
              path: "../escape",
              role: "documentation",
            },
          ],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          ".packages[0].path: 软件包路径必须是规范化的安全相对路径",
        ),
    );
  });
});

void describe("项目蓝图包连接意图", () => {
  void it("接受已有实例间的显式连接", () => {
    const blueprint = blueprintWithPackages(
      [
        packageDefinition("@demo/consumer", "packages/consumer"),
        packageDefinition(
          "@demo/provider",
          "packages/provider",
          "shared-library",
          secondPackageId,
        ),
      ],
      [{ consumerId: firstPackageId, providerId: secondPackageId }],
    );

    assert.deepStrictEqual(validateProjectBlueprint(blueprint), {
      ok: true,
      value: blueprint,
    });
  });

  for (const [label, packageLinkIntents, path, message] of [
    [
      "缺失的使用方",
      [{ consumerId: missingPackageId, providerId: firstPackageId }],
      ".packageLinkIntents[0].consumerId",
      "包连接引用了不存在的使用方实例",
    ],
    [
      "缺失的提供方",
      [{ consumerId: firstPackageId, providerId: missingPackageId }],
      ".packageLinkIntents[0].providerId",
      "包连接引用了不存在的提供方实例",
    ],
    [
      "连接自身",
      [{ consumerId: firstPackageId, providerId: firstPackageId }],
      ".packageLinkIntents[0]",
      "包连接不能指向自身",
    ],
  ] as const) {
    void it(`拒绝${label}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackages(
            [packageDefinition("@demo/tool")],
            packageLinkIntents,
          ),
        ),
        { ok: false, issues: [{ path, message }] },
      );
    });
  }

  void it("拒绝重复的显式连接", () => {
    const connection = {
      consumerId: firstPackageId,
      providerId: secondPackageId,
    };
    assert.deepStrictEqual(
      validateProjectBlueprint(
        blueprintWithPackages(
          [
            packageDefinition("@demo/consumer", "packages/consumer"),
            packageDefinition(
              "@demo/provider",
              "packages/provider",
              "shared-library",
              secondPackageId,
            ),
          ],
          [connection, connection],
        ),
      ),
      {
        ok: false,
        issues: [{ path: ".packageLinkIntents[1]", message: "包连接不能重复" }],
      },
    );
  });
});

void describe("项目蓝图结构与格式", () => {
  for (const [value, path] of [
    [
      { schemaVersion: 4, packages: [42], packageLinkIntents: [] },
      ".packages[0]",
    ],
    [
      { schemaVersion: 4, packages: [], packageLinkIntents: [42] },
      ".packageLinkIntents[0]",
    ],
  ] as const) {
    void it("为结构错误指出可处理的位置", () => {
      assert.deepStrictEqual(validateProjectBlueprint(value), {
        ok: false,
        issues: [{ path, message: "字段类型或结构不符合蓝图要求" }],
      });
    });
  }

  void it("先报告结构错误，不继续执行跨文档语义校验", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 4,
        packages: [
          {
            packageDefinitionId: firstPackageId,
            name: 42,
            path: "packages/tool",
            role: "cli-tool",
          },
        ],
        packageLinkIntents: [
          { consumerId: firstPackageId, providerId: missingPackageId },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].name",
            message: "字段类型或结构不符合蓝图要求",
          },
        ],
      },
    );
  });

  void it("在嵌套持久字段拒绝未知字段", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 4,
        packages: [
          {
            ...packageDefinition("@demo/tool"),
            inferredFromManifest: true,
          },
        ],
        packageLinkIntents: [
          {
            consumerId: firstPackageId,
            providerId: secondPackageId,
            inferredFromWorkspace: true,
          },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].inferredFromManifest",
            message: "蓝图 v4 包含未知字段",
          },
          {
            path: ".packageLinkIntents[0].inferredFromWorkspace",
            message: "蓝图 v4 包含未知字段",
          },
        ],
      },
    );
  });

  for (const schemaVersion of [3, 5]) {
    void it(`拒绝旧版或不支持的蓝图 schema ${schemaVersion}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint({
          schemaVersion,
          packages: [],
          packageLinkIntents: [],
        }),
        {
          ok: false,
          issues: [
            {
              path: ".schemaVersion",
              message: `不支持的本地模板元数据版本 ${schemaVersion}；当前只支持 schema4`,
            },
          ],
        },
      );
    });
  }

  void it("拒绝蓝图未拥有的根字段", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 4,
        packages: [],
        packageLinkIntents: [],
        repositoryName: "not-blueprint-owned",
      }),
      {
        ok: false,
        issues: [{ path: ".repositoryName", message: "蓝图 v4 包含未知字段" }],
      },
    );
  });
});

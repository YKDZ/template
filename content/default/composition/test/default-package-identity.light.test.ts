import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProjectBlueprintValidationError } from "@ykdz/template-core/project-blueprint";
import {
  assertDefaultProjectBlueprintDraft,
  isValidDefaultNpmPackageName,
  validateDefaultPackagePath,
  validateDefaultProjectBlueprint,
} from "@ykdz/template-workspace/default-package-identity";

const packageDefinitionId = `package-${"1".repeat(64)}` as const;

function blueprintWithPackage(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
) {
  return {
    schemaVersion: 4,
    packages: [{ packageDefinitionId, name, path: packagePath, role }],
    packageLinkIntents: [],
  } as const;
}

void describe("默认策略包名合同", () => {
  void it("保留 npm 包名长度边界和 Node 内置模块保留规则", () => {
    assert.strictEqual(isValidDefaultNpmPackageName("a".repeat(214)), true);
    assert.strictEqual(isValidDefaultNpmPackageName("a".repeat(215)), false);
    assert.strictEqual(
      isValidDefaultNpmPackageName(`@s/${"a".repeat(211)}`),
      true,
    );
    assert.strictEqual(
      isValidDefaultNpmPackageName(`@s/${"a".repeat(212)}`),
      false,
    );
    assert.strictEqual(isValidDefaultNpmPackageName("http"), false);
    assert.strictEqual(isValidDefaultNpmPackageName("@acme/http"), true);
  });

  for (const name of [
    "some-package",
    "example.com",
    "under_score",
    "123numeric",
    "@npm/thingy",
    "@jane/foo.js",
    "@scope/_hidden",
    "@scope/-hidden",
  ]) {
    void it(`接受默认策略 npm 名称 ${name}`, () => {
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(blueprintWithPackage(name)),
        {
          ok: true,
          value: blueprintWithPackage(name),
        },
      );
    });
  }

  for (const name of [
    "Uppercase",
    "@scope/Uppercase",
    " leading-space",
    "trailing-space ",
    "contain:colons",
    "excited!",
    ".hidden",
    "_hidden",
    "-hidden",
    "@scope/.hidden",
    "node_modules",
    "http",
    "inspector",
    "@scope",
    "@scope/",
    "@scope/name/extra",
    `@scope/${"a".repeat(208)}`,
  ]) {
    void it(`拒绝默认策略 npm 名称 ${name}`, () => {
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(blueprintWithPackage(name)),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].name",
              message:
                "Package name must be a valid npm package name for new packages",
              packageIdentityIssue: { kind: "invalid", field: "name" },
            },
          ],
        },
      );
    });
  }
});

void describe("默认策略包角色与目录合同", () => {
  for (const role of [
    "cli-tool",
    "runtime-service",
    "shared-library",
    "native-package",
  ]) {
    void it(`接受默认角色 ${role}`, () => {
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(
          blueprintWithPackage("@demo/tool", "packages/tool", role),
        ),
        {
          ok: true,
          value: blueprintWithPackage("@demo/tool", "packages/tool", role),
        },
      );
    });
  }

  void it("拒绝默认策略不支持的角色", () => {
    assert.deepStrictEqual(
      validateDefaultProjectBlueprint(
        blueprintWithPackage("@demo/tool", "packages/tool", "documentation"),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].role",
            message:
              "Package Role must be cli-tool, runtime-service, shared-library, or native-package",
          },
        ],
      },
    );
  });

  void it("保留默认两段包路径并单独报告保留工作区目录", () => {
    assert.deepStrictEqual(validateDefaultPackagePath("packages/tool"), {
      hasValidShape: true,
    });
    assert.deepStrictEqual(validateDefaultPackagePath("packages/nested/tool"), {
      hasValidShape: false,
    });
    assert.deepStrictEqual(validateDefaultPackagePath(".git/tool"), {
      hasValidShape: false,
      reservedWorkspaceCollection: ".git",
    });
  });

  for (const workspaceCollection of [
    ".git",
    ".github",
    ".devcontainer",
    ".template",
    "node_modules",
    "dist",
    "target",
  ]) {
    void it(`拒绝默认策略保留目录 ${workspaceCollection}`, () => {
      const packagePath = `${workspaceCollection}/evil`;
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(
          blueprintWithPackage("@demo/evil", packagePath, "shared-library"),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].path",
              message: `Package Path ${packagePath} uses reserved workspace collection ${workspaceCollection}`,
              packageIdentityIssue: { kind: "reserved", field: "path" },
            },
          ],
        },
      );
    });
  }

  void it("在默认策略初始化前拒绝保留工作区目录", () => {
    assert.throws(
      () =>
        assertDefaultProjectBlueprintDraft({
          schemaVersion: 4,
          packages: [
            {
              name: "@demo/evil",
              path: "dist/evil",
              role: "shared-library",
            },
          ],
        }),
      (error) => {
        if (!(error instanceof ProjectBlueprintValidationError)) return false;
        assert.deepStrictEqual(error.packageIdentityIssues, [
          { kind: "reserved", field: "path" },
        ]);
        return error.message.includes(
          ".packages[0].path: Package Path dist/evil uses reserved workspace collection dist",
        );
      },
    );
  });
});

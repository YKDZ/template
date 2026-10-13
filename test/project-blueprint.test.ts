import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProjectBlueprintDraft,
  isValidNewNpmPackageName,
  validateNewPackagePath,
  validateProjectBlueprint,
} from "../packages/core/src/project-blueprint.ts";

const packageDefinitionId = `package-${"1".repeat(64)}` as const;

function blueprintWithPackage(name: string) {
  return {
    schemaVersion: 3,
    packages: [
      {
        packageDefinitionId,
        name,
        path: "packages/tool",
        role: "cli-tool",
      },
    ],
  } as const;
}

void describe("Project Blueprint v3 Package Definitions", () => {
  void it("exposes the canonical npm package-name length boundary", () => {
    assert.strictEqual(isValidNewNpmPackageName("a".repeat(214)), true);
    assert.strictEqual(isValidNewNpmPackageName("a".repeat(215)), false);
    assert.strictEqual(isValidNewNpmPackageName(`@s/${"a".repeat(211)}`), true);
    assert.strictEqual(
      isValidNewNpmPackageName(`@s/${"a".repeat(212)}`),
      false,
    );
  });

  void it("distinguishes a reserved unscoped name from its valid scoped form", () => {
    assert.strictEqual(isValidNewNpmPackageName("http"), false);
    assert.strictEqual(isValidNewNpmPackageName("@acme/http"), true);
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
    void it(`accepts the npm new-package name ${name}`, () => {
      const blueprint = blueprintWithPackage(name);

      assert.deepStrictEqual(validateProjectBlueprint(blueprint), {
        ok: true,
        value: blueprint,
      });
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
    void it(`rejects the npm new-package name ${name}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(blueprintWithPackage(name)),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].name",
              message:
                "Package name must be a valid npm package name for new packages",
            },
          ],
        },
      );
    });
  }

  void it("accepts the CLI Tool Package Role as a distinct Package Definition intent", () => {
    const blueprint = blueprintWithPackage("@demo/tool");

    assert.deepStrictEqual(validateProjectBlueprint(blueprint), {
      ok: true,
      value: blueprint,
    });
  });

  void it("reports every supported role when an unknown Package Role is persisted", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [
          {
            packageDefinitionId,
            name: "@demo/tool",
            path: "packages/tool",
            role: "command",
          },
        ],
      }),
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

  for (const [property, value, message] of [
    ["name", "@demo/tool", "Package name must be unique: @demo/tool"],
    ["path", "packages/tool", "Package Path must be unique: packages/tool"],
  ] as const) {
    void it(`rejects duplicate Package Definition ${property}`, () => {
      const original = blueprintWithPackage("@demo/tool");
      const duplicate = {
        ...original.packages[0],
        packageDefinitionId: `package-${"2".repeat(64)}`,
        name: property === "name" ? value : "@demo/other",
        path: property === "path" ? value : "packages/other",
      };

      assert.deepStrictEqual(
        validateProjectBlueprint({
          ...original,
          packages: [...original.packages, duplicate],
        }),
        {
          ok: false,
          issues: [{ path: ".packages", message }],
        },
      );
    });
  }

  for (const [id, message] of [
    [undefined, "Package Definition ID must use the package-<sha256> format"],
    ["", "Package Definition ID must use the package-<sha256> format"],
    [
      "package-short",
      "Package Definition ID must use the package-<sha256> format",
    ],
    [
      `package-${"G".repeat(64)}`,
      "Package Definition ID must use the package-<sha256> format",
    ],
  ] as const) {
    void it(`rejects the invalid persisted Package Definition ID ${id}`, () => {
      const definition = {
        ...blueprintWithPackage("@demo/tool").packages[0],
      } as {
        packageDefinitionId?: string;
      } & Record<string, unknown>;
      if (id === undefined) delete definition.packageDefinitionId;
      else definition.packageDefinitionId = id;

      assert.deepStrictEqual(
        validateProjectBlueprint({ schemaVersion: 3, packages: [definition] }),
        {
          ok: false,
          issues: [{ path: ".packages[0].packageDefinitionId", message }],
        },
      );
    });
  }

  void it("rejects duplicate opaque Package Definition IDs independently of names and paths", () => {
    const original = blueprintWithPackage("@demo/tool").packages[0];

    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [
          original,
          {
            ...original,
            name: "@demo/other",
            path: "packages/other",
          },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages",
            message: `Package Definition ID must be unique: ${packageDefinitionId}`,
          },
        ],
      },
    );
  });
});

void describe("Project Blueprint v3 Package Paths", () => {
  void it("exposes canonical Package Path shape and reservation facts", () => {
    assert.deepStrictEqual(validateNewPackagePath("packages/tool"), {
      hasValidShape: true,
    });
    assert.deepStrictEqual(validateNewPackagePath("packages/nested/tool"), {
      hasValidShape: false,
    });
    assert.deepStrictEqual(validateNewPackagePath(".git/tool"), {
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
    void it(`rejects the ADR0063 reserved workspace collection ${workspaceCollection}`, () => {
      const packagePath = `${workspaceCollection}/evil`;

      assert.deepStrictEqual(
        validateProjectBlueprint({
          schemaVersion: 3,
          packages: [
            {
              packageDefinitionId,
              name: "@demo/evil",
              path: packagePath,
              role: "shared-library",
            },
          ],
        }),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].path",
              message: `Package Path ${packagePath} uses reserved workspace collection ${workspaceCollection}`,
            },
          ],
        },
      );
    });
  }
});

void describe("Project Blueprint draft semantics", () => {
  void it("rejects invalid preset topology before Foundation assigns durable identity", () => {
    assert.throws(
      () =>
        assertProjectBlueprintDraft({
          schemaVersion: 3,
          packages: [
            {
              name: "@demo/evil",
              path: "dist/evil",
              role: "shared-library",
            },
          ],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          ".packages[0].path: Package Path dist/evil uses reserved workspace collection dist",
        ),
    );
  });
});

void describe("Project Blueprint v3 schema", () => {
  for (const [value, path, message] of [
    [
      { schemaVersion: 3, packages: [42] },
      ".packages[0]",
      "Package Definition must be an object",
    ],
    [
      { schemaVersion: 3, packages: [], packageLinkIntents: [42] },
      ".packageLinkIntents[0]",
      "Package Link Intent must be an object",
    ],
  ] as const) {
    void it("preserves actionable object diagnostics", () => {
      assert.deepStrictEqual(validateProjectBlueprint(value), {
        ok: false,
        issues: [{ path, message }],
      });
    });
  }

  void it("reports structural issues before running cross-document semantics", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [
          {
            packageDefinitionId,
            name: 42,
            path: "packages/tool",
            role: "cli-tool",
          },
        ],
        packageLinkIntents: [
          {
            consumerPackagePath: "packages/tool",
            providerPackagePath: "packages/tool",
          },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].name",
            message: "Package name must be a string",
          },
        ],
      },
    );
  });

  void it("reports strict-schema unknown fields at their deep persisted path", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [
          {
            packageDefinitionId,
            name: "@demo/tool",
            path: "packages/tool",
            role: "cli-tool",
            inferredFromManifest: true,
          },
        ],
        packageLinkIntents: [
          {
            consumerPackagePath: "packages/tool",
            providerPackagePath: "packages/tool",
            inferredFromWorkspace: true,
          },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].inferredFromManifest",
            message: "Unknown Blueprint v3 field",
          },
          {
            path: ".packageLinkIntents[0].inferredFromWorkspace",
            message: "Unknown Blueprint v3 field",
          },
        ],
      },
    );
  });

  void it("rejects the previous schema version without a compatibility reader", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({ schemaVersion: 2, packages: [] }),
      {
        ok: false,
        issues: [
          {
            path: ".schemaVersion",
            message:
              "Unsupported Local Template Metadata schema version 2; expected 3",
          },
        ],
      },
    );
  });

  void it("rejects unknown persisted fields", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [],
        repositoryName: "not-blueprint-owned",
      }),
      {
        ok: false,
        issues: [
          {
            path: ".repositoryName",
            message: "Unknown Blueprint v3 field",
          },
        ],
      },
    );
  });
});

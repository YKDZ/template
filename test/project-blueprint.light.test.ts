import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProjectBlueprintDraft,
  validateProjectBlueprint,
} from "@ykdz/template-core/project-blueprint";

const packageDefinitionId = `package-${"1".repeat(64)}` as const;

function blueprintWithPackage(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
) {
  return {
    schemaVersion: 3,
    packages: [
      {
        packageDefinitionId,
        name,
        path: packagePath,
        role,
      },
    ],
  } as const;
}

void describe("Project Blueprint v3 Package Definitions", () => {
  void it("keeps package identity and role opaque while accepting a safe nested path", () => {
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

  void it("requires a string role in the generic package shape", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [
          {
            packageDefinitionId,
            name: "@demo/tool",
            path: "packages/tool",
            role: 42,
          },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].role",
            message: "Package Role must be a string",
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
  for (const packagePath of [
    "",
    ".",
    "../escape",
    "/absolute/path",
    "C:/outside",
    "packages\\tool",
    "packages//tool",
    "packages/./tool",
    "packages/tool/",
  ]) {
    void it(`rejects unsafe relative Package Path ${JSON.stringify(packagePath)}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackage("@demo/tool", packagePath),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].path",
              message: "Package Path must be a normalized safe relative path",
            },
          ],
        },
      );
    });
  }
});

void describe("Project Blueprint draft semantics", () => {
  void it("rejects unsafe package paths before assigning durable identity", () => {
    assert.throws(
      () =>
        assertProjectBlueprintDraft({
          schemaVersion: 3,
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
          ".packages[0].path: Package Path must be a normalized safe relative path",
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

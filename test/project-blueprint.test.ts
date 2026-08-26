import { describe, expect, it } from "vitest";

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

describe("Project Blueprint v3 Package Definitions", () => {
  it("exposes the canonical npm package-name length boundary", () => {
    expect(isValidNewNpmPackageName("a".repeat(214))).toBe(true);
    expect(isValidNewNpmPackageName("a".repeat(215))).toBe(false);
    expect(isValidNewNpmPackageName(`@s/${"a".repeat(211)}`)).toBe(true);
    expect(isValidNewNpmPackageName(`@s/${"a".repeat(212)}`)).toBe(false);
  });

  it("distinguishes a reserved unscoped name from its valid scoped form", () => {
    expect(isValidNewNpmPackageName("http")).toBe(false);
    expect(isValidNewNpmPackageName("@acme/http")).toBe(true);
  });

  it.each([
    "some-package",
    "example.com",
    "under_score",
    "123numeric",
    "@npm/thingy",
    "@jane/foo.js",
    "@scope/_hidden",
    "@scope/-hidden",
  ])("accepts the npm new-package name %s", (name) => {
    const blueprint = blueprintWithPackage(name);

    expect(validateProjectBlueprint(blueprint)).toEqual({
      ok: true,
      value: blueprint,
    });
  });

  it.each([
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
  ])("rejects the npm new-package name %s", (name) => {
    expect(validateProjectBlueprint(blueprintWithPackage(name))).toEqual({
      ok: false,
      issues: [
        {
          path: ".packages[0].name",
          message:
            "Package name must be a valid npm package name for new packages",
        },
      ],
    });
  });

  it("accepts the CLI Tool Package Role as a distinct Package Definition intent", () => {
    const blueprint = blueprintWithPackage("@demo/tool");

    expect(validateProjectBlueprint(blueprint)).toEqual({
      ok: true,
      value: blueprint,
    });
  });

  it("reports every supported role when an unknown Package Role is persisted", () => {
    expect(
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
    ).toEqual({
      ok: false,
      issues: [
        {
          path: ".packages[0].role",
          message:
            "Package Role must be cli-tool, runtime-service, shared-library, or native-package",
        },
      ],
    });
  });

  it.each([
    ["name", "@demo/tool", "Package name must be unique: @demo/tool"],
    ["path", "packages/tool", "Package Path must be unique: packages/tool"],
  ] as const)(
    "rejects duplicate Package Definition %s",
    (property, value, message) => {
      const original = blueprintWithPackage("@demo/tool");
      const duplicate = {
        ...original.packages[0],
        packageDefinitionId: `package-${"2".repeat(64)}`,
        name: property === "name" ? value : "@demo/other",
        path: property === "path" ? value : "packages/other",
      };

      expect(
        validateProjectBlueprint({
          ...original,
          packages: [...original.packages, duplicate],
        }),
      ).toEqual({
        ok: false,
        issues: [{ path: ".packages", message }],
      });
    },
  );

  it.each([
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
  ])(
    "rejects the invalid persisted Package Definition ID %s",
    (id, message) => {
      const definition = {
        ...blueprintWithPackage("@demo/tool").packages[0],
      } as {
        packageDefinitionId?: string;
      } & Record<string, unknown>;
      if (id === undefined) delete definition.packageDefinitionId;
      else definition.packageDefinitionId = id;

      expect(
        validateProjectBlueprint({ schemaVersion: 3, packages: [definition] }),
      ).toEqual({
        ok: false,
        issues: [{ path: ".packages[0].packageDefinitionId", message }],
      });
    },
  );

  it("rejects duplicate opaque Package Definition IDs independently of names and paths", () => {
    const original = blueprintWithPackage("@demo/tool").packages[0];

    expect(
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
    ).toEqual({
      ok: false,
      issues: [
        {
          path: ".packages",
          message: `Package Definition ID must be unique: ${packageDefinitionId}`,
        },
      ],
    });
  });
});

describe("Project Blueprint v3 Package Paths", () => {
  it("exposes canonical Package Path shape and reservation facts", () => {
    expect(validateNewPackagePath("packages/tool")).toEqual({
      hasValidShape: true,
    });
    expect(validateNewPackagePath("packages/nested/tool")).toEqual({
      hasValidShape: false,
    });
    expect(validateNewPackagePath(".git/tool")).toEqual({
      hasValidShape: false,
      reservedWorkspaceCollection: ".git",
    });
  });

  it.each([
    ".git",
    ".github",
    ".devcontainer",
    ".template",
    "node_modules",
    "dist",
    "target",
  ])(
    "rejects the ADR0063 reserved workspace collection %s",
    (workspaceCollection) => {
      const packagePath = `${workspaceCollection}/evil`;

      expect(
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
      ).toEqual({
        ok: false,
        issues: [
          {
            path: ".packages[0].path",
            message: `Package Path ${packagePath} uses reserved workspace collection ${workspaceCollection}`,
          },
        ],
      });
    },
  );
});

describe("Project Blueprint draft semantics", () => {
  it("rejects invalid preset topology before Foundation assigns durable identity", () => {
    expect(() =>
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
    ).toThrow(
      ".packages[0].path: Package Path dist/evil uses reserved workspace collection dist",
    );
  });
});

describe("Project Blueprint v3 schema", () => {
  it.each([
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
  ])("preserves actionable object diagnostics", (value, path, message) => {
    expect(validateProjectBlueprint(value)).toEqual({
      ok: false,
      issues: [{ path, message }],
    });
  });

  it("reports structural issues before running cross-document semantics", () => {
    expect(
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
    ).toEqual({
      ok: false,
      issues: [
        {
          path: ".packages[0].name",
          message: "Package name must be a string",
        },
      ],
    });
  });

  it("reports strict-schema unknown fields at their deep persisted path", () => {
    expect(
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
    ).toEqual({
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
    });
  });

  it("rejects the previous schema version without a compatibility reader", () => {
    expect(
      validateProjectBlueprint({ schemaVersion: 2, packages: [] }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: ".schemaVersion",
          message:
            "Unsupported Local Template Metadata schema version 2; expected 3",
        },
      ],
    });
  });

  it("rejects unknown persisted fields", () => {
    expect(
      validateProjectBlueprint({
        schemaVersion: 3,
        packages: [],
        repositoryName: "not-blueprint-owned",
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: ".repositoryName",
          message: "Unknown Blueprint v3 field",
        },
      ],
    });
  });
});

import { describe, expect, it } from "vitest";

import { validateProjectBlueprintV2 } from "../packages/core/src/project-blueprint-v2.ts";

describe("Project Blueprint v2 Package Roles", () => {
  it("accepts the CLI Tool Package Role as a distinct Package Definition intent", () => {
    const blueprint = {
      schemaVersion: 2,
      packages: [
        {
          name: "@demo/tool",
          path: "packages/tool",
          role: "cli-tool",
        },
      ],
    };

    expect(validateProjectBlueprintV2(blueprint)).toEqual({
      ok: true,
      value: blueprint,
    });
  });

  it("reports every supported role when an unknown Package Role is persisted", () => {
    expect(
      validateProjectBlueprintV2({
        schemaVersion: 2,
        packages: [
          {
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
});

describe("Project Blueprint v2 Package Paths", () => {
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
        validateProjectBlueprintV2({
          schemaVersion: 2,
          packages: [
            {
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

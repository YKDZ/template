import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  PackageDefinition,
  PersistedPackageDefinition,
} from "@ykdz/template-core/project-blueprint";
import type { RenderOperation } from "@ykdz/template-core/renderer";
import { checkTemplateSourceBoundary } from "@ykdz/template-core/template-boundary-check";
import ts from "typescript";

import {
  assertDeepStrictEqualWithMatchers,
  objectContaining,
  testEach,
} from "./assertions.ts";

const workflowPath = ".github/workflows/check.yml";

function persistedDefinition(
  hexDigit: string,
  definition: PackageDefinition,
): PersistedPackageDefinition {
  return {
    ...definition,
    packageDefinitionId: `package-${hexDigit.repeat(64)}`,
  };
}

function workflowOperation(
  replacements: Record<string, string> = {},
): Extract<RenderOperation, { kind: "writeTextTemplate" }> {
  return {
    kind: "writeTextTemplate",
    source: {} as Extract<RenderOperation, { source: unknown }>["source"],
    from: ".github/workflows/check-diagnostics.yml",
    to: workflowPath,
    replacements,
  };
}

void describe("Template Source Boundary", () => {
  testEach(
    [
      "packages/cli/README.md",
      "scripts/npm-publication/readiness.ts",
      "Dockerfile",
      ".dockerignore",
      "scripts/check-standalone-deployment.ts",
      "scripts/container-entrypoint.sh",
    ],
    "rejects an inline protected body for %s with its planner owner",
    async (generatedPath) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "template-boundary-publication-body-"),
      );
      const sourceFilePath = path.join(directory, "publication-planner.ts");
      await writeFile(
        sourceFilePath,
        [
          "export function planPublicationBody() {",
          "  return {",
          '    kind: "writeText",',
          `    to: ${JSON.stringify(generatedPath)},`,
          '    text: "protected publication body\\n",',
          "  };",
          "}",
        ].join("\n"),
        "utf8",
      );

      try {
        const result = await checkTemplateSourceBoundary({
          projections: [
            {
              name: "publication-boundary:planInitialization",
              sourceFilePath,
              definitionName: "publication-boundary",
              planningContribution: "planInitialization",
              plan: {
                operations: [
                  {
                    kind: "writeText",
                    to: generatedPath,
                    text: "protected publication body\n",
                  },
                ],
              },
            },
          ],
        });

        assertDeepStrictEqualWithMatchers(result, {
          ok: false,
          violations: [
            objectContaining({
              generatedPath,
              owningFunction: "planPublicationBody",
              operationKind: "writeText",
              sourceFilePath,
            }),
          ],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  testEach(
    [
      [
        "an extra declaration key",
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/web" },
          paths: ["test-results"],
        },
      ],
      [
        "a wrong diagnostic kind",
        {
          kind: "coverage",
          owner: { kind: "package-boundary", path: "apps/web" },
        },
      ],
      [
        "a malformed owner",
        { kind: "playwright", owner: { path: "apps/web" } },
      ],
      [
        "an unsafe owner path",
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "../secrets" },
        },
      ],
      [
        "an owner absent from the Blueprint",
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/admin" },
        },
      ],
    ],
    "rejects %s in a protected workflow declaration",
    async (_label, declaration) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "template-boundary-workflow-contract-"),
      );
      const sourceFilePath = path.join(directory, "workflow-helper.ts");
      await writeFile(
        sourceFilePath,
        ["export function planWorkflow() {", "  return {};", "}"].join("\n"),
        "utf8",
      );

      try {
        const result = await checkTemplateSourceBoundary({
          projections: [],
          protectedWorkflowPlans: [
            {
              name: "vue-app:planInitialization",
              sourceFilePath,
              generatedPath: workflowPath,
              blueprint: {
                schemaVersion: 3,
                packages: [
                  persistedDefinition("1", {
                    name: "@example/web",
                    path: "apps/web",
                    role: "runtime-service",
                  }),
                ],
              },
              diagnosticArtifactDeclarations: [declaration],
              operations: [
                workflowOperation({ DIAGNOSTIC_OWNER_PATHS: "apps/web" }),
              ],
            },
          ],
        });

        assert.strictEqual(result.ok, false);
        assertDeepStrictEqualWithMatchers(result.violations, [
          objectContaining({
            generatedPath: workflowPath,
            sourceFilePath,
          }),
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  void it("derives diagnostic owner facts from raw Blueprint declarations without the production composer", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "template-boundary-workflow-contract-"),
    );
    const sourceFilePath = path.join(directory, "workflow-helper.ts");
    await writeFile(
      sourceFilePath,
      ["export function planWorkflow() {", "  return {};", "}"].join("\n"),
      "utf8",
    );

    try {
      const result = await checkTemplateSourceBoundary({
        projections: [],
        protectedWorkflowPlans: [
          {
            name: "vue-app:planInitialization",
            sourceFilePath,
            generatedPath: workflowPath,
            blueprint: {
              schemaVersion: 3,
              packages: [
                persistedDefinition("1", {
                  name: "@example/admin",
                  path: "apps/admin",
                  role: "runtime-service",
                }),
                persistedDefinition("2", {
                  name: "@example/web",
                  path: "apps/web",
                  role: "runtime-service",
                }),
              ],
            },
            diagnosticArtifactDeclarations: [
              {
                kind: "playwright",
                owner: { kind: "package-boundary", path: "apps/web" },
              },
              {
                kind: "playwright",
                owner: { kind: "package-boundary", path: "apps/admin" },
              },
              {
                kind: "playwright",
                owner: { kind: "package-boundary", path: "apps/web" },
              },
            ],
            operations: [
              workflowOperation({
                DIAGNOSTIC_OWNER_PATHS: "apps/admin\n            apps/web",
              }),
            ],
          },
        ],
      });

      assert.deepStrictEqual(result, { ok: true, violations: [] });

      const checkerSourcePath = path.resolve(
        "packages/core/src/template-boundary-check.ts",
      );
      const checkerSource = ts.createSourceFile(
        checkerSourcePath,
        await readFile(checkerSourcePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const composerReferences: ts.Node[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node.text === "composeCiDiagnosticArtifacts"
        ) {
          composerReferences.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(checkerSource);

      assert.deepStrictEqual(composerReferences, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("does not scan unrelated planner strings when the workflow projection is source-backed", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "template-boundary-workflow-contract-"),
    );
    const sourceFilePath = path.join(directory, "workflow-helper.ts");
    await writeFile(
      sourceFilePath,
      [
        "export function unrelatedString(): string {",
        '  return "rm -rf cache; cp input output; if [ -n value ]; then true; fi";',
        "}",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = await checkTemplateSourceBoundary({
        projections: [],
        protectedWorkflowPlans: [
          {
            name: "vue-app:planInitialization",
            sourceFilePath,
            generatedPath: workflowPath,
            blueprint: {
              schemaVersion: 3,
              packages: [
                persistedDefinition("1", {
                  name: "@example/web",
                  path: "apps/web",
                  role: "runtime-service",
                }),
              ],
            },
            diagnosticArtifactDeclarations: [
              {
                kind: "playwright",
                owner: { kind: "package-boundary", path: "apps/web" },
              },
            ],
            operations: [
              workflowOperation({ DIAGNOSTIC_OWNER_PATHS: "apps/web" }),
            ],
          },
        ],
      });

      assert.deepStrictEqual(result, { ok: true, violations: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("rejects a workflow replacement that is not independently derived owner facts", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "template-boundary-workflow-contract-"),
    );
    const sourceFilePath = path.join(directory, "workflow-helper.ts");
    await writeFile(
      sourceFilePath,
      [
        "export function planWorkflow() {",
        "  return {",
        '    kind: "writeTextTemplate",',
        '    from: ".github/workflows/check-diagnostics.yml",',
        '    to: ".github/workflows/check.yml",',
        "    replacements: {",
        '      DIAGNOSTIC_OWNER_PATHS: ["rm -rf .template-ci-diagnostics", "mkdir -p .template-ci-diagnostics"].join("\\n"),',
        "    },",
        "  };",
        "}",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = await checkTemplateSourceBoundary({
        projections: [],
        protectedWorkflowPlans: [
          {
            name: "vue-app:planInitialization",
            sourceFilePath,
            generatedPath: workflowPath,
            blueprint: {
              schemaVersion: 3,
              packages: [
                persistedDefinition("1", {
                  name: "@example/web",
                  path: "apps/web",
                  role: "runtime-service",
                }),
              ],
            },
            diagnosticArtifactDeclarations: [
              {
                kind: "playwright",
                owner: { kind: "package-boundary", path: "apps/web" },
              },
            ],
            operations: [
              workflowOperation({
                DIAGNOSTIC_OWNER_PATHS:
                  "rm -rf .template-ci-diagnostics\nmkdir -p .template-ci-diagnostics",
              }),
            ],
          },
        ],
      });

      assertDeepStrictEqualWithMatchers(result, {
        ok: false,
        violations: [
          objectContaining({
            generatedPath: workflowPath,
            owningFunction: "planWorkflow",
            sourceFilePath,
          }),
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

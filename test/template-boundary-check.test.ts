import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { RenderOperation } from "#template-core/renderer";
import { checkTemplateSourceBoundary } from "#template-core/template-boundary-check";

const workflowPath = ".github/workflows/check.yml";

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

describe("Template Source Boundary", () => {
  it.each([
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
    ["a malformed owner", { kind: "playwright", owner: { path: "apps/web" } }],
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
  ])(
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
                schemaVersion: 2,
                packages: [
                  {
                    name: "@example/web",
                    path: "apps/web",
                    role: "runtime-service",
                  },
                ],
              },
              diagnosticArtifactDeclarations: [declaration],
              operations: [
                workflowOperation({ DIAGNOSTIC_OWNER_PATHS: "apps/web" }),
              ],
            },
          ],
        });

        expect(result.ok).toBe(false);
        expect(result.violations).toEqual([
          expect.objectContaining({
            generatedPath: workflowPath,
            sourceFilePath,
          }),
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("derives diagnostic owner facts from raw Blueprint declarations without the production composer", async () => {
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
              schemaVersion: 2,
              packages: [
                {
                  name: "@example/admin",
                  path: "apps/admin",
                  role: "runtime-service",
                },
                {
                  name: "@example/web",
                  path: "apps/web",
                  role: "runtime-service",
                },
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

      expect(result).toEqual({ ok: true, violations: [] });

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

      expect(composerReferences).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not scan unrelated planner strings when the workflow projection is source-backed", async () => {
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
              schemaVersion: 2,
              packages: [
                {
                  name: "@example/web",
                  path: "apps/web",
                  role: "runtime-service",
                },
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

      expect(result).toEqual({ ok: true, violations: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a workflow replacement that is not independently derived owner facts", async () => {
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
              schemaVersion: 2,
              packages: [
                {
                  name: "@example/web",
                  path: "apps/web",
                  role: "runtime-service",
                },
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

      expect(result).toEqual({
        ok: false,
        violations: [
          expect.objectContaining({
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

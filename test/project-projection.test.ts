import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createProjectProjectionReconciler,
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
  reconcileProjectProjections,
  validateProjectProjectionPlan,
  type ProjectProjection,
  type ProjectProjectionEntry,
  type ProjectProjectionMirrorSlot,
} from "@ykdz/template-core/project-projection";
import {
  createTemplateSourceHandle,
  type RenderOperation,
} from "@ykdz/template-core/renderer";

import {
  any,
  assertDeepStrictEqualWithMatchers,
  assertLength,
  assertPartialDeepStrictEqual,
  assertRejectsContaining,
  hasProperty,
  objectContaining,
  stringContaining,
  stringMatching,
  testEach,
} from "./assertions.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const planTemplateSource = createTemplateSourceHandle(
  "/tmp/project-projection-plan-source",
);

function textEntry(
  projectionPath: string,
  content: string,
): ProjectProjectionEntry {
  return {
    path: projectionPath,
    kind: "file",
    content: encoder.encode(content),
    mode: 0,
  };
}

function textProjection(
  projectionPath: string,
  content: string,
): ProjectProjection {
  return {
    entries: [textEntry(projectionPath, content)],
    reconciliation: [{ path: projectionPath, driver: "text" }],
  };
}

function structuredProjection(
  projectionPath: string,
  value: unknown,
): ProjectProjection {
  return {
    entries: [textEntry(projectionPath, `${JSON.stringify(value, null, 2)}\n`)],
    reconciliation: [{ path: projectionPath, driver: "structured" }],
  };
}

void describe("Project Projection materialization", () => {
  void it("rejects merging JSON into known non-JSON text during plan preflight", () => {
    assert.ok(
      validateProjectProjectionPlan({
        operations: [
          {
            kind: "writeText",
            to: "config.json",
            text: "not json\n",
          },
          {
            kind: "mergeJson",
            to: "config.json",
            value: { enabled: true },
          },
        ],
      }).includes(
        "Project Projection mergeJson requires JSON-compatible content: config.json follows writeText",
      ),
    );
  });

  void it("rejects overwriting content after a transform during plan preflight", () => {
    assert.ok(
      validateProjectProjectionPlan({
        operations: [
          {
            kind: "writeText",
            to: "src/main.ts",
            text: "// @template:start entry\nold\n// @template:end entry\n",
          },
          {
            kind: "replaceAnchors",
            path: "src/main.ts",
            language: "typescript",
            replacements: { entry: "new" },
          },
          {
            kind: "writeJson",
            to: "src/main.ts",
            value: { discarded: true },
            overwrite: true,
          },
        ],
      }).includes(
        "Project Projection writeJson may not overwrite content after replaceAnchors: src/main.ts",
      ),
    );
  });

  void it("rejects applying a text transform to known JSON content", () => {
    assert.ok(
      validateProjectProjectionPlan({
        operations: [
          {
            kind: "writeJson",
            to: "src/main.ts",
            value: { entry: "old" },
          },
          {
            kind: "replaceAnchors",
            path: "src/main.ts",
            language: "typescript",
            replacements: { entry: "new" },
          },
        ],
      }).includes(
        "Project Projection replaceAnchors requires text-compatible content: src/main.ts follows writeJson",
      ),
    );
  });

  testEach(
    [
      {
        sequence: "writeJson to mergeJson",
        operations: [
          { kind: "writeJson", to: "config.json", value: { first: true } },
          { kind: "mergeJson", to: "config.json", value: { second: true } },
        ],
      },
      {
        sequence: "copyFile to mergeJson",
        operations: [
          {
            kind: "copyFile",
            source: planTemplateSource,
            from: "config.json",
            to: "config.json",
          },
          { kind: "mergeJson", to: "config.json", value: { second: true } },
        ],
      },
      {
        sequence: "copyFile to replaceAnchors to setExecutable",
        operations: [
          {
            kind: "copyFile",
            source: planTemplateSource,
            from: "main.ts",
            to: "src/main.ts",
          },
          {
            kind: "replaceAnchors",
            path: "src/main.ts",
            language: "typescript",
            replacements: { entry: "new" },
          },
          {
            kind: "setExecutable",
            path: "src/main.ts",
            executable: true,
          },
        ],
      },
    ] satisfies readonly {
      readonly sequence: string;
      readonly operations: readonly RenderOperation[];
    }[],
    "accepts the legal $sequence sequence",
    ({ operations }) => {
      assert.deepStrictEqual(validateProjectProjectionPlan({ operations }), []);
    },
  );

  void it("materializes planner-owned text at any safe projection path", async () => {
    assert.deepStrictEqual(
      await materializeProjectProjection({
        operations: [
          {
            kind: "writeText",
            to: "policies/custom.rules",
            text: "allow generated fact\n",
          },
        ],
      }),
      {
        entries: [textEntry("policies/custom.rules", "allow generated fact\n")],
        reconciliation: [{ path: "policies/custom.rules", driver: "text" }],
      },
    );
  });

  void it("uses planner-declared JSON key order instead of recognizing filenames", async () => {
    const value = {
      zeta: true,
      name: "demo",
      alpha: true,
      entry: { default: "./dist.js", source: "./src.ts", types: "./dist.d.ts" },
    };
    const [generic, declared] = await Promise.all([
      materializeProjectProjection({
        operations: [{ kind: "writeJson", to: "package.json", value }],
      }),
      materializeProjectProjection({
        operations: [
          {
            kind: "writeJson",
            to: "arbitrary.data",
            value,
            keyOrder: ["name", "zeta", "alpha"],
            nestedKeyOrder: ["source", "types", "default"],
          },
        ],
      }),
    ]);

    assert.strictEqual(
      decoder.decode(generic.entries[0]!.content),
      '{\n  "alpha": true,\n  "entry": {\n    "default": "./dist.js",\n    "source": "./src.ts",\n    "types": "./dist.d.ts"\n  },\n  "name": "demo",\n  "zeta": true\n}\n',
    );
    assert.strictEqual(
      decoder.decode(declared.entries[0]!.content),
      '{\n  "name": "demo",\n  "zeta": true,\n  "alpha": true,\n  "entry": {\n    "source": "./src.ts",\n    "types": "./dist.d.ts",\n    "default": "./dist.js"\n  }\n}\n',
    );
  });

  void it("rejects isolated setExecutable as an incomplete Project Projection", async () => {
    await assert.rejects(
      materializeProjectProjection({
        operations: [
          {
            kind: "setExecutable",
            path: "scripts/run.sh",
            executable: true,
          },
        ],
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection setExecutable requires a preceding content-producing operation: scripts/run.sh",
        ),
    );
  });

  void it("normalizes equivalent final states independently of Renderer operation count and order", async () => {
    const repeatedOperations = await materializeProjectProjection({
      operations: [
        {
          kind: "writeJson",
          to: "config.json",
          value: { enabled: true },
        },
        {
          kind: "mergeJson",
          to: "config.json",
          value: { retries: 2 },
        },
        {
          kind: "setExecutable",
          path: "config.json",
          executable: true,
        },
      ],
    });
    const consolidatedOperations = await materializeProjectProjection({
      operations: [
        {
          kind: "writeJson",
          to: "config.json",
          value: { enabled: true, retries: 2 },
        },
        {
          kind: "setExecutable",
          path: "config.json",
          executable: true,
        },
      ],
    });

    assert.deepStrictEqual(repeatedOperations, consolidatedOperations);
    assert.deepStrictEqual(repeatedOperations.entries, [
      {
        path: "config.json",
        kind: "file",
        content: new TextEncoder().encode(
          '{\n  "enabled": true,\n  "retries": 2\n}\n',
        ),
        mode: 0o111,
      },
    ]);
    assert.deepStrictEqual(repeatedOperations.reconciliation, [
      { path: "config.json", driver: "structured" },
    ]);
  });

  void it("uses generic planner reconciliation metadata to select a structured driver", async () => {
    const projection = await materializeProjectProjection({
      operations: [
        {
          kind: "writeText",
          to: "policy.md",
          text: '{"enabled":true}\n',
        },
      ],
      reconciliation: [{ path: "policy.md", driver: "structured" }],
    });

    assert.deepStrictEqual(projection.reconciliation, [
      { path: "policy.md", driver: "structured" },
    ]);
  });

  void it("reconciles a mode-only final-state delta while preserving compatible Current content", async () => {
    const contentOperation = {
      kind: "writeText" as const,
      to: "README.md",
      text: "projected\n",
    };
    const before = await materializeProjectProjection({
      operations: [contentOperation],
    });
    const after = await materializeProjectProjection({
      operations: [
        contentOperation,
        {
          kind: "setExecutable",
          path: "README.md",
          executable: true,
        },
      ],
    });

    assert.deepStrictEqual(
      before.entries[0]?.content,
      after.entries[0]?.content,
    );
    assert.strictEqual(before.entries[0]?.mode, 0);
    assert.strictEqual(after.entries[0]?.mode, 0o111);

    const result = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return textEntry("README.md", "user content\n");
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.mutations, [
      {
        path: "README.md",
        kind: "file",
        content: encoder.encode("user content\n"),
        mode: 0o111,
      },
    ]);
  });

  void it("applies a mode-only delta without replacing Current content", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-mode-only-"),
    );
    const readmePath = path.join(targetRoot, "README.md");
    const contentOperation = {
      kind: "writeText" as const,
      to: "README.md",
      text: "projected\n",
    };

    try {
      await writeFile(readmePath, "user content\n");
      await chmod(readmePath, 0o644);

      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot,
          before: { operations: [contentOperation] },
          after: {
            operations: [
              contentOperation,
              {
                kind: "setExecutable",
                path: "README.md",
                executable: true,
              },
            ],
          },
        }),
        {
          ok: true,
          changedPaths: ["README.md"],
          actions: [{ path: "README.md", driver: "text", action: "update" }],
        },
      );
      assert.strictEqual(await readFile(readmePath, "utf8"), "user content\n");
      assert.strictEqual((await stat(readmePath)).mode & 0o111, 0o111);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("reads only the Addition Delta so equal Before/After template output cannot upgrade Current", async () => {
    const unchanged = textEntry("unchanged.txt", "projected\n");
    const before: ProjectProjection = {
      entries: [textEntry("policy.txt", "first\ncommon\nlast\n"), unchanged],
      reconciliation: [
        { path: "policy.txt", driver: "text" },
        { path: "unchanged.txt", driver: "text" },
      ],
    };
    const after: ProjectProjection = {
      entries: [
        textEntry("policy.txt", "first\ncommon\ngenerated\nlast\n"),
        unchanged,
      ],
      reconciliation: [
        { path: "policy.txt", driver: "text" },
        { path: "unchanged.txt", driver: "text" },
      ],
    };
    const reads: string[] = [];

    const result = await reconcileProjectProjections({
      before,
      after,
      async readCurrent(projectionPath) {
        reads.push(projectionPath);
        if (projectionPath !== "policy.txt") {
          throw new Error(`unexpected read: ${projectionPath}`);
        }
        return textEntry(projectionPath, "first\nprivate\ncommon\nlast\n");
      },
    });

    assert.deepStrictEqual(reads, ["policy.txt"]);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assertLength(result.mutations, 1);
    assert.strictEqual(
      decoder.decode(result.mutations[0]!.content),
      "first\nprivate\ncommon\ngenerated\nlast\n",
    );
  });

  void it("recursively composes one-sided structured changes without erasing unrelated Current keys", async () => {
    const before = structuredProjection("config.json", {
      generated: { enabled: false },
      settings: { obsolete: true, timeout: 10 },
    });
    const after = structuredProjection("config.json", {
      generated: { enabled: true },
      required: { source: "package-addition" },
      settings: { obsolete: true, timeout: 10 },
    });

    const result = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return textEntry(
          "config.json",
          `${JSON.stringify(
            {
              generated: { enabled: false },
              settings: { timeout: 20 },
              userOnly: { retained: true },
            },
            null,
            2,
          )}\n`,
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)),
      {
        generated: { enabled: true },
        required: { source: "package-addition" },
        settings: { timeout: 20 },
        userOnly: { retained: true },
      },
    );
  });

  void it("reports an incompatible concurrent scalar change at its structured location", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", {
        settings: { timeout: 10 },
      }),
      after: structuredProjection("config.json", {
        settings: { timeout: 30 },
      }),
      async readCurrent() {
        return textEntry("config.json", '{"settings":{"timeout":20}}\n');
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          path: "config.json",
          driver: "structured",
          location: "/settings/timeout",
          reason: "Current and After contain incompatible scalar changes",
          before: "10",
          current: "20",
          after: "30",
        }),
      ],
    });
    assert.ok(!hasProperty(result, "mutations"));
  });

  testEach(
    [
      { beforeKind: "null", beforeValue: null, beforeDiagnostic: "null" },
      {
        beforeKind: "string",
        beforeValue: "legacy",
        beforeDiagnostic: '"legacy"',
      },
      { beforeKind: "number", beforeValue: 7, beforeDiagnostic: "7" },
      { beforeKind: "boolean", beforeValue: false, beforeDiagnostic: "false" },
      {
        beforeKind: "array",
        beforeValue: ["legacy"],
        beforeDiagnostic: '["legacy"]',
      },
    ],
    "conflicts when explicit $beforeKind is concurrently replaced by different objects",
    async ({ beforeValue, beforeDiagnostic }) => {
      const result = await reconcileProjectProjections({
        before: structuredProjection("config.json", {
          setting: beforeValue,
        }),
        after: structuredProjection("config.json", {
          setting: { generated: true },
        }),
        async readCurrent() {
          return textEntry(
            "config.json",
            '{"setting":{"userRetained":true}}\n',
          );
        },
      });

      assertDeepStrictEqualWithMatchers(result, {
        ok: false,
        conflicts: [
          objectContaining({
            path: "config.json",
            driver: "structured",
            location: "/setting",
            reason: "Current and After contain incompatible changes",
            before: beforeDiagnostic,
            current: '{"userRetained":true}',
            after: '{"generated":true}',
          }),
        ],
      });
      assert.ok(!hasProperty(result, "mutations"));
    },
  );

  void it("recursively combines concurrent object additions only at a missing location", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", {}),
      after: structuredProjection("config.json", {
        setting: { generated: true },
      }),
      async readCurrent() {
        return textEntry("config.json", '{"setting":{"userRetained":true}}\n');
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)),
      {
        setting: { userRetained: true, generated: true },
      },
    );
  });

  void it("rejects undefined because it is not a JSON structured value", async () => {
    const result = await reconcileProjectProjections({
      before: {
        entries: [textEntry("config.json", '{"setting":undefined}\n')],
        reconciliation: [{ path: "config.json", driver: "structured" }],
      },
      after: structuredProjection("config.json", {
        setting: { generated: true },
      }),
      async readCurrent() {
        return textEntry("config.json", '{"setting":null}\n');
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          location: "",
          reason: stringContaining(
            "Before structured content is not valid JSON",
          ),
          before: '{"setting":undefined}\n',
        }),
      ],
    });
  });

  void it("returns a structured parse diagnostic for invalid Current JSON", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", { enabled: false }),
      after: structuredProjection("config.json", { enabled: true }),
      async readCurrent() {
        return textEntry("config.json", '{"enabled":');
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          path: "config.json",
          driver: "structured",
          location: "",
          reason: stringContaining(
            "Current structured content is not valid JSON",
          ),
          current: '{"enabled":',
        }),
      ],
    });
  });

  void it("uses the root pointer for a structured file-level conflict", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", { enabled: false }),
      after: structuredProjection("config.json", { enabled: true }),
      async readCurrent() {
        return undefined;
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          path: "config.json",
          driver: "structured",
          location: "",
          reason: "Path presence changed concurrently",
        }),
      ],
    });
  });

  void it("preserves Current scalar members and appends After members for an explicit identity set", async () => {
    const identitySetReconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [{ location: "", identity: { kind: "self" as const } }],
      },
    ];
    const result = await reconcileProjectProjections({
      before: {
        ...structuredProjection("config.json", ["base"]),
        reconciliation: identitySetReconciliation,
      },
      after: {
        ...structuredProjection("config.json", ["base", "generated"]),
        reconciliation: identitySetReconciliation,
      },
      async readCurrent() {
        return textEntry("config.json", '["user-first","base","user-last"]\n');
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)),
      ["user-first", "base", "user-last", "generated"],
    );
  });

  void it("recursively reconciles matching object members by stable identity", async () => {
    const identitySetReconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          {
            location: "/members",
            identity: { kind: "fields" as const, fields: ["id"] },
          },
        ],
      },
    ];
    const result = await reconcileProjectProjections({
      before: {
        ...structuredProjection("config.json", {
          members: [{ id: "base", settings: { timeout: 10 } }],
        }),
        reconciliation: identitySetReconciliation,
      },
      after: {
        ...structuredProjection("config.json", {
          members: [
            {
              id: "base",
              settings: { required: true, timeout: 10 },
            },
            { id: "generated", settings: {} },
          ],
        }),
        reconciliation: identitySetReconciliation,
      },
      async readCurrent() {
        return textEntry(
          "config.json",
          JSON.stringify({
            members: [
              { id: "user", settings: { retained: true } },
              { id: "base", settings: { timeout: 20 } },
            ],
          }),
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)),
      {
        members: [
          { id: "user", settings: { retained: true } },
          {
            id: "base",
            settings: { timeout: 20, required: true },
          },
          { id: "generated", settings: {} },
        ],
      },
    );
  });

  void it("reconciles generated members by projection identity when visible fields change", async () => {
    const beforeReconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          {
            location: "/mounts",
            identity: {
              kind: "projection" as const,
              members: [
                {
                  identity: "tool-cache",
                  match: { target: "/var/cache/tool-v1" },
                },
              ],
              fallback: { fields: ["target"] },
            },
          },
        ],
      },
    ];
    const afterReconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          {
            location: "/mounts",
            identity: {
              kind: "projection" as const,
              members: [
                {
                  identity: "tool-cache",
                  match: { target: "/var/cache/tool-v2" },
                },
              ],
              fallback: { fields: ["target"] },
            },
          },
        ],
      },
    ];
    const result = await reconcileProjectProjections({
      before: {
        ...structuredProjection("config.json", {
          mounts: [
            {
              type: "volume",
              source: "tool-cache",
              target: "/var/cache/tool-v1",
            },
          ],
        }),
        reconciliation: beforeReconciliation,
      },
      after: {
        ...structuredProjection("config.json", {
          mounts: [
            {
              type: "volume",
              source: "tool-cache",
              target: "/var/cache/tool-v2",
            },
          ],
        }),
        reconciliation: afterReconciliation,
      },
      async readCurrent() {
        return textEntry(
          "config.json",
          JSON.stringify({
            mounts: [
              {
                type: "bind",
                source: "${localEnv:HOME}/.user-cache",
                target: "/var/cache/user",
              },
              {
                type: "volume",
                source: "tool-cache",
                target: "/var/cache/tool-v1",
              },
            ],
          }),
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)),
      {
        mounts: [
          {
            type: "bind",
            source: "${localEnv:HOME}/.user-cache",
            target: "/var/cache/user",
          },
          {
            type: "volume",
            source: "tool-cache",
            target: "/var/cache/tool-v2",
          },
        ],
      },
    );
  });

  void it("distinguishes object members by multiple identity fields", async () => {
    const reconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          {
            location: "/members",
            identity: {
              kind: "fields" as const,
              fields: ["owner", "name"],
            },
          },
        ],
      },
    ];
    const result = await reconcileProjectProjections({
      before: {
        ...structuredProjection("config.json", {
          members: [{ owner: "base", name: "shared" }],
        }),
        reconciliation,
      },
      after: {
        ...structuredProjection("config.json", {
          members: [
            { owner: "base", name: "shared" },
            { owner: "generated", name: "shared" },
          ],
        }),
        reconciliation,
      },
      async readCurrent() {
        return textEntry(
          "config.json",
          JSON.stringify({
            members: [
              { owner: "user", name: "shared" },
              { owner: "base", name: "shared" },
            ],
          }),
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)),
      {
        members: [
          { owner: "user", name: "shared" },
          { owner: "base", name: "shared" },
          { owner: "generated", name: "shared" },
        ],
      },
    );
  });

  void it("conflicts when matching object members change the same scalar incompatibly", async () => {
    const reconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          {
            location: "/members",
            identity: { kind: "fields" as const, fields: ["id"] },
          },
        ],
      },
    ];
    const result = await reconcileProjectProjections({
      before: {
        ...structuredProjection("config.json", {
          members: [{ id: "shared", value: 1 }],
        }),
        reconciliation,
      },
      after: {
        ...structuredProjection("config.json", {
          members: [{ id: "shared", value: 3 }],
        }),
        reconciliation,
      },
      async readCurrent() {
        return textEntry(
          "config.json",
          '{"members":[{"id":"user","value":0},{"id":"shared","value":2}]}\n',
        );
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          driver: "structured",
          location: "/members/1/value",
          reason: "Current and After contain incompatible scalar changes",
          before: "1",
          current: "2",
          after: "3",
        }),
      ],
    });
    assert.ok(!hasProperty(result, "mutations"));
  });

  void it("decodes identity-set pointers and escapes structured conflict tokens", async () => {
    const escapedKey = "groups/primary~set";
    const reconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          {
            location: "/groups~1primary~0set",
            identity: { kind: "fields" as const, fields: ["id"] },
          },
        ],
      },
    ];
    const result = await reconcileProjectProjections({
      before: {
        ...structuredProjection("config.json", {
          [escapedKey]: [{ id: "shared", value: 1 }],
        }),
        reconciliation,
      },
      after: {
        ...structuredProjection("config.json", {
          [escapedKey]: [{ id: "shared", value: 3 }],
        }),
        reconciliation,
      },
      async readCurrent() {
        return textEntry(
          "config.json",
          JSON.stringify({
            [escapedKey]: [{ id: "shared", value: 2 }],
          }),
        );
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          location: "/groups~1primary~0set/0/value",
          before: "1",
          current: "2",
          after: "3",
        }),
      ],
    });
  });

  void it("rejects an identity-set policy whose structured location is not an array", async () => {
    let reads = 0;
    const reconciliation = [
      {
        path: "config.json",
        driver: "structured" as const,
        identitySets: [
          { location: "/members", identity: { kind: "self" as const } },
        ],
      },
    ];

    await assert.rejects(
      reconcileProjectProjections({
        before: {
          ...structuredProjection("config.json", { members: {} }),
          reconciliation,
        },
        after: {
          ...structuredProjection("config.json", {
            enabled: true,
            members: {},
          }),
          reconciliation,
        },
        async readCurrent() {
          reads += 1;
          return textEntry("config.json", '{"members":{}}\n');
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection identity-set location must reference an array: config.json /members",
        ),
    );
    assert.strictEqual(reads, 0);
  });

  testEach(
    ["members", "/members/~", "/members/~2"],
    "rejects invalid identity-set JSON Pointer %j before reading Current",
    async (location) => {
      let reads = 0;
      const reconciliation = [
        {
          path: "config.json",
          driver: "structured" as const,
          identitySets: [{ location, identity: { kind: "self" as const } }],
        },
      ];

      await assert.rejects(
        reconcileProjectProjections({
          before: {
            ...structuredProjection("config.json", { members: ["base"] }),
            reconciliation,
          },
          after: {
            ...structuredProjection("config.json", {
              enabled: true,
              members: ["base"],
            }),
            reconciliation,
          },
          async readCurrent() {
            reads += 1;
            return textEntry("config.json", '{"members":["base"]}\n');
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Project Projection identity-set location must be an RFC 6901 JSON Pointer",
          ),
      );
      assert.strictEqual(reads, 0);
    },
  );

  testEach(
    [
      {
        caseName: "missing",
        currentMembers: [{ label: "missing-id" }],
        diagnostic: "is missing its identity",
      },
      {
        caseName: "duplicate",
        currentMembers: [{ id: "same" }, { id: "same" }],
        diagnostic: "identities must be unique",
      },
    ],
    "returns a policy conflict for $caseName Current member identities",
    async ({ currentMembers, diagnostic }) => {
      const reconciliation = [
        {
          path: "config.json",
          driver: "structured" as const,
          identitySets: [
            {
              location: "/members",
              identity: { kind: "fields" as const, fields: ["id"] },
            },
          ],
        },
      ];
      const result = await reconcileProjectProjections({
        before: {
          ...structuredProjection("config.json", {
            members: [{ id: "base" }],
          }),
          reconciliation,
        },
        after: {
          ...structuredProjection("config.json", {
            members: [{ id: "base" }, { id: "generated" }],
          }),
          reconciliation,
        },
        async readCurrent() {
          return textEntry(
            "config.json",
            JSON.stringify({ members: currentMembers }),
          );
        },
      });

      assertDeepStrictEqualWithMatchers(result, {
        ok: false,
        conflicts: [
          objectContaining({
            location: "/members",
            reason: stringContaining(`Current ${diagnostic}`),
          }),
        ],
      });
      assert.ok(!hasProperty(result, "mutations"));
    },
  );

  void it("keeps undeclared arrays atomic", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", {
        members: ["base"],
      }),
      after: structuredProjection("config.json", {
        members: ["base", "generated"],
      }),
      async readCurrent() {
        return textEntry("config.json", '{"members":["base","user"]}\n');
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          location: "/members",
          reason: "Current and After contain incompatible atomic array changes",
        }),
      ],
    });
  });

  void it("advances tool-owned state when Current exactly matches Before", async () => {
    const canonicalReconciliation = [
      { path: "state.json", driver: "canonical" as const },
    ];
    const before = structuredProjection("state.json", {
      schemaVersion: 1,
      value: "before",
    });
    const after = structuredProjection("state.json", {
      schemaVersion: 1,
      value: "after",
    });
    const result = await reconcileProjectProjections({
      before: {
        ...before,
        reconciliation: canonicalReconciliation,
      },
      after: {
        ...after,
        reconciliation: canonicalReconciliation,
      },
      async readCurrent() {
        return before.entries[0];
      },
    });

    assert.deepStrictEqual(result, {
      ok: true,
      mutations: after.entries,
    });
  });

  testEach(
    [
      {
        staleDimension: "content",
        current: textEntry(
          "state.json",
          '{"schemaVersion":1,"unknown":"user","value":"before"}\n',
        ),
        currentDescription:
          '{"schemaVersion":1,"unknown":"user","value":"before"}\n',
      },
      {
        staleDimension: "mode",
        current: {
          ...structuredProjection("state.json", {
            schemaVersion: 1,
            value: "before",
          }).entries[0]!,
          mode: 0o111,
        },
        currentDescription:
          '{\n  "schemaVersion": 1,\n  "value": "before"\n}\n',
      },
      {
        staleDimension: "kind",
        current: { path: "state.json", kind: "directory" },
        currentDescription: "directory",
      },
    ],
    "rejects stale tool-owned $staleDimension unless Current exactly matches Before",
    async ({ current, currentDescription }) => {
      const canonicalReconciliation = [
        { path: "state.json", driver: "canonical" as const },
      ];
      const result = await reconcileProjectProjections({
        before: {
          ...structuredProjection("state.json", {
            schemaVersion: 1,
            value: "before",
          }),
          reconciliation: canonicalReconciliation,
        },
        after: {
          ...structuredProjection("state.json", {
            schemaVersion: 1,
            value: "after",
          }),
          reconciliation: canonicalReconciliation,
        },
        async readCurrent() {
          return current;
        },
      });

      assert.deepStrictEqual(result, {
        ok: false,
        conflicts: [
          {
            path: "state.json",
            driver: "canonical",
            reason: "Current tool-owned state is stale",
            before: '{\n  "schemaVersion": 1,\n  "value": "before"\n}\n',
            current: currentDescription,
            after: '{\n  "schemaVersion": 1,\n  "value": "after"\n}\n',
          },
        ],
      });
      assert.ok(!hasProperty(result, "mutations"));
    },
  );

  void it("rejects duplicate projection paths before reading Current", async () => {
    const duplicateBefore: ProjectProjection = {
      entries: [
        textEntry("same.txt", "first\n"),
        textEntry("same.txt", "second\n"),
      ],
      reconciliation: [{ path: "same.txt", driver: "text" }],
    };

    await assert.rejects(
      reconcileProjectProjections({
        before: duplicateBefore,
        after: {
          entries: [textEntry("same.txt", "after\n")],
          reconciliation: [{ path: "same.txt", driver: "text" }],
        },
        async readCurrent(projectionPath) {
          throw new Error(`unexpected read: ${projectionPath}`);
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection paths must be unique: same.txt",
        ),
    );
  });

  void it("rejects escaping raw Projection entry paths before reading Current", async () => {
    let reads = 0;

    await assert.rejects(
      reconcileProjectProjections({
        before: textProjection("../escape.txt", "before\n"),
        after: textProjection("../escape.txt", "after\n"),
        async readCurrent() {
          reads += 1;
          return textEntry("../escape.txt", "before\n");
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection entry path must be a normalized safe relative path: ../escape.txt",
        ),
    );
    assert.strictEqual(reads, 0);
  });

  void it("rejects non-normalized reconciliation paths before reading Current", async () => {
    let reads = 0;

    await assert.rejects(
      reconcileProjectProjections({
        before: {
          entries: [textEntry("policy.txt", "before\n")],
          reconciliation: [{ path: "./policy.txt", driver: "text" }],
        },
        after: textProjection("policy.txt", "after\n"),
        async readCurrent() {
          reads += 1;
          return textEntry("policy.txt", "before\n");
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection reconciliation path must be a normalized safe relative path: ./policy.txt",
        ),
    );
    assert.strictEqual(reads, 0);
  });

  testEach(
    [
      "",
      "/absolute.txt",
      "./policy.txt",
      "nested/../policy.txt",
      "nested//policy.txt",
      "nested/",
      String.raw`C:\absolute.txt`,
    ],
    "rejects unsafe raw Projection path %j",
    async (projectionPath) => {
      let reads = 0;

      await assert.rejects(
        reconcileProjectProjections({
          before: textProjection(projectionPath, "before\n"),
          after: textProjection(projectionPath, "after\n"),
          async readCurrent() {
            reads += 1;
            return textEntry(projectionPath, "before\n");
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("must be a normalized safe relative path"),
      );
      assert.strictEqual(reads, 0);
    },
  );

  void it("does not apply an escaping materialized path outside the target root", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-projection-containment-"),
    );
    const targetRoot = path.join(workspace, "project");
    const outsidePath = path.join(workspace, "outside.json");

    try {
      await writeFile(outsidePath, '{"owner":"user"}\n');

      await assert.rejects(
        reconcileAndApplyProjectProjections({
          targetRoot,
          before: { operations: [] },
          after: {
            operations: [
              {
                kind: "writeJson",
                to: "../outside.json",
                value: { owner: "template" },
              },
            ],
          },
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "Project Projection path escapes its root: ../outside.json",
          ),
      );
      assert.strictEqual(
        await readFile(outsidePath, "utf8"),
        '{"owner":"user"}\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("requires one stable reconciliation driver per projected path before reading Current", async () => {
    await assert.rejects(
      reconcileProjectProjections({
        before: textProjection("same.txt", "before\n"),
        after: {
          entries: [textEntry("same.txt", "after\n")],
          reconciliation: [],
        },
        async readCurrent(projectionPath) {
          throw new Error(`unexpected read: ${projectionPath}`);
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection requires one reconciliation driver: same.txt",
        ),
    );
  });

  void it("requires reconciliation policy metadata to remain stable before reading Current", async () => {
    let reads = 0;
    const entry = textEntry("config.json", '{"members":["base"]}\n');

    await assert.rejects(
      reconcileProjectProjections({
        before: {
          entries: [entry],
          reconciliation: [
            {
              path: "config.json",
              driver: "structured",
              identitySets: [
                {
                  location: "/members",
                  identity: { kind: "self" },
                },
              ],
            },
          ],
        },
        after: {
          entries: [
            textEntry("config.json", '{"members":["base","generated"]}\n'),
          ],
          reconciliation: [{ path: "config.json", driver: "structured" }],
        },
        async readCurrent() {
          reads += 1;
          return entry;
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Project Projection reconciliation policy changed for config.json",
        ),
    );
    assert.strictEqual(reads, 0);
  });

  void it("obeys the basic three-way laws and repeated application is idempotent", async () => {
    const before = textProjection("alpha.txt", "before\n");
    const after = textProjection("alpha.txt", "after\n");
    const first = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return textEntry("alpha.txt", "before\n");
      },
    });

    assert.deepStrictEqual(first, {
      ok: true,
      mutations: [textEntry("alpha.txt", "after\n")],
    });
    if (!first.ok) return;
    const repeated = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return first.mutations[0];
      },
    });
    assert.deepStrictEqual(repeated, { ok: true, mutations: [] });

    const unchangedProjection = textProjection("stable.txt", "projected\n");
    assert.deepStrictEqual(
      await reconcileProjectProjections({
        before: unchangedProjection,
        after: unchangedProjection,
        async readCurrent(projectionPath) {
          throw new Error(`unexpected read: ${projectionPath}`);
        },
      }),
      { ok: true, mutations: [] },
    );
  });

  void it("returns conflicts without a partial mutation result", async () => {
    const result = await reconcileProjectProjections({
      before: textProjection("alpha.txt", "shared\n"),
      after: textProjection("alpha.txt", "generated\n"),
      async readCurrent() {
        return textEntry("alpha.txt", "user\n");
      },
    });

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.ok(!hasProperty(result, "mutations"));
    assertDeepStrictEqualWithMatchers(result.conflicts, [
      objectContaining({
        path: "alpha.txt",
        driver: "text",
        reason: "Current and After contain incompatible text changes",
        region: any(Object),
      }),
    ]);
  });

  void it("reports each text conflict as a concise line region", async () => {
    const result = await reconcileProjectProjections({
      before: textProjection(
        "policy.txt",
        "retained header\nbefore policy\nretained footer\n",
      ),
      after: textProjection(
        "policy.txt",
        "retained header\nafter policy\nretained footer\n",
      ),
      async readCurrent() {
        return textEntry(
          "policy.txt",
          "retained header\ncurrent policy\nretained footer\n",
        );
      },
    });

    assert.deepStrictEqual(result, {
      ok: false,
      conflicts: [
        {
          path: "policy.txt",
          driver: "text",
          region: {
            before: { startLine: 2, lineCount: 1 },
            current: { startLine: 2, lineCount: 1 },
            after: { startLine: 2, lineCount: 1 },
          },
          reason: "Current and After contain incompatible text changes",
          before: "before policy\n",
          current: "current policy\n",
          after: "after policy\n",
        },
      ],
    });
  });

  void it("reports incompatible binary content without throwing or serializing bytes", async () => {
    const binaryProjection = (
      content: readonly number[],
    ): ProjectProjection => ({
      entries: [
        {
          path: "asset.bin",
          kind: "file",
          content: Uint8Array.from(content),
          mode: 0,
        },
      ],
      reconciliation: [{ path: "asset.bin", driver: "text" }],
    });

    const result = await reconcileProjectProjections({
      before: binaryProjection([0xff, 0x00]),
      after: binaryProjection([0xfe, 0x00]),
      async readCurrent() {
        return binaryProjection([0xfd, 0x00]).entries[0];
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        {
          path: "asset.bin",
          driver: "text",
          attribute: "binary-content",
          reason: "Current and After contain incompatible binary changes",
          before: stringMatching(/^<2 binary bytes; sha256=[a-f0-9]{64}>$/u),
          current: stringMatching(/^<2 binary bytes; sha256=[a-f0-9]{64}>$/u),
          after: stringMatching(/^<2 binary bytes; sha256=[a-f0-9]{64}>$/u),
        },
      ],
    });
  });

  void it("reports incompatible executable-mode changes as a file attribute conflict", async () => {
    const before = textProjection("script.sh", "echo stable\n");
    const after = {
      ...before,
      entries: [{ ...before.entries[0]!, mode: 0o111 }],
    };

    const result = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return { ...before.entries[0]!, mode: 0o100 };
      },
    });

    assert.deepStrictEqual(result, {
      ok: false,
      conflicts: [
        {
          path: "script.sh",
          driver: "text",
          attribute: "executable-mode",
          reason:
            "Current and After contain incompatible executable-mode changes",
          before: "000",
          current: "100",
          after: "111",
        },
      ],
    });
  });

  void it("reports a Current file-kind conflict before mutating the workspace", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-kind-conflict-"),
    );
    const readmePath = path.join(targetRoot, "README.md");

    try {
      await mkdir(readmePath);
      await writeFile(path.join(readmePath, "retained.txt"), "user data\n");

      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot,
          before: {
            operations: [
              { kind: "writeText", to: "README.md", text: "before\n" },
            ],
          },
          after: {
            operations: [
              { kind: "writeText", to: "README.md", text: "after\n" },
            ],
          },
        }),
        {
          ok: false,
          conflicts: [
            {
              path: "README.md",
              driver: "text",
              attribute: "file-kind",
              reason: "Current file kind is incompatible with Package Addition",
              before: "file",
              current: "directory",
              after: "file",
            },
          ],
        },
      );
      assert.strictEqual(
        await readFile(path.join(readmePath, "retained.txt"), "utf8"),
        "user data\n",
      );
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("rolls back repository files and canonical metadata after a commit failure", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-rollback-"),
    );
    const sourceOperation = (text: string) =>
      ({
        operations: [
          { kind: "writeText" as const, to: "alpha.md", text },
          {
            kind: "writeJson" as const,
            to: ".template/state.json",
            value: { state: text.trim() },
          },
        ],
        reconciliation: [
          {
            path: ".template/state.json",
            driver: "canonical" as const,
          },
        ],
      }) as const;
    const committedPaths: string[] = [];
    const reconcile = createProjectProjectionReconciler({
      async commitMutation(options) {
        committedPaths.push(options.relativePath);
        if (committedPaths.length === 2) {
          throw new Error("injected projection commit failure");
        }
        await options.commit();
      },
    });

    try {
      await mkdir(path.join(targetRoot, ".template"));
      await Promise.all([
        writeFile(path.join(targetRoot, "alpha.md"), "before\n"),
        writeFile(
          path.join(targetRoot, ".template/state.json"),
          '{\n  "state": "before"\n}\n',
        ),
      ]);

      await assert.rejects(
        reconcile({
          targetRoot,
          before: sourceOperation("before\n"),
          after: sourceOperation("after\n"),
        }),
        (error) =>
          error instanceof Error &&
          error.message.includes("injected projection commit failure"),
      );
      assert.strictEqual(
        await readFile(path.join(targetRoot, "alpha.md"), "utf8"),
        "before\n",
      );
      assert.strictEqual(
        await readFile(path.join(targetRoot, ".template/state.json"), "utf8"),
        '{\n  "state": "before"\n}\n',
      );
      assertLength(committedPaths, 2);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("rejects a concurrently created reserved path at the atomic commit boundary with zero transaction writes", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-path-race-"),
    );
    const reconcile = createProjectProjectionReconciler({
      async beforeCommit() {
        await mkdir(path.join(targetRoot, "services/race"), {
          recursive: true,
        });
        await writeFile(path.join(targetRoot, "services/race/OWNER"), "user\n");
      },
    });

    try {
      await writeFile(path.join(targetRoot, "root.txt"), "before\n");
      const result = await reconcile({
        targetRoot,
        before: {
          operations: [{ kind: "writeText", to: "root.txt", text: "before\n" }],
        },
        after: {
          operations: [
            { kind: "writeText", to: "root.txt", text: "after\n" },
            {
              kind: "writeJson",
              to: "services/race/package.json",
              value: { name: "@demo/race" },
            },
          ],
        },
        preconditions: [
          {
            path: "services/race",
            kind: "must-not-exist",
            reason:
              "Package Path services/race already exists and cannot be used for a new Package Addition",
          },
        ],
      });

      assertPartialDeepStrictEqual(result, {
        ok: false,
        conflicts: [
          {
            path: "services/race",
            driver: "precondition",
            reason: stringContaining(
              "Package Path services/race already exists",
            ),
          },
        ],
      });
      assert.strictEqual(
        await readFile(path.join(targetRoot, "root.txt"), "utf8"),
        "before\n",
      );
      assert.strictEqual(
        await readFile(path.join(targetRoot, "services/race/OWNER"), "utf8"),
        "user\n",
      );
      await assert.rejects(
        stat(path.join(targetRoot, "services/race/package.json")),
        (error) => {
          assertPartialDeepStrictEqual(error, { code: "ENOENT" });
          return true;
        },
      );
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("rejects projection deletions before reading Current", async () => {
    const reads: string[] = [];

    await assert.rejects(
      reconcileProjectProjections({
        before: {
          entries: [
            textEntry("changed.txt", "before\n"),
            textEntry("removed.txt", "before\n"),
          ],
          reconciliation: [
            { path: "changed.txt", driver: "text" },
            { path: "removed.txt", driver: "text" },
          ],
        },
        after: textProjection("changed.txt", "after\n"),
        async readCurrent(projectionPath) {
          reads.push(projectionPath);
          return textEntry(projectionPath, "before\n");
        },
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          "Package Addition projection may not delete path: removed.txt",
        ),
    );
    assert.deepStrictEqual(reads, []);
  });
});

const rootValue = "24.16.0";
const driftedValue = "999";
const declaredConfigPath = "container/config.json";
const declaredLauncherPath = "deploy/launcher.txt";

const toolSlot: ProjectProjectionMirrorSlot = {
  id: "tool-version",
  location: { kind: "json-pointer", pointer: "/env/TOOL_VERSION" },
};
const toolAnchorSlot: ProjectProjectionMirrorSlot = {
  id: "tool-version-anchor",
  location: { kind: "text-anchor", name: "TOOL_VERSION" },
};

function mirrorStructuredProjection(
  value: unknown,
  projectionPath = declaredConfigPath,
): ProjectProjection {
  return {
    entries: [textEntry(projectionPath, `${JSON.stringify(value, null, 2)}\n`)],
    reconciliation: [
      {
        path: projectionPath,
        driver: "structured",
        mirrorSlots: [toolSlot],
      },
    ],
  };
}

function mirrorTextProjection(text: string): ProjectProjection {
  return {
    entries: [textEntry(declaredLauncherPath, text)],
    reconciliation: [
      {
        path: declaredLauncherPath,
        driver: "text",
        mirrorSlots: [toolAnchorSlot],
      },
    ],
  };
}

function anchoredText(defaultValue: string): string {
  return [
    "FROM base:1",
    "# @template-mirror TOOL_VERSION",
    `ARG TOOL_VERSION="${defaultValue}"`,
    "# @end-template-mirror",
    "RUN existing step",
    "",
  ].join("\n");
}

function structuredConfigPlan(value: unknown) {
  return {
    operations: [{ kind: "writeJson" as const, to: declaredConfigPath, value }],
    reconciliation: [
      {
        path: declaredConfigPath,
        driver: "structured" as const,
        mirrorSlots: [toolSlot],
      },
    ],
  };
}

function anchoredLauncherPlan(text: string) {
  return {
    operations: [
      { kind: "writeText" as const, to: declaredLauncherPath, text },
    ],
    reconciliation: [
      {
        path: declaredLauncherPath,
        driver: "text" as const,
        mirrorSlots: [toolAnchorSlot],
      },
    ],
  };
}

void describe("Declared mirror-slot coordination", () => {
  void it("reads only declared slot paths when Before equals After and restores the root value", async () => {
    const declared = mirrorStructuredProjection({
      env: { TOOL_VERSION: rootValue },
      name: "demo",
    });
    const undeclared = structuredProjection("workspace/plain.json", {
      keep: true,
    });
    const projection: ProjectProjection = {
      entries: [...declared.entries, ...undeclared.entries],
      reconciliation: [
        ...declared.reconciliation,
        ...undeclared.reconciliation,
      ],
    };
    const reads: string[] = [];

    const result = await reconcileProjectProjections({
      before: projection,
      after: projection,
      async readCurrent(projectionPath) {
        reads.push(projectionPath);
        if (projectionPath === declaredConfigPath) {
          return textEntry(
            projectionPath,
            `${JSON.stringify(
              {
                name: "demo",
                env: { TOOL_VERSION: driftedValue },
                userOnly: { retained: true },
              },
              null,
              4,
            )}\n`,
          );
        }
        return textEntry(
          projectionPath,
          `${JSON.stringify({ keep: false }, null, 2)}\n`,
        );
      },
    });

    assert.deepStrictEqual(reads, [declaredConfigPath]);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assertLength(result.mutations, 1);
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)) as unknown,
      {
        name: "demo",
        env: { TOOL_VERSION: rootValue },
        userOnly: { retained: true },
      },
    );
  });

  void it("carries one update action for a legal same-file delta and the coordinated slot", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-slot-delta-"),
    );
    const configPath = path.join(targetRoot, declaredConfigPath);

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            env: { TOOL_VERSION: driftedValue },
            features: { beta: false },
            userOnly: { retained: true },
          },
          null,
          2,
        )}\n`,
      );

      const applied = await reconcileAndApplyProjectProjections({
        targetRoot,
        before: structuredConfigPlan({
          env: { TOOL_VERSION: rootValue },
          features: { beta: false },
        }),
        after: structuredConfigPlan({
          env: { ADDITIONAL_TOOL: "1.4.0", TOOL_VERSION: rootValue },
          features: { beta: true },
        }),
      });

      assert.deepStrictEqual(applied, {
        ok: true,
        changedPaths: [declaredConfigPath],
        actions: [
          { path: declaredConfigPath, driver: "structured", action: "update" },
        ],
      });
      const written = await readFile(configPath, "utf8");
      assert.deepStrictEqual(JSON.parse(written) as unknown, {
        env: { ADDITIONAL_TOOL: "1.4.0", TOOL_VERSION: rootValue },
        features: { beta: true },
        userOnly: { retained: true },
      });

      const repeated = await reconcileAndApplyProjectProjections({
        targetRoot,
        before: structuredConfigPlan({
          env: { TOOL_VERSION: rootValue },
          features: { beta: false },
        }),
        after: structuredConfigPlan({
          env: { ADDITIONAL_TOOL: "1.4.0", TOOL_VERSION: rootValue },
          features: { beta: true },
        }),
      });
      assert.deepStrictEqual(repeated, {
        ok: true,
        changedPaths: [],
        actions: [],
      });
      assert.strictEqual(await readFile(configPath, "utf8"), written);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("keeps a deleted slot absent while a legal new key lands in the same file", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-slot-deleted-"),
    );
    const configPath = path.join(targetRoot, declaredConfigPath);

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({ env: {}, userOnly: true }, null, 2)}\n`,
      );

      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot,
          before: structuredConfigPlan({ env: { TOOL_VERSION: rootValue } }),
          after: structuredConfigPlan({
            env: { ADDITIONAL_TOOL: "1.4.0", TOOL_VERSION: rootValue },
          }),
        }),
        {
          ok: true,
          changedPaths: [declaredConfigPath],
          actions: [
            {
              path: declaredConfigPath,
              driver: "structured",
              action: "update",
            },
          ],
        },
      );
      const merged = JSON.parse(await readFile(configPath, "utf8")) as unknown;
      assert.deepStrictEqual(merged, {
        env: { ADDITIONAL_TOOL: "1.4.0" },
        userOnly: true,
      });
      assert.ok(!hasProperty(merged, ["env", "TOOL_VERSION"]));
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("adds a slot value that only After declares", async () => {
    const result = await reconcileProjectProjections({
      before: mirrorStructuredProjection({ env: { OTHER: "keep" } }),
      after: mirrorStructuredProjection({
        env: { OTHER: "keep", TOOL_VERSION: rootValue },
      }),
      async readCurrent() {
        return textEntry(
          declaredConfigPath,
          `${JSON.stringify({ env: { OTHER: "keep" } }, null, 2)}\n`,
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)) as unknown,
      { env: { OTHER: "keep", TOOL_VERSION: rootValue } },
    );
  });

  testEach(
    [
      { absentShape: "missing file", current: undefined },
      {
        absentShape: "directory in place of the file",
        current: { path: declaredConfigPath, kind: "directory" as const },
      },
    ],
    "skips a pure coordination path whose Current is $absentShape",
    async ({ current }) => {
      const projection = mirrorStructuredProjection({
        env: { TOOL_VERSION: rootValue },
      });

      assert.deepStrictEqual(
        await reconcileProjectProjections({
          before: projection,
          after: projection,
          async readCurrent() {
            return current;
          },
        }),
        { ok: true, mutations: [] },
      );
    },
  );

  void it("keeps the presence conflict when a declared path also carries a delta", async () => {
    const result = await reconcileProjectProjections({
      before: mirrorStructuredProjection({ env: { TOOL_VERSION: rootValue } }),
      after: mirrorStructuredProjection({
        env: { TOOL_VERSION: rootValue },
        features: { beta: true },
      }),
      async readCurrent() {
        return undefined;
      },
    });

    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          path: declaredConfigPath,
          driver: "structured",
          reason: "Path presence changed concurrently",
        }),
      ],
    });
  });

  void it("reports no change when a declared slot already equals the root value in another format", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-slot-format-"),
    );
    const configPath = path.join(targetRoot, declaredConfigPath);
    const formatted = `${JSON.stringify(
      { userOnly: { retained: true }, env: { TOOL_VERSION: rootValue } },
      null,
      4,
    )}\n`;

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, formatted);

      const plan = structuredConfigPlan({
        env: { TOOL_VERSION: rootValue },
        name: "demo",
      });
      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot,
          before: plan,
          after: plan,
        }),
        { ok: true, changedPaths: [], actions: [] },
      );
      assert.strictEqual(await readFile(configPath, "utf8"), formatted);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  testEach(
    [
      {
        unusableShape: "JSON with comments",
        currentBytes: new TextEncoder().encode(
          `{\n  // pinned by hand\n  "env": { "TOOL_VERSION": "${rootValue}" }\n}\n`,
        ),
        diagnostic: "Current structured content is not valid JSON",
      },
      {
        unusableShape: "non-string slot value",
        currentBytes: new TextEncoder().encode(
          '{\n  "env": { "TOOL_VERSION": 24 }\n}\n',
        ),
        diagnostic: "holds a non-string Current value",
      },
      {
        unusableShape: "binary bytes",
        currentBytes: new Uint8Array([0xff, 0xfe, 0xfd, 0xfe, 0xff]),
        diagnostic: "Current structured content is not valid JSON",
      },
    ],
    "fails atomically with zero writes for an unusable $unusableShape declared slot",
    async ({ currentBytes, diagnostic }) => {
      const targetRoot = await mkdtemp(
        path.join(tmpdir(), "template-projection-slot-invalid-"),
      );
      const configPath = path.join(targetRoot, declaredConfigPath);
      const reservedPath = path.join(targetRoot, "services/new/package.json");

      try {
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(configPath, currentBytes);

        assertDeepStrictEqualWithMatchers(
          await reconcileAndApplyProjectProjections({
            targetRoot,
            before: structuredConfigPlan({
              env: { TOOL_VERSION: rootValue },
            }),
            after: {
              operations: [
                ...structuredConfigPlan({ env: { TOOL_VERSION: rootValue } })
                  .operations,
                {
                  kind: "writeJson",
                  to: "services/new/package.json",
                  value: { name: "@demo/new" },
                },
              ],
              reconciliation: structuredConfigPlan({
                env: { TOOL_VERSION: rootValue },
              }).reconciliation,
            },
            preconditions: [
              {
                path: "services/new",
                kind: "must-not-exist",
                reason:
                  "Package Path services/new already exists and cannot be used for a new Package Addition",
              },
            ],
          }),
          {
            ok: false,
            conflicts: [
              objectContaining({
                path: declaredConfigPath,
                driver: "structured",
                reason: stringContaining(diagnostic),
              }),
            ],
          },
        );
        assert.deepStrictEqual(
          await readFile(configPath),
          Buffer.from(currentBytes),
        );
        await assert.rejects(stat(reservedPath), (error) => {
          assertPartialDeepStrictEqual(error, {
            code: "ENOENT",
          });
          return true;
        });
      } finally {
        await rm(targetRoot, { recursive: true, force: true });
      }
    },
  );

  void it("restores the anchored default while preserving out-of-region bytes exactly", async () => {
    const projection = mirrorTextProjection(anchoredText(rootValue));
    const result = await reconcileProjectProjections({
      before: projection,
      after: projection,
      async readCurrent() {
        return textEntry(
          declaredLauncherPath,
          anchoredText(driftedValue).replace(
            "RUN existing step\n",
            "RUN existing step\nRUN user step\n",
          ),
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(
      decoder.decode(result.mutations[0]!.content),
      anchoredText(rootValue).replace(
        "RUN existing step\n",
        "RUN existing step\nRUN user step\n",
      ),
    );
  });

  void it("replaces the owned block when Before has no block and keeps bytes outside it", async () => {
    const result = await reconcileProjectProjections({
      before: mirrorTextProjection("FROM base:1\nRUN existing step\n"),
      after: mirrorTextProjection(anchoredText(rootValue)),
      async readCurrent() {
        return textEntry(
          declaredLauncherPath,
          anchoredText(driftedValue).replace(
            "RUN existing step\n",
            "RUN existing step\nRUN user step\n",
          ),
        );
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assertLength(result.mutations, 1);
    assert.strictEqual(
      decoder.decode(result.mutations[0]!.content),
      anchoredText(rootValue).replace(
        "RUN existing step\n",
        "RUN existing step\nRUN user step\n",
      ),
    );
  });

  void it("fails atomically when Before holds the anchor more than once", async () => {
    const result = await reconcileProjectProjections({
      before: mirrorTextProjection(
        anchoredText(rootValue) + anchoredText(rootValue),
      ),
      after: mirrorTextProjection(anchoredText(rootValue)),
      async readCurrent() {
        return textEntry(declaredLauncherPath, anchoredText(driftedValue));
      },
    });

    assert.ok(!hasProperty(result, "mutations"));
    assertDeepStrictEqualWithMatchers(result, {
      ok: false,
      conflicts: [
        objectContaining({
          path: declaredLauncherPath,
          driver: "text",
          location: "TOOL_VERSION",
          reason: stringContaining("in Before could not be located"),
        }),
      ],
    });
  });

  void it("lands a template text delta together with the coordinated anchor", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-slot-text-delta-"),
    );
    const launcherPath = path.join(targetRoot, declaredLauncherPath);

    try {
      await mkdir(path.dirname(launcherPath), { recursive: true });
      await writeFile(
        launcherPath,
        anchoredText(driftedValue).replace(
          "RUN existing step\n",
          "RUN existing step\nRUN user step\n",
        ),
      );

      assert.deepStrictEqual(
        await reconcileAndApplyProjectProjections({
          targetRoot,
          before: anchoredLauncherPlan(anchoredText(rootValue)),
          after: anchoredLauncherPlan(
            `# generated header\n${anchoredText(rootValue)}`,
          ),
        }),
        {
          ok: true,
          changedPaths: [declaredLauncherPath],
          actions: [
            { path: declaredLauncherPath, driver: "text", action: "update" },
          ],
        },
      );
      assert.strictEqual(
        await readFile(launcherPath, "utf8"),
        `# generated header\n${anchoredText(rootValue).replace(
          "RUN existing step\n",
          "RUN existing step\nRUN user step\n",
        )}`,
      );
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  testEach(
    [
      {
        brokenAnchor: "markers removed but the carrier assignment remains",
        current: `FROM base:1\nARG TOOL_VERSION="${driftedValue}"\n# @end-template-mirror\nRUN existing step\n`,
      },
      {
        brokenAnchor: "marker removed but the reference remains",
        current: "FROM node:${TOOL_VERSION}-slim\nRUN existing step\n",
      },
      {
        brokenAnchor: "the anchored region is duplicated",
        current: anchoredText(driftedValue) + anchoredText(driftedValue),
      },
      {
        brokenAnchor: "the anchored region holds two lines",
        current: anchoredText(driftedValue).replace(
          `ARG TOOL_VERSION="${driftedValue}"\n`,
          `ARG TOOL_VERSION="${driftedValue}"\nARG EXTRA_TOOL="1"\n`,
        ),
      },
    ],
    "fails when $brokenAnchor while the carrier or reference is still present",
    async ({ current }) => {
      const projection = mirrorTextProjection(anchoredText(rootValue));
      const result = await reconcileProjectProjections({
        before: projection,
        after: projection,
        async readCurrent() {
          return textEntry(declaredLauncherPath, current);
        },
      });

      assertDeepStrictEqualWithMatchers(result, {
        ok: false,
        conflicts: [
          objectContaining({
            path: declaredLauncherPath,
            driver: "text",
            location: "TOOL_VERSION",
            reason: stringContaining("anchor could not be located"),
          }),
        ],
      });
    },
  );

  void it("keeps a text slot absent when the carrier and every reference exited", async () => {
    const projection = mirrorTextProjection(anchoredText(rootValue));

    assert.deepStrictEqual(
      await reconcileProjectProjections({
        before: projection,
        after: projection,
        async readCurrent() {
          return textEntry(
            declaredLauncherPath,
            "FROM base:1\nRUN existing step\n",
          );
        },
      }),
      { ok: true, mutations: [] },
    );
  });

  void it("rolls back the coordinated slot together with the other mutations", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-slot-rollback-"),
    );
    const configPath = path.join(targetRoot, declaredConfigPath);
    const guidePath = path.join(targetRoot, "docs/guide.md");
    const committed: string[] = [];
    const reconcile = createProjectProjectionReconciler({
      async commitMutation(options) {
        committed.push(options.relativePath);
        if (committed.length === 2) {
          throw new Error("injected mirror-slot commit failure");
        }
        await options.commit();
      },
    });
    const before = {
      operations: [
        ...structuredConfigPlan({ env: { TOOL_VERSION: rootValue } })
          .operations,
        { kind: "writeText" as const, to: "docs/guide.md", text: "before\n" },
      ],
      reconciliation: structuredConfigPlan({
        env: { TOOL_VERSION: rootValue },
      }).reconciliation,
    };
    const after = {
      operations: [
        ...structuredConfigPlan({ env: { TOOL_VERSION: rootValue } })
          .operations,
        { kind: "writeText" as const, to: "docs/guide.md", text: "after\n" },
      ],
      reconciliation: structuredConfigPlan({
        env: { TOOL_VERSION: rootValue },
      }).reconciliation,
    };

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await mkdir(path.dirname(guidePath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({ env: { TOOL_VERSION: driftedValue } }, null, 2)}\n`,
      );
      await writeFile(guidePath, "before\n");
      const driftedConfig = await readFile(configPath, "utf8");

      await assert.rejects(
        reconcile({ targetRoot, before, after }),
        (error) =>
          error instanceof Error &&
          error.message.includes("injected mirror-slot commit failure"),
      );
      assert.strictEqual(await readFile(configPath, "utf8"), driftedConfig);
      assert.strictEqual(await readFile(guidePath, "utf8"), "before\n");
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  testEach(
    [
      {
        malformed: "a JSON Pointer location on the text driver",
        driver: "text" as const,
        slot: toolSlot,
        diagnostic: "text mirror slots require a named text anchor",
      },
      {
        malformed: "a named text anchor on the structured driver",
        driver: "structured" as const,
        slot: toolAnchorSlot,
        diagnostic: "structured mirror slots require a JSON Pointer location",
      },
      {
        malformed: "an invalid JSON Pointer",
        driver: "structured" as const,
        slot: {
          id: "bad-pointer",
          location: { kind: "json-pointer", pointer: "/env/~2" },
        } satisfies ProjectProjectionMirrorSlot,
        diagnostic: "must be an RFC 6901 JSON Pointer",
      },
      {
        malformed: "a repeated slot id",
        driver: "structured" as const,
        slot: { id: "tool-version", location: { ...toolSlot.location } },
        duplicateId: true,
        diagnostic: "mirror slot ids must be unique and non-empty",
      },
      {
        malformed: "a slot name made of separate words",
        driver: "text" as const,
        slot: {
          id: "spaced",
          location: { kind: "text-anchor", name: "TOOL VERSION" },
        } satisfies ProjectProjectionMirrorSlot,
        diagnostic: "text mirror slot names must be single non-empty tokens",
      },
    ],
    "rejects malformed declarations such as $malformed before reading Current",
    async (scenario) => {
      const { driver, slot, diagnostic } = scenario;
      let reads = 0;
      const slots =
        "duplicateId" in scenario && scenario.duplicateId
          ? [slot, toolSlot]
          : [slot];
      const projection: ProjectProjection = {
        entries: [
          textEntry(declaredConfigPath, '{"env":{"TOOL_VERSION":"x"}}\n'),
        ],
        reconciliation: [
          { path: declaredConfigPath, driver, mirrorSlots: slots },
        ],
      };

      await assertRejectsContaining(
        reconcileProjectProjections({
          before: projection,
          after: projection,
          async readCurrent() {
            reads += 1;
            return projection.entries[0];
          },
        }),
        diagnostic,
      );
      assert.strictEqual(reads, 0);
    },
  );

  void it("carries the declaration through plan preflight and materialization", async () => {
    const operations = [
      {
        kind: "writeText" as const,
        to: declaredLauncherPath,
        text: anchoredText(rootValue),
      },
    ];
    const reconciliation = [
      {
        path: declaredLauncherPath,
        driver: "text" as const,
        mirrorSlots: [toolAnchorSlot],
      },
    ];

    assert.deepStrictEqual(
      validateProjectProjectionPlan({ operations, reconciliation }),
      [],
    );
    const projection = await materializeProjectProjection({
      operations,
      reconciliation,
    });
    assert.deepStrictEqual(projection.reconciliation, reconciliation);

    const undeclared = await materializeProjectProjection({ operations });
    assert.deepStrictEqual(undeclared.reconciliation, [
      { path: declaredLauncherPath, driver: "text" },
    ]);
  });
});

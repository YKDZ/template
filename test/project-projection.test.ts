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

import { describe, expect, it } from "vitest";

import {
  createProjectProjectionReconciler,
  materializeProjectProjection,
  reconcileAndApplyProjectProjections,
  reconcileProjectProjections,
  type CurrentProjectProjectionEntry,
  type ProjectProjection,
  type ProjectProjectionEntry,
} from "#template-core/project-projection";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

describe("Project Projection materialization", () => {
  it("materializes planner-owned text at any safe projection path", async () => {
    await expect(
      materializeProjectProjection({
        operations: [
          {
            kind: "writeText",
            to: "policies/custom.rules",
            text: "allow generated fact\n",
          },
        ],
      }),
    ).resolves.toEqual({
      entries: [textEntry("policies/custom.rules", "allow generated fact\n")],
      reconciliation: [{ path: "policies/custom.rules", driver: "text" }],
    });
  });

  it("uses planner-declared JSON key order instead of recognizing filenames", async () => {
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

    expect(decoder.decode(generic.entries[0]!.content)).toBe(
      '{\n  "alpha": true,\n  "entry": {\n    "default": "./dist.js",\n    "source": "./src.ts",\n    "types": "./dist.d.ts"\n  },\n  "name": "demo",\n  "zeta": true\n}\n',
    );
    expect(decoder.decode(declared.entries[0]!.content)).toBe(
      '{\n  "name": "demo",\n  "zeta": true,\n  "alpha": true,\n  "entry": {\n    "source": "./src.ts",\n    "types": "./dist.d.ts",\n    "default": "./dist.js"\n  }\n}\n',
    );
  });

  it("rejects isolated setExecutable as an incomplete Project Projection", async () => {
    await expect(
      materializeProjectProjection({
        operations: [
          {
            kind: "setExecutable",
            path: "scripts/run.sh",
            executable: true,
          },
        ],
      }),
    ).rejects.toThrow(
      "Project Projection setExecutable requires a preceding content-producing operation: scripts/run.sh",
    );
  });

  it("normalizes equivalent final states independently of Renderer operation count and order", async () => {
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

    expect(repeatedOperations).toEqual(consolidatedOperations);
    expect(repeatedOperations.entries).toEqual([
      {
        path: "config.json",
        kind: "file",
        content: new TextEncoder().encode(
          '{\n  "enabled": true,\n  "retries": 2\n}\n',
        ),
        mode: 0o111,
      },
    ]);
    expect(repeatedOperations.reconciliation).toEqual([
      { path: "config.json", driver: "structured" },
    ]);
  });

  it("uses generic planner reconciliation metadata to select a structured driver", async () => {
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

    expect(projection.reconciliation).toEqual([
      { path: "policy.md", driver: "structured" },
    ]);
  });

  it("reconciles a mode-only final-state delta while preserving compatible Current content", async () => {
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

    expect(before.entries[0]?.content).toEqual(after.entries[0]?.content);
    expect(before.entries[0]?.mode).toBe(0);
    expect(after.entries[0]?.mode).toBe(0o111);

    const result = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return textEntry("README.md", "user content\n");
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mutations).toEqual([
      {
        path: "README.md",
        kind: "file",
        content: encoder.encode("user content\n"),
        mode: 0o111,
      },
    ]);
  });

  it("applies a mode-only delta without replacing Current content", async () => {
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

      await expect(
        reconcileAndApplyProjectProjections({
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
      ).resolves.toEqual({
        ok: true,
        changedPaths: ["README.md"],
        actions: [{ path: "README.md", driver: "text", action: "update" }],
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(
        "user content\n",
      );
      expect((await stat(readmePath)).mode & 0o111).toBe(0o111);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("reads only the Addition Delta so equal Before/After template output cannot upgrade Current", async () => {
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

    expect(reads).toEqual(["policy.txt"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mutations).toHaveLength(1);
    expect(decoder.decode(result.mutations[0]!.content)).toBe(
      "first\nprivate\ncommon\ngenerated\nlast\n",
    );
  });

  it("recursively composes one-sided structured changes without erasing unrelated Current keys", async () => {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(decoder.decode(result.mutations[0]!.content))).toEqual({
      generated: { enabled: true },
      required: { source: "package-addition" },
      settings: { timeout: 20 },
      userOnly: { retained: true },
    });
  });

  it("reports an incompatible concurrent scalar change at its structured location", async () => {
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

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
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
    expect(result).not.toHaveProperty("mutations");
  });

  it.each([
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
  ])(
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

      expect(result).toEqual({
        ok: false,
        conflicts: [
          expect.objectContaining({
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
      expect(result).not.toHaveProperty("mutations");
    },
  );

  it("recursively combines concurrent object additions only at a missing location", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", {}),
      after: structuredProjection("config.json", {
        setting: { generated: true },
      }),
      async readCurrent() {
        return textEntry("config.json", '{"setting":{"userRetained":true}}\n');
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(decoder.decode(result.mutations[0]!.content))).toEqual({
      setting: { userRetained: true, generated: true },
    });
  });

  it("rejects undefined because it is not a JSON structured value", async () => {
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

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
          location: "",
          reason: expect.stringContaining(
            "Before structured content is not valid JSON",
          ),
          before: '{"setting":undefined}\n',
        }),
      ],
    });
  });

  it("returns a structured parse diagnostic for invalid Current JSON", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", { enabled: false }),
      after: structuredProjection("config.json", { enabled: true }),
      async readCurrent() {
        return textEntry("config.json", '{"enabled":');
      },
    });

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
          path: "config.json",
          driver: "structured",
          location: "",
          reason: expect.stringContaining(
            "Current structured content is not valid JSON",
          ),
          current: '{"enabled":',
        }),
      ],
    });
  });

  it("uses the root pointer for a structured file-level conflict", async () => {
    const result = await reconcileProjectProjections({
      before: structuredProjection("config.json", { enabled: false }),
      after: structuredProjection("config.json", { enabled: true }),
      async readCurrent() {
        return undefined;
      },
    });

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
          path: "config.json",
          driver: "structured",
          location: "",
          reason: "Path presence changed concurrently",
        }),
      ],
    });
  });

  it("preserves Current scalar members and appends After members for an explicit identity set", async () => {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(decoder.decode(result.mutations[0]!.content))).toEqual([
      "user-first",
      "base",
      "user-last",
      "generated",
    ]);
  });

  it("recursively reconciles matching object members by stable identity", async () => {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(decoder.decode(result.mutations[0]!.content))).toEqual({
      members: [
        { id: "user", settings: { retained: true } },
        {
          id: "base",
          settings: { timeout: 20, required: true },
        },
        { id: "generated", settings: {} },
      ],
    });
  });

  it("reconciles generated members by projection identity when visible fields change", async () => {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(decoder.decode(result.mutations[0]!.content))).toEqual({
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
    });
  });

  it("distinguishes object members by multiple identity fields", async () => {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(decoder.decode(result.mutations[0]!.content))).toEqual({
      members: [
        { owner: "user", name: "shared" },
        { owner: "base", name: "shared" },
        { owner: "generated", name: "shared" },
      ],
    });
  });

  it("conflicts when matching object members change the same scalar incompatibly", async () => {
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

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
          driver: "structured",
          location: "/members/1/value",
          reason: "Current and After contain incompatible scalar changes",
          before: "1",
          current: "2",
          after: "3",
        }),
      ],
    });
    expect(result).not.toHaveProperty("mutations");
  });

  it("decodes identity-set pointers and escapes structured conflict tokens", async () => {
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

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
          location: "/groups~1primary~0set/0/value",
          before: "1",
          current: "2",
          after: "3",
        }),
      ],
    });
  });

  it("rejects an identity-set policy whose structured location is not an array", async () => {
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

    await expect(
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
    ).rejects.toThrow(
      "Project Projection identity-set location must reference an array: config.json /members",
    );
    expect(reads).toBe(0);
  });

  it.each(["members", "/members/~", "/members/~2"])(
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

      await expect(
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
      ).rejects.toThrow(
        "Project Projection identity-set location must be an RFC 6901 JSON Pointer",
      );
      expect(reads).toBe(0);
    },
  );

  it.each([
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
  ])(
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

      expect(result).toEqual({
        ok: false,
        conflicts: [
          expect.objectContaining({
            location: "/members",
            reason: expect.stringContaining(`Current ${diagnostic}`),
          }),
        ],
      });
      expect(result).not.toHaveProperty("mutations");
    },
  );

  it("keeps undeclared arrays atomic", async () => {
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

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({
          location: "/members",
          reason: "Current and After contain incompatible atomic array changes",
        }),
      ],
    });
  });

  it("advances tool-owned state when Current exactly matches Before", async () => {
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

    expect(result).toEqual({
      ok: true,
      mutations: after.entries,
    });
  });

  it.each<{
    readonly staleDimension: string;
    readonly current: CurrentProjectProjectionEntry;
    readonly currentDescription: string;
  }>([
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
      currentDescription: '{\n  "schemaVersion": 1,\n  "value": "before"\n}\n',
    },
    {
      staleDimension: "kind",
      current: { path: "state.json", kind: "directory" },
      currentDescription: "directory",
    },
  ])(
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

      expect(result).toEqual({
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
      expect(result).not.toHaveProperty("mutations");
    },
  );

  it("rejects duplicate projection paths before reading Current", async () => {
    const duplicateBefore: ProjectProjection = {
      entries: [
        textEntry("same.txt", "first\n"),
        textEntry("same.txt", "second\n"),
      ],
      reconciliation: [{ path: "same.txt", driver: "text" }],
    };

    await expect(
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
    ).rejects.toThrow("Project Projection paths must be unique: same.txt");
  });

  it("rejects escaping raw Projection entry paths before reading Current", async () => {
    let reads = 0;

    await expect(
      reconcileProjectProjections({
        before: textProjection("../escape.txt", "before\n"),
        after: textProjection("../escape.txt", "after\n"),
        async readCurrent() {
          reads += 1;
          return textEntry("../escape.txt", "before\n");
        },
      }),
    ).rejects.toThrow(
      "Project Projection entry path must be a normalized safe relative path: ../escape.txt",
    );
    expect(reads).toBe(0);
  });

  it("rejects non-normalized reconciliation paths before reading Current", async () => {
    let reads = 0;

    await expect(
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
    ).rejects.toThrow(
      "Project Projection reconciliation path must be a normalized safe relative path: ./policy.txt",
    );
    expect(reads).toBe(0);
  });

  it.each([
    "",
    "/absolute.txt",
    "./policy.txt",
    "nested/../policy.txt",
    "nested//policy.txt",
    "nested/",
    String.raw`C:\absolute.txt`,
  ])("rejects unsafe raw Projection path %j", async (projectionPath) => {
    let reads = 0;

    await expect(
      reconcileProjectProjections({
        before: textProjection(projectionPath, "before\n"),
        after: textProjection(projectionPath, "after\n"),
        async readCurrent() {
          reads += 1;
          return textEntry(projectionPath, "before\n");
        },
      }),
    ).rejects.toThrow("must be a normalized safe relative path");
    expect(reads).toBe(0);
  });

  it("does not apply an escaping materialized path outside the target root", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-projection-containment-"),
    );
    const targetRoot = path.join(workspace, "project");
    const outsidePath = path.join(workspace, "outside.json");

    try {
      await writeFile(outsidePath, '{"owner":"user"}\n');

      await expect(
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
      ).rejects.toThrow(
        "Project Projection path escapes its root: ../outside.json",
      );
      await expect(readFile(outsidePath, "utf8")).resolves.toBe(
        '{"owner":"user"}\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires one stable reconciliation driver per projected path before reading Current", async () => {
    await expect(
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
    ).rejects.toThrow(
      "Project Projection requires one reconciliation driver: same.txt",
    );
  });

  it("requires reconciliation policy metadata to remain stable before reading Current", async () => {
    let reads = 0;
    const entry = textEntry("config.json", '{"members":["base"]}\n');

    await expect(
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
    ).rejects.toThrow(
      "Project Projection reconciliation policy changed for config.json",
    );
    expect(reads).toBe(0);
  });

  it("obeys the basic three-way laws and repeated application is idempotent", async () => {
    const before = textProjection("alpha.txt", "before\n");
    const after = textProjection("alpha.txt", "after\n");
    const first = await reconcileProjectProjections({
      before,
      after,
      async readCurrent() {
        return textEntry("alpha.txt", "before\n");
      },
    });

    expect(first).toEqual({
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
    expect(repeated).toEqual({ ok: true, mutations: [] });

    const unchangedProjection = textProjection("stable.txt", "projected\n");
    await expect(
      reconcileProjectProjections({
        before: unchangedProjection,
        after: unchangedProjection,
        async readCurrent(projectionPath) {
          throw new Error(`unexpected read: ${projectionPath}`);
        },
      }),
    ).resolves.toEqual({ ok: true, mutations: [] });
  });

  it("returns conflicts without a partial mutation result", async () => {
    const result = await reconcileProjectProjections({
      before: textProjection("alpha.txt", "shared\n"),
      after: textProjection("alpha.txt", "generated\n"),
      async readCurrent() {
        return textEntry("alpha.txt", "user\n");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).not.toHaveProperty("mutations");
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        path: "alpha.txt",
        driver: "text",
        reason: "Current and After contain incompatible text changes",
        region: expect.any(Object),
      }),
    ]);
  });

  it("reports each text conflict as a concise line region", async () => {
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

    expect(result).toEqual({
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

  it("reports incompatible binary content without throwing or serializing bytes", async () => {
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

    expect(result).toEqual({
      ok: false,
      conflicts: [
        {
          path: "asset.bin",
          driver: "text",
          attribute: "binary-content",
          reason: "Current and After contain incompatible binary changes",
          before: expect.stringMatching(
            /^<2 binary bytes; sha256=[a-f0-9]{64}>$/u,
          ),
          current: expect.stringMatching(
            /^<2 binary bytes; sha256=[a-f0-9]{64}>$/u,
          ),
          after: expect.stringMatching(
            /^<2 binary bytes; sha256=[a-f0-9]{64}>$/u,
          ),
        },
      ],
    });
  });

  it("reports incompatible executable-mode changes as a file attribute conflict", async () => {
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

    expect(result).toEqual({
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

  it("reports a Current file-kind conflict before mutating the workspace", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-kind-conflict-"),
    );
    const readmePath = path.join(targetRoot, "README.md");

    try {
      await mkdir(readmePath);
      await writeFile(path.join(readmePath, "retained.txt"), "user data\n");

      await expect(
        reconcileAndApplyProjectProjections({
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
      ).resolves.toEqual({
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
      });
      await expect(
        readFile(path.join(readmePath, "retained.txt"), "utf8"),
      ).resolves.toBe("user data\n");
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("rolls back repository files and canonical metadata after a commit failure", async () => {
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

      await expect(
        reconcile({
          targetRoot,
          before: sourceOperation("before\n"),
          after: sourceOperation("after\n"),
        }),
      ).rejects.toThrow("injected projection commit failure");
      await expect(
        readFile(path.join(targetRoot, "alpha.md"), "utf8"),
      ).resolves.toBe("before\n");
      await expect(
        readFile(path.join(targetRoot, ".template/state.json"), "utf8"),
      ).resolves.toBe('{\n  "state": "before"\n}\n');
      expect(committedPaths).toHaveLength(2);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("rejects a concurrently created reserved path at the atomic commit boundary with zero transaction writes", async () => {
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

      expect(result).toMatchObject({
        ok: false,
        conflicts: [
          {
            path: "services/race",
            driver: "precondition",
            reason: expect.stringContaining(
              "Package Path services/race already exists",
            ),
          },
        ],
      });
      await expect(
        readFile(path.join(targetRoot, "root.txt"), "utf8"),
      ).resolves.toBe("before\n");
      await expect(
        readFile(path.join(targetRoot, "services/race/OWNER"), "utf8"),
      ).resolves.toBe("user\n");
      await expect(
        stat(path.join(targetRoot, "services/race/package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("rejects projection deletions before reading Current", async () => {
    const reads: string[] = [];

    await expect(
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
    ).rejects.toThrow(
      "Package Addition projection may not delete path: removed.txt",
    );
    expect(reads).toEqual([]);
  });
});

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderProject } from "../src/renderer.js";

async function tempWorkspace(): Promise<{ sourceRoot: string; targetRoot: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "template-renderer-"));
  return {
    sourceRoot: path.join(workspace, "source"),
    targetRoot: path.join(workspace, "target")
  };
}

describe("renderer", () => {
  it("copies checked source files with constrained filename variables", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();
    const sourceFile = path.join(sourceRoot, "bin/tool.sh");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "#!/usr/bin/env sh\necho checked\n", "utf8");
    await chmod(sourceFile, 0o755);

    await renderProject({
      sourceRoot,
      targetRoot,
      variables: { commandName: "demo-tool" },
      operations: [
        {
          kind: "copyFile",
          from: "bin/tool.sh",
          to: "bin/{{commandName}}"
        }
      ]
    });

    const targetFile = path.join(targetRoot, "bin/demo-tool");
    await expect(readFile(targetFile, "utf8")).resolves.toBe(
      "#!/usr/bin/env sh\necho checked\n"
    );
    expect((await stat(targetFile)).mode & 0o111).toBe(0o111);
  });

  it("writes and merges JSON deterministically", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "writeJson",
          to: "package.json",
          value: {
            scripts: { test: "vitest" },
            name: "demo"
          }
        },
        {
          kind: "mergeJson",
          to: "package.json",
          value: {
            scripts: { build: "tsc -p tsconfig.json" },
            private: true
          }
        }
      ]
    });

    await expect(readFile(path.join(targetRoot, "package.json"), "utf8")).resolves.toBe(
      [
        "{",
        '  "name": "demo",',
        '  "private": true,',
        '  "scripts": {',
        '    "build": "tsc -p tsconfig.json",',
        '    "test": "vitest"',
        "  }",
        "}",
        ""
      ].join("\n")
    );
  });

  it("serializes equivalent JSON object key orders canonically", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "writeJson",
          to: "a.json",
          value: {
            z: 1,
            a: {
              y: 2,
              x: 1
            },
            list: [
              {
                b: 2,
                a: 1
              }
            ]
          }
        },
        {
          kind: "writeJson",
          to: "b.json",
          value: {
            list: [
              {
                a: 1,
                b: 2
              }
            ],
            a: {
              x: 1,
              y: 2
            },
            z: 1
          }
        },
        {
          kind: "writeJson",
          to: "merged-a.json",
          value: {
            z: true,
            nested: {
              b: 2
            }
          }
        },
        {
          kind: "mergeJson",
          to: "merged-a.json",
          value: {
            a: true,
            nested: {
              a: 1
            }
          }
        },
        {
          kind: "writeJson",
          to: "merged-b.json",
          value: {
            nested: {
              b: 2
            },
            z: true
          }
        },
        {
          kind: "mergeJson",
          to: "merged-b.json",
          value: {
            nested: {
              a: 1
            },
            a: true
          }
        }
      ]
    });

    const canonical = [
      "{",
      '  "a": {',
      '    "x": 1,',
      '    "y": 2',
      "  },",
      '  "list": [',
      "    {",
      '      "a": 1,',
      '      "b": 2',
      "    }",
      "  ],",
      '  "z": 1',
      "}",
      ""
    ].join("\n");
    await expect(readFile(path.join(targetRoot, "a.json"), "utf8")).resolves.toBe(
      canonical
    );
    await expect(readFile(path.join(targetRoot, "b.json"), "utf8")).resolves.toBe(
      canonical
    );
    await expect(
      readFile(path.join(targetRoot, "merged-a.json"), "utf8")
    ).resolves.toBe(await readFile(path.join(targetRoot, "merged-b.json"), "utf8"));
  });

  it("writes limited foundation text files", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "writeText",
          to: "README.md",
          text: "# Demo\n\nGenerated foundation text.\n"
        },
        {
          kind: "writeText",
          to: ".gitignore",
          text: "node_modules\ndist\n"
        }
      ]
    });

    await expect(readFile(path.join(targetRoot, "README.md"), "utf8")).resolves.toBe(
      "# Demo\n\nGenerated foundation text.\n"
    );
    await expect(readFile(path.join(targetRoot, ".gitignore"), "utf8")).resolves.toBe(
      "node_modules\ndist\n"
    );
  });

  it("updates executable bits without changing file contents", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "writeText",
          to: ".npmrc",
          text: "shell-emulator=true\n"
        },
        {
          kind: "setExecutable",
          path: ".npmrc",
          executable: true
        }
      ]
    });

    const renderedFile = path.join(targetRoot, ".npmrc");
    await expect(readFile(renderedFile, "utf8")).resolves.toBe("shell-emulator=true\n");
    expect((await stat(renderedFile)).mode & 0o111).toBe(0o111);
  });

  it("resolves constrained filename variables for all target path operations", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();
    const targetSourceFile = path.join(targetRoot, "src/index.ts");
    await mkdir(path.dirname(targetSourceFile), { recursive: true });
    await writeFile(
      targetSourceFile,
      [
        "/* @template-anchor exports */",
        "export const existing = true;",
        ""
      ].join("\n"),
      "utf8"
    );

    await renderProject({
      sourceRoot,
      targetRoot,
      variables: {
        configName: "demo",
        entryName: "index",
        npmrcName: ".npmrc",
        readmeName: "README"
      },
      operations: [
        {
          kind: "writeJson",
          to: ".project-kit/{{configName}}.json",
          value: {
            generated: true
          }
        },
        {
          kind: "mergeJson",
          to: ".project-kit/{{configName}}.json",
          value: {
            preset: "ts-lib"
          }
        },
        {
          kind: "writeText",
          to: "{{readmeName}}.md",
          text: "# Demo\n"
        },
        {
          kind: "writeText",
          to: "{{npmrcName}}",
          text: "shell-emulator=true\n"
        },
        {
          kind: "setExecutable",
          path: "{{npmrcName}}",
          executable: true
        },
        {
          kind: "replaceAnchors",
          path: "src/{{entryName}}.ts",
          language: "typescript",
          replacements: {
            exports: "export const generated = true;"
          }
        }
      ]
    });

    await expect(
      readFile(path.join(targetRoot, ".project-kit/demo.json"), "utf8")
    ).resolves.toBe(
      [
        "{",
        '  "generated": true,',
        '  "preset": "ts-lib"',
        "}",
        ""
      ].join("\n")
    );
    await expect(readFile(path.join(targetRoot, "README.md"), "utf8")).resolves.toBe(
      "# Demo\n"
    );
    expect((await stat(path.join(targetRoot, ".npmrc"))).mode & 0o111).toBe(0o111);
    await expect(readFile(targetSourceFile, "utf8")).resolves.toBe(
      [
        "export const generated = true;",
        "export const existing = true;",
        ""
      ].join("\n")
    );
  });

  it("replaces checked transform anchors in TypeScript source", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "writeText",
          to: "README.md",
          text: "placeholder\n"
        }
      ]
    });

    const targetFile = path.join(targetRoot, "src/index.ts");
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(
      targetFile,
      [
        "export const before = true;",
        "/* @template-anchor exports */",
        "export const after = true;",
        ""
      ].join("\n"),
      "utf8"
    );

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "replaceAnchors",
          path: "src/index.ts",
          language: "typescript",
          replacements: {
            exports: "export const generated = 1;"
          }
        }
      ]
    });

    await expect(readFile(targetFile, "utf8")).resolves.toBe(
      [
        "export const before = true;",
        "export const generated = 1;",
        "export const after = true;",
        ""
      ].join("\n")
    );
  });

  it("preserves checked transform anchors that are not requested", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();
    const targetFile = path.join(targetRoot, "src/index.ts");
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(
      targetFile,
      [
        "/* @template-anchor imports */",
        'import type { Demo } from "./demo.js";',
        "/* @template-anchor exports */",
        "export const existing = true;",
        ""
      ].join("\n"),
      "utf8"
    );

    await renderProject({
      sourceRoot,
      targetRoot,
      operations: [
        {
          kind: "replaceAnchors",
          path: "src/index.ts",
          language: "typescript",
          replacements: {
            exports: "export const generated = true;"
          }
        }
      ]
    });

    await expect(readFile(targetFile, "utf8")).resolves.toBe(
      [
        "/* @template-anchor imports */",
        'import type { Demo } from "./demo.js";',
        "export const generated = true;",
        "export const existing = true;",
        ""
      ].join("\n")
    );
  });

  it("rejects checked transform anchors for non-TypeScript languages", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();
    const targetFile = path.join(targetRoot, "src/index.ts");
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, "/* @template-anchor exports */\n", "utf8");

    await expect(
      renderProject({
        sourceRoot,
        targetRoot,
        operations: [
          {
            kind: "replaceAnchors",
            path: "src/index.ts",
            language: "javascript",
            replacements: {
              exports: "export const generated = true;"
            }
          } as never
        ]
      })
    ).rejects.toThrow("Checked Transform Anchor only supports TypeScript");

    await expect(readFile(targetFile, "utf8")).resolves.toBe(
      "/* @template-anchor exports */\n"
    );
  });

  it("only replaces checked transform anchors attached to TypeScript syntax", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();
    const targetFile = path.join(targetRoot, "src/index.ts");
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(
      targetFile,
      [
        "export const before = true;",
        "/* @template-anchor exports */",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(
      renderProject({
        sourceRoot,
        targetRoot,
        operations: [
          {
            kind: "replaceAnchors",
            path: "src/index.ts",
            language: "typescript",
            replacements: {
              exports: "export const generated = true;"
            }
          }
        ]
      })
    ).rejects.toThrow("Missing Checked Transform Anchor: exports");
  });

  it("rejects unsupported rendering operations and arbitrary source text output", async () => {
    const { sourceRoot, targetRoot } = await tempWorkspace();

    for (const operation of [
      { kind: "patchString", path: "src/index.ts", find: "x", replace: "y" },
      { kind: "downloadRemoteTemplate", url: "https://example.com/template.tgz" },
      { kind: "postGenerationShellHook", command: "pnpm install" },
      { kind: "userJavaScriptTransform", code: "export default () => null" }
    ]) {
      await expect(
        renderProject({
          sourceRoot,
          targetRoot,
          operations: [operation as never]
        })
      ).rejects.toThrow(`Unsupported renderer operation: ${operation.kind}`);
    }

    await expect(
      renderProject({
        sourceRoot,
        targetRoot,
        operations: [
          {
            kind: "writeText",
            to: "src/index.ts",
            text: "export const arbitrary = true;\n"
          }
        ]
      })
    ).rejects.toThrow("Text output is limited to foundation files");

    await expect(
      renderProject({
        sourceRoot,
        targetRoot,
        operations: [
          {
            kind: "writeText",
            to: "src/README.md",
            text: "# Not foundation text\n"
          }
        ]
      })
    ).rejects.toThrow("Text output is limited to foundation files");
  });
});

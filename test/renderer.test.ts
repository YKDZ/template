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
        '  "scripts": {',
        '    "test": "vitest",',
        '    "build": "tsc -p tsconfig.json"',
        "  },",
        '  "name": "demo",',
        '  "private": true',
        "}",
        ""
      ].join("\n")
    );
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
  });
});

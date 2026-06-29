import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("template init", () => {
  it("generates a usable ts-lib project through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-init-"));
    const projectDir = path.join(workspace, "demo-lib");

    await execa(
      "pnpm",
      [
        "exec",
        "tsx",
        path.join(repoRoot, "src/cli.ts"),
        "init",
        projectDir,
        "--preset",
        "ts-lib",
        "--yes"
      ],
      { cwd: repoRoot }
    );

    const packageJson = await readJson<{
      name: string;
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(path.join(projectDir, "package.json"));
    const workspaceYaml = await readFile(
      path.join(projectDir, "pnpm-workspace.yaml"),
      "utf8"
    );
    const tsconfig = await readJson<{
      compilerOptions: Record<string, unknown>;
    }>(path.join(projectDir, "tsconfig.json"));
    const blueprint = await readJson<{ preset: string }>(
      path.join(projectDir, ".project-kit/blueprint.json")
    );
    const generatedBy = await readJson<{ packageName: string }>(
      path.join(projectDir, ".project-kit/generated-by.json")
    );

    expect(packageJson.name).toBe("demo-lib");
    expect(packageJson.scripts.check).toBe(
      "pnpm run typecheck && pnpm run lint && pnpm run format:check"
    );
    expect(packageJson.scripts.fix).toBe(
      "pnpm run format:write && pnpm run lint:fix"
    );
    expect(packageJson.devDependencies.typescript).toBe("catalog:");
    expect(packageJson.devDependencies.oxlint).toBe("catalog:");
    expect(packageJson.devDependencies.oxfmt).toBe("catalog:");

    expect(workspaceYaml).toContain("catalog:");
    expect(workspaceYaml).toContain("typescript:");
    expect(workspaceYaml).toContain("oxlint:");
    expect(workspaceYaml).toContain("oxfmt:");

    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });

    expect(blueprint.preset).toBe("ts-lib");
    expect(generatedBy.packageName).toBe("@ykdz/template");

    await stat(path.join(projectDir, ".devcontainer/devcontainer.json"));
    await stat(path.join(projectDir, ".github/workflows/check.yml"));
    await stat(path.join(projectDir, ".github/dependabot.yml"));
    await stat(path.join(projectDir, "src/index.ts"));

    await expect(
      stat(path.join(projectDir, "pnpm-lock.yaml"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
    const checkWorkflow = await readFile(
      path.join(projectDir, ".github/workflows/check.yml"),
      "utf8"
    );
    const installCommand = checkWorkflow.match(
      /^\s*-\s*run:\s*(pnpm install.*)$/m
    )?.[1];
    expect(installCommand).toBeDefined();

    await execa("pnpm", installCommand!.split(" ").slice(1), {
      cwd: projectDir
    });

    await writeFile(
      path.join(projectDir, "src/internal.ts"),
      [
        "export function greetingMessage(name: string): string {",
        "  return `Hello, ${name}`;",
        "}",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(projectDir, "src/index.ts"),
      [
        'import { greetingMessage } from "@/internal.js";',
        "",
        "export type Greeting = {",
        "  message: string;",
        "};",
        "",
        "export function greet(name: string): Greeting {",
        "  return { message: greetingMessage(name) };",
        "}",
        ""
      ].join("\n")
    );

    await execa("pnpm", ["run", "check"], { cwd: projectDir });
    await execa("pnpm", ["run", "build"], { cwd: projectDir });

    const emittedIndex = await readFile(
      path.join(projectDir, "dist/index.js"),
      "utf8"
    );
    expect(emittedIndex).not.toContain("@/");

    const importResult = await execa(
      "node",
      [
        "--input-type=module",
        "--eval",
        [
          `import { greet } from ${JSON.stringify(
            pathToFileURL(path.join(projectDir, "dist/index.js")).href
          )};`,
          'console.log(greet("Ada").message);'
        ].join("\n")
      ],
      { cwd: projectDir }
    );
    expect(importResult.stdout).toBe("Hello, Ada");
  });
});

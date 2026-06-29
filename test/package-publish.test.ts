import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "src/cli.ts",
  "src/declarations.ts",
  "src/hono-api.ts",
  "src/renderer.ts",
  "src/rust-bin.ts",
  "src/ts-lib.ts",
  "src/vue-app.ts",
  "templates/hono-api/src/app.ts",
  "templates/hono-api/src/server.ts",
  "templates/hono-api/test/app.test.ts",
  "templates/hono-api/vitest.config.ts",
  "templates/rust-bin/src/main.rs",
  "templates/ts-lib/src/index.ts",
  "templates/vue-app/env.d.ts",
  "templates/vue-app/index.html",
  "templates/vue-app/playwright.config.ts",
  "templates/vue-app/src/App.vue",
  "templates/vue-app/src/main.ts",
  "templates/vue-app/src/stores/counter.ts",
  "templates/vue-app/src/style.css",
  "templates/vue-app/test/app.test.ts",
  "templates/vue-app/test/e2e/app.spec.ts",
  "templates/vue-app/vite.config.ts",
  "templates/vue-app/vitest.config.ts",
  "tsconfig.build.json",
  "tsconfig.json"
];

async function copyCleanPackage(targetDir: string): Promise<void> {
  for (const file of packageFiles) {
    const from = path.join(repoRoot, file);
    const to = path.join(targetDir, file);

    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
}

describe("package publishing", () => {
  it("packs a tarball with the advertised CLI from a clean unbuilt checkout", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-pack-"));
    const packageDir = path.join(workspace, "package");
    const packDir = path.join(workspace, "pack");
    const consumerDir = path.join(workspace, "consumer");

    await copyCleanPackage(packageDir);
    await mkdir(packDir);
    await mkdir(consumerDir);

    await execa("pnpm", ["install", "--frozen-lockfile"], { cwd: packageDir });
    await execa("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: packageDir
    });

    const packedFiles = await readdir(packDir);
    const tarball = packedFiles.find((file) => file.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    const tarballPath = path.join(packDir, tarball!);
    const tarballContents = await execa("tar", ["-tf", tarballPath]);
    expect(tarballContents.stdout.split("\n")).toContain("package/dist/cli.js");

    await writeFile(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify({ type: "module" }, null, 2)}\n`
    );
    await execa("pnpm", ["add", tarballPath], { cwd: consumerDir });

    const result = await execa("pnpm", ["exec", "template", "--help"], {
      cwd: consumerDir
    });
    expect(result.stdout).toContain("Usage:");

    const generatedDir = path.join(consumerDir, "generated-lib");
    await execa(
      "pnpm",
      ["exec", "template", "init", generatedDir, "--preset", "ts-lib", "--yes"],
      { cwd: consumerDir }
    );
    await expect(
      readFile(path.join(generatedDir, "src/index.ts"), "utf8")
    ).resolves.toContain("export function greet");

    const packageJsonPath = path.join(
      consumerDir,
      "node_modules/@ykdz/template/package.json"
    );
    const packageJson = JSON.parse(
      await readFile(packageJsonPath, "utf8")
    ) as { bin: Record<string, string> };
    expect(packageJson.bin.template).toBe("./dist/cli.js");
  });
});

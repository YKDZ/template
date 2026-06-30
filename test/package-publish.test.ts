import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesRoot = path.join(repoRoot, "templates");

process.env.TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL ??= jsonDataUrl([
  { version: "v22.11.0", lts: "Jod" },
  { version: "v24.1.0", lts: false },
]);
process.env.TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL ??= jsonDataUrl({
  versions: {
    "10.0.0": { engines: { node: ">=18.12" } },
  },
});

function jsonDataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

const packageFiles = [
  ".npmignore",
  "LICENSE",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "src/cli.ts",
  "src/declarations.ts",
  "src/generation-context.ts",
  "src/hono-api.ts",
  "src/module-graph.ts",
  "src/next-step-instructions.ts",
  "src/package-addition.ts",
  "src/project-github.ts",
  "src/renderer.ts",
  "src/rust-bin.ts",
  "src/toolchain-resolution.ts",
  "src/ts-lib.ts",
  "src/vue-app.ts",
  "src/vue-hono-app.ts",
  "templates/hono-api/src/app.ts",
  "templates/hono-api/src/server.ts",
  "templates/hono-api/test/app.test.ts",
  "templates/hono-api/vitest.config.ts",
  "templates/hono-api/.github/dependabot.yml",
  "templates/hono-api/.github/workflows/check.yml",
  "templates/rust-bin/.github/dependabot.yml",
  "templates/rust-bin/.github/workflows/check.yml",
  "templates/rust-bin/src/main.rs",
  "templates/shared/oxc/node/oxlint.config.ts",
  "templates/shared/oxc/oxfmt.config.ts",
  "templates/shared/oxc/package.json",
  "templates/shared/oxc/tsconfig.json",
  "templates/shared/oxc/vue/oxlint.config.ts",
  "templates/ts-lib/.github/dependabot.yml",
  "templates/ts-lib/.github/workflows/check.yml",
  "templates/ts-lib/src/index.ts",
  "templates/vue-app/.github/dependabot.yml",
  "templates/vue-app/.github/workflows/check.yml",
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
  "templates/vue-hono-app/api/src/index.ts",
  "templates/vue-hono-app/api/src/runtime.ts",
  "templates/vue-hono-app/api/src/server.ts",
  "templates/vue-hono-app/api/test/app.test.ts",
  "templates/vue-hono-app/api/vitest.config.ts",
  "templates/vue-hono-app/.github/dependabot.yml",
  "templates/vue-hono-app/.github/workflows/check.yml",
  "templates/vue-hono-app/web/env.d.ts",
  "templates/vue-hono-app/web/index.html",
  "templates/vue-hono-app/web/playwright.config.ts",
  "templates/vue-hono-app/web/src/App.vue",
  "templates/vue-hono-app/web/src/api.ts",
  "templates/vue-hono-app/web/src/main.ts",
  "templates/vue-hono-app/web/src/stores/counter.ts",
  "templates/vue-hono-app/web/src/style.css",
  "templates/vue-hono-app/web/test/app.test.ts",
  "templates/vue-hono-app/web/test/e2e/app.spec.ts",
  "templates/vue-hono-app/web/vite.config.ts",
  "templates/vue-hono-app/web/vitest.config.ts",
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

function checkedTemplatePackagePaths(): string[] {
  return packageFiles
    .filter((file) => file.startsWith("templates/"))
    .map((file) => `package/${file}`)
    .sort();
}

describe("package publishing", () => {
  it("declares public npm metadata for the template CLI", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as {
      bin: Record<string, string>;
      dependencies?: Record<string, string>;
      license?: string;
      name: string;
      private: boolean;
      publishConfig?: { access?: string };
      repository?: { type?: string; url?: string };
    };

    expect(packageJson.name).toBe("@ykdz/template");
    expect(packageJson.private).toBe(false);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/YKDZ/template.git"
    });
    expect(packageJson.bin.template).toBe("dist/cli.js");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("execa");
    expect(packageJson.publishConfig?.access).toBe("public");
  });

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
    const packedPaths = tarballContents.stdout.split("\n");
    expect(packedPaths).toContain("package/dist/cli.js");
    expect(packedPaths).toContain("package/dist/generation-context.js");
    expect(packedPaths).toContain("package/dist/module-graph.js");
    expect(packedPaths).toContain("package/dist/next-step-instructions.js");
    expect(packedPaths).not.toContain("package/dist/post-commands.js");
    expect(packedPaths).toContain("package/dist/toolchain-resolution.js");
    expect(packedPaths).toContain("package/LICENSE");
    expect(packedPaths).toContain("package/README.md");
    const localTemplateArtifact = path.join(
      templatesRoot,
      `.package-publish-artifact-${process.pid}.tmp`
    );
    await writeFile(localTemplateArtifact, "not checked template source\n");
    try {
      expect(packedPaths).toEqual(
        expect.arrayContaining(checkedTemplatePackagePaths())
      );
      expect(packedPaths).not.toContain(
        `package/templates/${path.basename(localTemplateArtifact)}`
      );
      expect(packedPaths).not.toEqual(
        expect.arrayContaining([expect.stringContaining("/node_modules/")])
      );
    } finally {
      await rm(localTemplateArtifact, { force: true });
    }
    expect(packedPaths).not.toContain(
      "package/templates/shared/oxc/oxc-config-modules.d.ts"
    );

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
    await expect(
      readFile(path.join(generatedDir, "oxlint.config.ts"), "utf8")
    ).resolves.toContain("defineConfig");

    const generatedVueDir = path.join(consumerDir, "generated-vue");
    await execa(
      "pnpm",
      ["exec", "template", "init", generatedVueDir, "--preset", "vue-app", "--yes"],
      { cwd: consumerDir }
    );
    await expect(
      readFile(path.join(generatedVueDir, "src/App.vue"), "utf8")
    ).resolves.toContain("<script setup");
    await expect(
      readFile(path.join(generatedVueDir, "oxlint.config.ts"), "utf8")
    ).resolves.toContain("vue");

    const packageJsonPath = path.join(
      consumerDir,
      "node_modules/@ykdz/template/package.json"
    );
    const packageJson = JSON.parse(
      await readFile(packageJsonPath, "utf8")
    ) as { bin: Record<string, string> };
    expect(packageJson.bin.template).toBe("dist/cli.js");
  });
});

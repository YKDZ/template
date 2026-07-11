import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderGeneratedPnpmWorkspaceYaml } from "@ykdz/template-core/dependency-catalog";
import { execa } from "execa";

const packageManagerPin = "pnpm@11.11.0";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function generateTsLibProject(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(workspace, "demo-lib");
  const toolchainEnvironment = {
    ...process.env,
    TEMPLATE_TOOLCHAIN_NODE_RELEASE_INDEX_URL: `data:application/json,${encodeURIComponent(
      JSON.stringify([{ version: "v24.11.0", lts: "Krypton" }]),
    )}`,
    TEMPLATE_TOOLCHAIN_PNPM_REGISTRY_URL: `data:application/json,${encodeURIComponent(
      JSON.stringify({
        time: { "11.11.0": "2025-01-01T00:00:00.000Z" },
        versions: {
          "11.11.0": { engines: { node: ">=24.0.0" } },
        },
      }),
    )}`,
  };

  await execa(
    "node",
    [
      "--conditions=source",
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "init",
      projectDir,
      "--preset",
      "ts-lib",
      "--yes",
    ],
    { cwd: repoRoot, env: toolchainEnvironment },
  );
  return projectDir;
}

async function dockerIsAvailable(): Promise<boolean> {
  try {
    await execa("docker", ["version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerIsAvailable();

describe("pnpm Workspace Policy", () => {
  it("installs an injected workspace dependency from a frozen lockfile and synchronizes its build output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pnpm-workspace-policy-"));
    const provider = path.join(root, "packages/provider");
    const consumer = path.join(root, "packages/consumer");

    await Promise.all([
      mkdir(path.join(provider, "dist"), { recursive: true }),
      mkdir(consumer, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify({ private: true, packageManager: packageManagerPin })}\n`,
      ),
      writeFile(
        path.join(root, "pnpm-workspace.yaml"),
        renderGeneratedPnpmWorkspaceYaml({
          dependencies: [],
          packages: ["packages/*"],
        }),
      ),
      writeFile(
        path.join(provider, "package.json"),
        `${JSON.stringify({
          name: "@fixture/provider",
          version: "0.0.0",
          scripts: {
            "build:run":
              "node -e \"require('node:fs').copyFileSync('source.txt', 'dist/version.txt')\"",
          },
        })}\n`,
      ),
      writeFile(path.join(provider, "source.txt"), "before\n"),
      writeFile(path.join(provider, "dist/version.txt"), "before\n"),
      writeFile(
        path.join(consumer, "package.json"),
        `${JSON.stringify({
          name: "@fixture/consumer",
          version: "0.0.0",
          dependencies: { "@fixture/provider": "workspace:*" },
        })}\n`,
      ),
    ]);

    const environment = { ...process.env, CI: "1" };
    await execa("corepack", ["pnpm@11.11.0", "install", "--lockfile-only"], {
      cwd: root,
      env: environment,
    });
    await execa(
      "corepack",
      [
        "pnpm@11.11.0",
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      { cwd: root, env: environment },
    );

    const injectedProvider = path.join(
      consumer,
      "node_modules/@fixture/provider",
    );
    expect((await lstat(injectedProvider)).isSymbolicLink()).toBe(true);
    const injectedTarget = await readlink(injectedProvider);
    expect(injectedTarget).toContain("node_modules/.pnpm/");
    expect(injectedTarget).not.toContain("packages/provider");
    await writeFile(path.join(provider, "source.txt"), "after\n");
    await execa(
      "corepack",
      ["pnpm@11.11.0", "--filter", "@fixture/provider", "run", "build:run"],
      { cwd: root, env: environment },
    );

    await expect(
      readFile(path.join(injectedProvider, "dist/version.txt"), "utf8"),
    ).resolves.toBe("after\n");
  }, 30_000);

  it("installs a real rendered Preset from its frozen pnpm 11 lockfile", async () => {
    const projectDir = await generateTsLibProject("pnpm-rendered-preset-");
    const environment = { ...process.env, CI: "1" };

    await execa(
      "corepack",
      [packageManagerPin, "install", "--lockfile-only", "--prefer-offline"],
      { cwd: projectDir, env: environment },
    );
    await execa(
      "corepack",
      [packageManagerPin, "install", "--offline", "--frozen-lockfile"],
      { cwd: projectDir, env: environment },
    );
    await execa("corepack", [packageManagerPin, "run", "typecheck"], {
      cwd: projectDir,
      env: environment,
    });
  }, 120_000);

  it("exposes one generated devcontainer pnpm pin to root and non-root users", async (context) => {
    if (!hasDocker) {
      context.skip();
      return;
    }

    const projectDir = await generateTsLibProject("pnpm-corepack-users-");
    const imageIdFile = path.join(projectDir, ".devcontainer-image-id");
    let imageId: string | undefined;

    try {
      await execa(
        "docker",
        [
          "build",
          "--iidfile",
          imageIdFile,
          "--build-arg",
          "NODE_VERSION=24",
          "--build-arg",
          `PACKAGE_MANAGER_PIN=${packageManagerPin}`,
          "--file",
          ".devcontainer/Dockerfile",
          ".",
        ],
        { cwd: projectDir },
      );
      imageId = (await readFile(imageIdFile, "utf8")).trim();

      for (const user of ["0", "node"]) {
        const result = await execa(
          "docker",
          ["run", "--rm", "--user", user, imageId, "pnpm", "--version"],
          { cwd: projectDir },
        );
        expect(result.stdout.trim()).toBe("11.11.0");
      }
    } finally {
      if (imageId !== undefined) {
        await execa("docker", ["image", "rm", "--force", imageId], {
          reject: false,
        });
      }
    }
  }, 180_000);
});

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const livePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const liveRepositoryRoot = path.resolve(livePackageRoot, "..", "..");
const workspace = await mkdtemp(
  path.join(tmpdir(), "template-source-condition-"),
);
const repositoryRoot = path.join(workspace, "repository");
const ignoredTopLevelPaths = new Set([
  ".git",
  ".scratch",
  ".turbo",
  "node_modules",
]);

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

try {
  await cp(liveRepositoryRoot, repositoryRoot, {
    recursive: true,
    filter(source) {
      const relativePath = portablePath(
        path.relative(liveRepositoryRoot, source),
      );
      const firstSegment = relativePath.split("/")[0];
      if (
        firstSegment !== undefined &&
        ignoredTopLevelPaths.has(firstSegment)
      ) {
        return false;
      }
      return !/^packages\/[^/]+\/dist(?:\/|$)/u.test(relativePath);
    },
  });
  const packageRoot = path.join(repositoryRoot, "packages", "cli");
  for (const packageName of [
    "builtin-presets",
    "checks",
    "cli",
    "core",
    "shared",
  ]) {
    await rm(path.join(repositoryRoot, "packages", packageName, "dist"), {
      recursive: true,
      force: true,
    });
  }

  await execa("pnpm", ["install", "--frozen-lockfile"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });

  await execa(
    "node",
    ["--conditions=source", "test/e2e/assert-source-resolutions.ts"],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );

  await execa(
    "node",
    ["--conditions=source", "test/e2e/run-journeys.ts", "source"],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );

  await execa(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=!//",
      "--force",
      "--output-logs=errors-only",
    ],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );

  await execa("node", ["test/e2e/run-journeys.ts", "distribution"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
} finally {
  await rm(workspace, { recursive: true, force: true });
}

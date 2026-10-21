import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type PackageManifest = {
  readonly name?: unknown;
};

function selectedForBuild(): boolean {
  const buildTask = process.argv[1];
  if (
    buildTask === undefined ||
    buildTask.length === 0 ||
    process.argv.length !== 2
  ) {
    throw new Error("prepack-build 需要且只接受一个 Turbo build 任务名。");
  }

  const manifest = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as PackageManifest;
  const selectedTargets = JSON.parse(
    process.env.NPM_PUBLICATION_PREBUILT_TARGETS ?? "[]",
  ) as unknown;
  if (
    !Array.isArray(selectedTargets) ||
    selectedTargets.some((target) => typeof target !== "string")
  ) {
    throw new Error("NPM_PUBLICATION_PREBUILT_TARGETS 必须是包名数组。");
  }
  return (
    typeof manifest.name === "string" && selectedTargets.includes(manifest.name)
  );
}

if (!selectedForBuild()) {
  const buildTask = process.argv[1]!;
  const result = spawnSync(
    "pnpm",
    ["exec", "turbo", "run", buildTask, "--filter=.", "--force"],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}

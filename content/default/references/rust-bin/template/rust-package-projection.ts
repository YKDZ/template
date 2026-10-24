import { projectTomlStringValues } from "@ykdz/template-core/toml";
import type { TomlTable } from "smol-toml";

export type CargoFileSnapshot = {
  readonly source: string;
  readonly data: TomlTable;
};

function cargoManifestName(manifest: CargoFileSnapshot): string {
  const packageMetadata = manifest.data.package;
  const name =
    typeof packageMetadata === "object" &&
    packageMetadata !== null &&
    !Array.isArray(packageMetadata)
      ? (packageMetadata as Record<string, unknown>).name
      : undefined;
  if (typeof name !== "string") {
    throw new Error("Rust Cargo 清单缺少 [package].name 字符串字段");
  }
  return name;
}

function cargoLockPackages(lock: CargoFileSnapshot): readonly unknown[] {
  const packages = lock.data.package;
  if (!Array.isArray(packages)) {
    throw new Error("Rust Cargo 锁文件缺少 [[package]] 条目");
  }
  return packages;
}

/** 按包叶名纯投影 Cargo 内容，并保留无关 TOML 字节。 */
export function projectRustCargoFiles(options: {
  readonly cargoManifest: CargoFileSnapshot;
  readonly cargoLock: CargoFileSnapshot;
  readonly targetName: string;
}): { readonly manifestText: string; readonly lockText: string } {
  const nativeName = cargoManifestName(options.cargoManifest);
  const lockPackages = cargoLockPackages(options.cargoLock);
  return {
    manifestText: projectTomlStringValues(options.cargoManifest.source, [
      { path: ["package", "name"], value: options.targetName },
    ]),
    lockText: projectTomlStringValues(
      options.cargoLock.source,
      lockPackages.flatMap((packageValue, index) => {
        if (
          typeof packageValue !== "object" ||
          packageValue === null ||
          Array.isArray(packageValue)
        ) {
          return [];
        }
        const packageRecord = packageValue as Record<string, unknown>;
        return packageRecord.name === nativeName &&
          packageRecord.source === undefined
          ? [{ path: ["package", index, "name"], value: options.targetName }]
          : [];
      }),
    ),
  };
}

/** Cargo 维护 lint；Rust 包不运行生成器的 TypeScript 检查任务。 */
export function projectRustPackageScripts(
  scripts: Readonly<Record<string, string>>,
): Record<string, string> {
  const projected: Record<string, string> = {
    ...scripts,
    lint: "cargo clippy --workspace --all-targets -- -D warnings",
    test: "cargo test --workspace",
  };
  delete projected["lint:fix"];
  delete projected["typecheck"];
  return projected;
}

/** 同步移除已退出的 TypeScript 任务及其 format:write 前置依赖。 */
export function projectRustTurboTasks(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const tasks = { ...source };
  delete tasks["lint:fix"];
  delete tasks.typecheck;
  const formatWrite = tasks["format:write"] as {
    readonly dependsOn: readonly string[];
  };
  tasks["format:write"] = {
    ...formatWrite,
    dependsOn: formatWrite.dependsOn.filter((task) => task !== "lint:fix"),
  };
  return tasks;
}

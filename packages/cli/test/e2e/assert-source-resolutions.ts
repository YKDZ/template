import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicSourceResolutions = [
  ["@ykdz/template", "/packages/cli/src/main.ts"],
  ["@ykdz/template-builtin-presets", "/src/index.ts"],
  ["@ykdz/template-core/renderer", "/src/renderer.ts"],
  ["@ykdz/template-shared", "/src/index.ts"],
  [
    "@ykdz/template-checks/check-online-toolchain-resolution-contract",
    "/src/check-online-toolchain-resolution-contract.ts",
  ],
] as const;
const localSourceResolutions = [
  ["#template-builtin-presets", "/packages/builtin-presets/src/index.ts"],
  ["#template-core/renderer", "/packages/core/src/renderer.ts"],
] as const;

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

for (const [specifier, expectedSuffix] of publicSourceResolutions) {
  const resolved = portablePath(fileURLToPath(import.meta.resolve(specifier)));
  if (resolved.includes("/dist/") || !resolved.endsWith(expectedSuffix)) {
    throw new Error(
      `${specifier} resolved to ${resolved}; expected ${expectedSuffix}`,
    );
  }
}

for (const [specifier, expectedSuffix] of localSourceResolutions) {
  const resolved = portablePath(
    await realpath(fileURLToPath(import.meta.resolve(specifier))),
  );
  if (resolved.includes("/dist/") || !resolved.endsWith(expectedSuffix)) {
    throw new Error(
      `${specifier} resolved to ${resolved}; expected ${expectedSuffix}`,
    );
  }
}

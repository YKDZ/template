import path from "node:path";
import { fileURLToPath } from "node:url";

const publicSourceResolutions = [
  ["@ykdz/template", "/packages/cli/src/main.ts"],
  ["@ykdz/template-content", "/packages/content/src/index.ts"],
  ["@ykdz/template-generator", "/packages/generator/src/index.ts"],
  ["@ykdz/template-core/project-blueprint", "/src/project-blueprint.ts"],
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

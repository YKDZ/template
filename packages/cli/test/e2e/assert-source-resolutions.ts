import path from "node:path";
import { fileURLToPath } from "node:url";

const publicSourceResolutions = [
  ["@ykdz/template", "/packages/cli/src/main.ts"],
  ["@ykdz/template-content", "/content/default/collection/src/index.ts"],
  ["@ykdz/template-core/project-blueprint", "/src/project-blueprint.ts"],
  ["@ykdz/template-core/generation-record", "/src/generation-record.ts"],
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

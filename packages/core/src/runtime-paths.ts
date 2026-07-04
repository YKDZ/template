import { existsSync } from "node:fs";
import path from "node:path";

export function packageTemplateRoot(
  moduleDir: string,
  ...segments: string[]
): string {
  const candidates = [
    path.join(
      moduleDir,
      "..",
      "..",
      "builtin-source",
      "templates",
      ...segments,
    ),
    path.join(
      moduleDir,
      "..",
      "..",
      "template-builtin-source",
      "templates",
      ...segments,
    ),
    path.join(moduleDir, "..", "..", "templates", ...segments),
    path.join(moduleDir, "..", "templates", ...segments),
    path.join(moduleDir, "..", "..", "..", "templates", ...segments),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? candidates[0];
}

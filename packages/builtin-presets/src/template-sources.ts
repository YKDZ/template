import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTemplateSourceHandle,
  type TemplateSourceHandle,
} from "@ykdz/template-core/renderer";

function templateRoot(...segments: string[]): string {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRootSegments =
    path.basename(path.dirname(sourceDirectory)) === "dist"
      ? ["..", ".."]
      : [".."];
  return path.join(
    sourceDirectory,
    ...packageRootSegments,
    "templates",
    ...segments,
  );
}

function source(...segments: string[]): TemplateSourceHandle {
  return createTemplateSourceHandle(templateRoot(...segments));
}

/** The sole owner of Built-in Presets Template Source references. */
export const templateSources = {
  foundation: source("foundation"),
  sharedDevcontainer: source("shared", "devcontainer"),
  sharedOxc: source("shared", "oxc"),
  editorCustomization: source("shared", "editor-customization"),
  vue: source("shared", "vue"),
  tsLib: source("ts-lib"),
  rustBin: source("rust-bin"),
  vueApp: source("vue-app"),
  vueHonoApp: source("vue-hono-app"),
  vikeApp: source("vike-app"),
} as const;

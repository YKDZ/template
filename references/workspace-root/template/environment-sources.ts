import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";

function source(path: string) {
  return createTemplateSourceHandle(
    fileURLToPath(new URL(`../resources/environment/${path}`, import.meta.url)),
  );
}

export const workspaceEnvironmentSources = {
  base: source(""),
  devcontainer: source("devcontainer/"),
  editorCustomization: source("editor-customization/"),
};

import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";

const source = (name: string) =>
  createTemplateSourceHandle(
    fileURLToPath(
      new URL(
        name === "." ? "../assets/" : `../assets/${name}`,
        import.meta.url,
      ),
    ),
  );
export const environmentSources = {
  base: source("environment"),
  devcontainer: source("environment/devcontainer"),
  editorCustomization: source("environment/editor-customization"),
};

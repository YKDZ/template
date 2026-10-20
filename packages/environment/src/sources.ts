import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";

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
  base: source("."),
  devcontainer: source("devcontainer"),
  editorCustomization: source("editor-customization"),
};

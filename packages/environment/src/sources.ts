import { fileURLToPath } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/renderer";

const source = (name: string) =>
  createTemplateSourceHandle(
    fileURLToPath(
      import.meta.resolve(
        name === "."
          ? "@ykdz/template-environment/assets"
          : "@ykdz/template-environment/assets/" + name,
      ),
    ),
  );
export const environmentSources = {
  base: source("."),
  devcontainer: source("devcontainer"),
  editorCustomization: source("editor-customization"),
};

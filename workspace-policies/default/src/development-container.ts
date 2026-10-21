import { browserTestDevelopmentContainerToolLayer as createBrowserTestLayer } from "@ykdz/template-environment/development-environment";

import { loadTemplateDependencyCatalog } from "./dependency-catalog.ts";

/** 工作区当前 Playwright 事实由工作区持有，再交给环境层构造资源。 */
export function browserTestDevelopmentContainerToolLayer() {
  const playwrightTestVersion =
    loadTemplateDependencyCatalog()["@playwright/test"];
  if (playwrightTestVersion === undefined) {
    throw new Error(
      "Template Dependency Catalog is missing dependency: @playwright/test",
    );
  }
  return createBrowserTestLayer(playwrightTestVersion);
}

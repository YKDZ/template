/** 工作区 Vue-Hono 联合浏览器验收资源的所属 URL。 */
export const jointE2eWorkspaceResources = Object.freeze({
  configuration: new URL(
    "../resources/joint-e2e/playwright.config.ts",
    import.meta.url,
  ),
  testDirectory: new URL("../resources/joint-e2e/test/e2e/", import.meta.url),
});

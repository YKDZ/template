import { test as base } from "@playwright/test";

export const test = base.extend<{ readonly webUrl: string }>({
  webUrl: async ({ browserName: _browserName }, use) => {
    const webUrl = process.env.PLAYWRIGHT_WEB_URL;
    if (webUrl === undefined) {
      throw new Error(
        "PLAYWRIGHT_WEB_URL was not captured from the web server",
      );
    }
    await use(webUrl);
  },
});

export { expect } from "@playwright/test";

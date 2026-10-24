import { expect, test } from "./fixtures.ts";

test("renders the web app and calls the API", async ({ page, webUrl }) => {
  await page.goto(webUrl);

  await expect(
    page.getByRole("heading", { name: "Vue 和 Hono 工作区" }),
  ).toBeVisible();
  await expect(page.getByText("API 状态：正常")).toBeVisible();
});

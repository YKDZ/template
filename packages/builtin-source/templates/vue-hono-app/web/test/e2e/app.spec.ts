import { expect, test } from "@playwright/test";

test("renders the web app and calls the API", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Vue、Hono 和类型化 RPC" }),
  ).toBeVisible();
  await expect(page.getByText("API 状态：正常")).toBeVisible();
  const counterButton = page.getByRole("button", { name: "计数：0" });

  await expect(counterButton).toBeVisible();
  await counterButton.click({ force: true });
  await expect(page.getByRole("button", { name: "计数：1" })).toBeVisible();
});

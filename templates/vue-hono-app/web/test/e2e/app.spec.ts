import { expect, test } from "@playwright/test";

test("renders the web app and calls the API", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Vue, Hono, and typed RPC" })).toBeVisible();
  await expect(page.getByText("API status: ok")).toBeVisible();
  await page.getByRole("button", { name: "Count is 0" }).click();
  await expect(page.getByRole("button", { name: "Count is 1" })).toBeVisible();
});

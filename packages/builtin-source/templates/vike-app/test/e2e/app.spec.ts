import { expect, test } from "@playwright/test";

test("renders the Vike home page", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Full-stack Vike app" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Count 0" }).click();
  await expect(page.getByRole("button", { name: "Count 1" })).toBeVisible();
});

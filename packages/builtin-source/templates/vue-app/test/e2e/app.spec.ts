import { expect, test } from "@playwright/test";

test("renders and updates the counter", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Vue, Vite, Tailwind, and Pinia" }),
  ).toBeVisible();
  const counterButton = page.getByRole("button", { name: "Count is 0" });

  await expect(counterButton).toBeVisible();
  await counterButton.click({ force: true });
  await expect(page.getByRole("button", { name: "Count is 1" })).toBeVisible();
});

import { expect, test } from "@playwright/test";

test("renders the Vike home page", async ({ page }) => {
  const todoTitle = `编写生成项目端到端测试 ${Date.now()}`;

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "全栈 Vike 应用" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "计数：0" }).click();
  await expect(page.getByRole("button", { name: "计数：1" })).toBeVisible();

  await page.getByPlaceholder("添加一条数据库待办").fill(todoTitle);
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.getByText(todoTitle)).toBeVisible();
});

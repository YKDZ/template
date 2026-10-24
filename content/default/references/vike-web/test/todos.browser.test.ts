import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";

import { onAddTodo, onLoadTodos } from "../pages/index/+Page.telefunc.ts";
import Page from "../pages/index/+Page.vue";

vi.mock("../pages/index/+Page.telefunc.ts", () => ({
  onLoadTodos: vi.fn(),
  onAddTodo: vi.fn(),
}));

it("加载待办并在新增后刷新列表", async () => {
  vi.mocked(onLoadTodos)
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      { id: 1, title: "完成待办", completed: false, createdAt: "2026-10-22" },
    ]);
  const screen = await render(Page);
  await screen.getByPlaceholder("添加一条数据库待办").fill("完成待办");
  await screen.getByRole("button", { name: "添加", exact: true }).click();
  await expect.element(screen.getByText("完成待办")).toBeVisible();
  expect(onAddTodo).toHaveBeenCalledWith("完成待办");
});

it("加载失败后允许重试", async () => {
  vi.mocked(onLoadTodos)
    .mockRejectedValueOnce(new Error("数据库暂不可用"))
    .mockResolvedValue([]);
  const screen = await render(Page);
  await expect
    .element(screen.getByText("待办加载失败：数据库暂不可用"))
    .toBeVisible();
  await screen.getByRole("button", { name: "刷新待办事项" }).click();
  await expect
    .element(screen.getByText("待办加载失败：数据库暂不可用"))
    .not.toBeInTheDocument();
});

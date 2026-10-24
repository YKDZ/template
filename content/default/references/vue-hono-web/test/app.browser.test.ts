import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";

import App from "../src/App.vue";

it("显示 API 健康状态", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ status: "ok" }),
  );
  const screen = await render(App);
  await expect.element(screen.getByText("API 状态：正常")).toBeVisible();
  vi.restoreAllMocks();
});

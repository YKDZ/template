import { createPinia } from "pinia";
import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import App from "../src/App.vue";

it("显示应用并使用公共计数组件", async () => {
  const screen = await render(App, { global: { plugins: [createPinia()] } });
  const button = screen.getByRole("button", { name: /计数/ });
  await expect.element(button).toHaveTextContent("计数：0");
  await button.click();
  await expect.element(button).toHaveTextContent("计数：1");
});

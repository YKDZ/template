import { createPinia } from "pinia";
import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import CounterButton from "../src/components/CounterButton.vue";

it("increments the Pinia counter when clicked", async () => {
  const screen = await render(CounterButton, {
    global: { plugins: [createPinia()] },
  });
  const button = screen.getByRole("button", { name: /计数/ });

  await expect.element(button).toHaveTextContent("计数：0");
  await button.click();
  await expect.element(button).toHaveTextContent("计数：1");
});

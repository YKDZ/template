import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import CounterButton from "../components/CounterButton.vue";

it("enables the counter after mounting and increments it", async () => {
  const screen = await render(CounterButton);
  const button = screen.getByRole("button", { name: /计数/ });

  await expect.element(button).toBeEnabled();
  await expect.element(button).toHaveTextContent("计数：0");
  await button.click();
  await expect.element(button).toHaveTextContent("计数：1");
});

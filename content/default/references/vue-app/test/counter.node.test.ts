import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useCounterStore } from "../src/stores/counter.ts";

describe("计数状态", () => {
  it("增加计数", () => {
    setActivePinia(createPinia());
    const counter = useCounterStore();

    counter.increment();

    expect(counter.count).toBe(1);
  });
});

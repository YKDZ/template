import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useCounterStore } from "#/stores/counter";

describe("counter store", () => {
  it("increments the count", () => {
    setActivePinia(createPinia());
    const counter = useCounterStore();

    counter.increment();

    expect(counter.count).toBe(1);
  });
});

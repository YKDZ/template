import { describe, expect, it } from "vitest";

import { renderRootCheckCommand } from "#template-core/module-graph";

describe("Root Check command rendering", () => {
  it("appends caller-declared tasks without leaking orchestration policy", () => {
    expect(renderRootCheckCommand(["publication:readiness"])).toBe(
      "turbo run boundaries format:check lint typecheck build test test:e2e publication:readiness --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
    );
  });
});

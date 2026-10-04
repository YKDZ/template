import { renderRootCheckCommand } from "@ykdz/template-core/module-graph";
import { describe, expect, it } from "vitest";

describe("Root Check command rendering", () => {
  it("appends caller-declared tasks without leaking orchestration policy", () => {
    expect(renderRootCheckCommand(["publication:readiness"])).toBe(
      "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e publication:readiness --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
    );
  });
});

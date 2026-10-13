import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderRootCheckCommand } from "@ykdz/template-core/module-graph";

void describe("Root Check command rendering", () => {
  void it("appends caller-declared tasks without leaking orchestration policy", () => {
    assert.strictEqual(
      renderRootCheckCommand(["publication:readiness"]),
      "pnpm run boundaries && turbo run format:check lint typecheck build test test:e2e publication:readiness --concurrency=2 --continue=dependencies-successful --output-logs=errors-only --log-order=grouped --log-prefix=task",
    );
  });
});

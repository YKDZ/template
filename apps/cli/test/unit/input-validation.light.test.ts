import assert from "node:assert/strict";
import test from "node:test";

import { validateInitializationInput } from "../../src/input-validation.ts";

void test("initialization retains valid package-name spelling", () => {
  assert.deepEqual(
    validateInitializationInput({
      preset: "ts-lib",
      targetDir: "demo",
      overrides: { name: "library" },
    }).status,
    "valid",
  );
});

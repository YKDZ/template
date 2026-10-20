import assert from "node:assert/strict";
import test from "node:test";

import { validateInitializationInput } from "../../src/input-validation.ts";

void test("initialization rejects package identities owned by selected configuration", () => {
  const name = validateInitializationInput({
    preset: "ts-lib",
    targetDir: "demo",
    overrides: { name: "typescript-config" },
  });
  const path = validateInitializationInput({
    preset: "ts-lib",
    targetDir: "demo",
    overrides: { path: "packages/typescript-config" },
  });

  assert.deepEqual(name, {
    status: "input-invalid",
    issues: [{ code: "CONFLICTING_PACKAGE_IDENTITY" }],
  });
  assert.deepEqual(path, {
    status: "input-invalid",
    issues: [{ code: "CONFLICTING_PACKAGE_IDENTITY" }],
  });
});

void test("initialization accepts identities outside the selected configuration", () => {
  assert.deepEqual(
    validateInitializationInput({
      preset: "ts-lib",
      targetDir: "demo",
      overrides: { name: "library" },
    }).status,
    "valid",
  );
});

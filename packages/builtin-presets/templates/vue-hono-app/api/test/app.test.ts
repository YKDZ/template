import assert from "node:assert/strict";
import { it } from "node:test";

import { app } from "#/runtime";

void it("responds to the health route", async () => {
  const response = await app.request("/api/health");

  assert.equal(response.status, 200);
  assert.deepStrictEqual(await response.json(), { status: "ok" });
});

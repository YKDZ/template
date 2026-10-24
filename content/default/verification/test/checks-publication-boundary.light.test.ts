import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { execa } from "execa";

void describe("@ykdz/default-content-verification publication boundary", () => {
  void it("keeps the generated registry Task Entrypoint private under source resolution", async () => {
    const privateImport = await execa(
      "node",
      [
        "--conditions=source",
        "--input-type=module",
        "-e",
        'await import("@ykdz/default-content-verification/check-generated-registry")',
      ],
      {
        cwd: process.cwd(),
        reject: false,
        all: true,
      },
    );

    assert.notStrictEqual(privateImport.exitCode, 0);
    assert.ok(privateImport.all.includes("ERR_PACKAGE_PATH_NOT_EXPORTED"));
  });
});

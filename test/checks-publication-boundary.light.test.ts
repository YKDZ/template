import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { execa } from "execa";

void describe("@ykdz/template-checks publication boundary", () => {
  void it("keeps the generated registry Task Entrypoint private under source resolution", async () => {
    const privateImport = await execa(
      "node",
      [
        "--conditions=source",
        "--input-type=module",
        "-e",
        'await import("@ykdz/template-checks/check-generated-registry")',
      ],
      {
        cwd: path.join(process.cwd(), "packages/checks"),
        reject: false,
        all: true,
      },
    );

    assert.notStrictEqual(privateImport.exitCode, 0);
    assert.ok(privateImport.all.includes("ERR_PACKAGE_PATH_NOT_EXPORTED"));
  });
});

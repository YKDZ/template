import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

describe("@ykdz/template-checks publication boundary", () => {
  it("keeps the generated registry Task Entrypoint private under source resolution", async () => {
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

    expect(privateImport.exitCode).not.toBe(0);
    expect(privateImport.all).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});

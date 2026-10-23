import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { printCanonicalJson } from "../src/json.ts";

void describe("规范 JSON 输出", () => {
  void it("在行宽内内联标量数组并保留长数组换行", () => {
    assert.equal(
      new TextDecoder().decode(
        printCanonicalJson({ linkFrom: ["packages/lib"] }),
      ),
      '{\n  "linkFrom": ["packages/lib"]\n}\n',
    );
    assert.equal(
      new TextDecoder().decode(
        printCanonicalJson({ values: ["x".repeat(60), "y".repeat(60)] }),
      ),
      `{\n  "values": [\n    "${"x".repeat(60)}",\n    "${"y".repeat(60)}"\n  ]\n}\n`,
    );
  });
});

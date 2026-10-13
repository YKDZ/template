import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertThrows, testEach } from "../../test-support/assertions.ts";
import {
  isValidDefaultPackageScope,
  parseGenerationRecord,
} from "../generation-record.ts";

const validRecord = {
  schemaVersion: 2,
  repositoryName: "demo",
  defaultPackageScope: "demo",
  preset: "ts-lib",
  templateVersion: "0.0.0",
  toolchain: {
    nodeLtsMajor: "24",
    packageManagerPin: "pnpm@11.21.0",
  },
  packages: [],
} as const;

void describe("Generation Record default package scope", () => {
  void it("exposes the durable scope boundary", () => {
    for (const valid of ["a", "a.b", "a-b", "a_b", "a0"]) {
      assert.strictEqual(isValidDefaultPackageScope(valid), true);
    }
    for (const invalid of [".bad", "-bad", "_bad", "Bad", "bad scope"]) {
      assert.strictEqual(isValidDefaultPackageScope(invalid), false);
    }
  });

  testEach(
    [".bad", "-bad", "_bad"],
    "rejects persisted default package scope %s",
    (defaultPackageScope) => {
      assertThrows(
        () => parseGenerationRecord({ ...validRecord, defaultPackageScope }),
        /^Generation Record defaultPackageScope must be a valid npm scope$/u,
      );
    },
  );
});

void describe("Generation Record v2 toolchain shape", () => {
  void it("keeps the two historical fields as the whole toolchain fact", () => {
    assert.deepStrictEqual(parseGenerationRecord(validRecord).toolchain, {
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.21.0",
    });
  });

  void it("rejects a record that leaks the exact Node version into the toolchain", () => {
    assertThrows(
      () =>
        parseGenerationRecord({
          ...validRecord,
          toolchain: { ...validRecord.toolchain, nodeVersion: "24.16.0" },
        }),
      /contains unknown field: nodeVersion/u,
    );
  });

  testEach(
    [
      ["24", "pnpm@11.21.0"],
      ["22", "pnpm@11.21.0-beta.5"],
      ["20", "pnpm@11.21.0+sha.4c2f1"],
    ],
    "accepts the persisted Node major %s and pnpm pin %s",
    (nodeLtsMajor: string, packageManagerPin: string) => {
      assert.deepStrictEqual(
        parseGenerationRecord({
          ...validRecord,
          toolchain: { nodeLtsMajor, packageManagerPin },
        }).toolchain,
        { nodeLtsMajor, packageManagerPin },
      );
    },
  );

  testEach(
    ["latest", "24.x", "v24"],
    "rejects a persisted Node LTS major %s",
    (nodeLtsMajor) => {
      assertThrows(
        () =>
          parseGenerationRecord({
            ...validRecord,
            toolchain: { ...validRecord.toolchain, nodeLtsMajor },
          }),
        /^Generation Record toolchain\.nodeLtsMajor must be a numeric Node major$/u,
      );
    },
  );

  testEach(
    [
      "pnpm@11",
      "pnpm@11.21",
      "pnpm@11.21.0.",
      "pnpm@11.21.0-",
      "pnpm 11.21.0",
      "11.21.0",
    ],
    "rejects a persisted pnpm pin %s that is not an exact version",
    (packageManagerPin) => {
      assertThrows(
        () =>
          parseGenerationRecord({
            ...validRecord,
            toolchain: { ...validRecord.toolchain, packageManagerPin },
          }),
        /^Generation Record toolchain\.packageManagerPin must be an exact pnpm version pin$/u,
      );
    },
  );
});

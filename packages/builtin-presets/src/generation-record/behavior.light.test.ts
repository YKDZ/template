import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

  for (const defaultPackageScope of [".bad", "-bad", "_bad"]) {
    void it(`rejects persisted default package scope ${defaultPackageScope}`, () => {
      assert.throws(
        () => parseGenerationRecord({ ...validRecord, defaultPackageScope }),
        (error: unknown) =>
          error instanceof Error &&
          /^Generation Record defaultPackageScope must be a valid npm scope$/u.test(
            error.message,
          ),
      );
    });
  }
});

void describe("Generation Record v2 toolchain shape", () => {
  void it("keeps the two historical fields as the whole toolchain fact", () => {
    assert.deepStrictEqual(parseGenerationRecord(validRecord).toolchain, {
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.21.0",
    });
  });

  void it("rejects a record that leaks the exact Node version into the toolchain", () => {
    assert.throws(
      () =>
        parseGenerationRecord({
          ...validRecord,
          toolchain: { ...validRecord.toolchain, nodeVersion: "24.16.0" },
        }),
      (error: unknown) =>
        error instanceof Error &&
        /contains unknown field: nodeVersion/u.test(error.message),
    );
  });

  for (const [nodeLtsMajor, packageManagerPin] of [
    ["24", "pnpm@11.21.0"],
    ["22", "pnpm@11.21.0-beta.5"],
    ["20", "pnpm@11.21.0+sha.4c2f1"],
  ]) {
    void it(`accepts the persisted Node major ${nodeLtsMajor} and pnpm pin ${packageManagerPin}`, () => {
      assert.deepStrictEqual(
        parseGenerationRecord({
          ...validRecord,
          toolchain: { nodeLtsMajor, packageManagerPin },
        }).toolchain,
        { nodeLtsMajor, packageManagerPin },
      );
    });
  }

  for (const nodeLtsMajor of ["latest", "24.x", "v24"]) {
    void it(`rejects a persisted Node LTS major ${nodeLtsMajor}`, () => {
      assert.throws(
        () =>
          parseGenerationRecord({
            ...validRecord,
            toolchain: { ...validRecord.toolchain, nodeLtsMajor },
          }),
        (error: unknown) =>
          error instanceof Error &&
          /^Generation Record toolchain\.nodeLtsMajor must be a numeric Node major$/u.test(
            error.message,
          ),
      );
    });
  }

  for (const packageManagerPin of [
    "pnpm@11",
    "pnpm@11.21",
    "pnpm@11.21.0.",
    "pnpm@11.21.0-",
    "pnpm 11.21.0",
    "11.21.0",
  ]) {
    void it(`rejects a persisted pnpm pin ${packageManagerPin} that is not an exact version`, () => {
      assert.throws(
        () =>
          parseGenerationRecord({
            ...validRecord,
            toolchain: { ...validRecord.toolchain, packageManagerPin },
          }),
        (error: unknown) =>
          error instanceof Error &&
          /^Generation Record toolchain\.packageManagerPin must be an exact pnpm version pin$/u.test(
            error.message,
          ),
      );
    });
  }
});

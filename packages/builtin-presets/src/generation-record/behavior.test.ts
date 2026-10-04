import { describe, expect, it } from "vitest";

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

describe("Generation Record default package scope", () => {
  it("exposes the durable scope boundary", () => {
    for (const valid of ["a", "a.b", "a-b", "a_b", "a0"]) {
      expect(isValidDefaultPackageScope(valid)).toBe(true);
    }
    for (const invalid of [".bad", "-bad", "_bad", "Bad", "bad scope"]) {
      expect(isValidDefaultPackageScope(invalid)).toBe(false);
    }
  });

  it.each([".bad", "-bad", "_bad"])(
    "rejects persisted default package scope %s",
    (defaultPackageScope) => {
      expect(() =>
        parseGenerationRecord({ ...validRecord, defaultPackageScope }),
      ).toThrow(
        /^Generation Record defaultPackageScope must be a valid npm scope$/u,
      );
    },
  );
});

describe("Generation Record v2 toolchain shape", () => {
  it("keeps the two historical fields as the whole toolchain fact", () => {
    expect(parseGenerationRecord(validRecord).toolchain).toEqual({
      nodeLtsMajor: "24",
      packageManagerPin: "pnpm@11.21.0",
    });
  });

  it("rejects a record that leaks the exact Node version into the toolchain", () => {
    expect(() =>
      parseGenerationRecord({
        ...validRecord,
        toolchain: { ...validRecord.toolchain, nodeVersion: "24.16.0" },
      }),
    ).toThrow(/contains unknown field: nodeVersion/u);
  });

  it.each([
    ["24", "pnpm@11.21.0"],
    ["22", "pnpm@11.21.0-beta.5"],
    ["20", "pnpm@11.21.0+sha.4c2f1"],
  ])(
    "accepts the persisted Node major %s and pnpm pin %s",
    (nodeLtsMajor, packageManagerPin) => {
      expect(
        parseGenerationRecord({
          ...validRecord,
          toolchain: { nodeLtsMajor, packageManagerPin },
        }).toolchain,
      ).toEqual({ nodeLtsMajor, packageManagerPin });
    },
  );

  it.each(["latest", "24.x", "v24"])(
    "rejects a persisted Node LTS major %s",
    (nodeLtsMajor) => {
      expect(() =>
        parseGenerationRecord({
          ...validRecord,
          toolchain: { ...validRecord.toolchain, nodeLtsMajor },
        }),
      ).toThrow(
        /^Generation Record toolchain\.nodeLtsMajor must be a numeric Node major$/u,
      );
    },
  );

  it.each([
    "pnpm@11",
    "pnpm@11.21",
    "pnpm@11.21.0.",
    "pnpm@11.21.0-",
    "pnpm 11.21.0",
    "11.21.0",
  ])(
    "rejects a persisted pnpm pin %s that is not an exact version",
    (packageManagerPin) => {
      expect(() =>
        parseGenerationRecord({
          ...validRecord,
          toolchain: { ...validRecord.toolchain, packageManagerPin },
        }),
      ).toThrow(
        /^Generation Record toolchain\.packageManagerPin must be an exact pnpm version pin$/u,
      );
    },
  );
});

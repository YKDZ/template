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

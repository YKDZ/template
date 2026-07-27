import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAtomicProjectRenderer } from "#template-core/renderer";
import { describe, expect, it } from "vitest";

describe("atomic renderer", () => {
  it("commits only planned paths and rolls them all back after a commit failure", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-atomic-rollback-"),
    );
    const committedPaths: string[] = [];

    try {
      await Promise.all([
        writeFile(path.join(targetRoot, "first.json"), '{"state":"before"}\n'),
        writeFile(path.join(targetRoot, "second.json"), '{"state":"before"}\n'),
        writeFile(path.join(targetRoot, "unplanned.txt"), "untouched\n"),
      ]);
      const renderAtomically = createAtomicProjectRenderer({
        async commitPath(options) {
          committedPaths.push(options.relativePath);
          if (options.relativePath === "second.json") {
            throw new Error("injected commit failure");
          }
          await options.commit();
        },
      });

      await expect(
        renderAtomically({
          targetRoot,
          operations: [
            {
              kind: "writeJson",
              to: "first.json",
              value: { state: "after" },
              overwrite: true,
            },
            {
              kind: "writeJson",
              to: "second.json",
              value: { state: "after" },
              overwrite: true,
            },
          ],
        }),
      ).rejects.toThrow("injected commit failure");

      await expect(
        readFile(path.join(targetRoot, "first.json"), "utf8"),
      ).resolves.toBe('{"state":"before"}\n');
      await expect(
        readFile(path.join(targetRoot, "second.json"), "utf8"),
      ).resolves.toBe('{"state":"before"}\n');
      await expect(
        readFile(path.join(targetRoot, "unplanned.txt"), "utf8"),
      ).resolves.toBe("untouched\n");
      expect(committedPaths).toEqual(["first.json", "second.json"]);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});

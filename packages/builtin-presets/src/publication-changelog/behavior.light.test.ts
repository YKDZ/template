import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inspectPackageReleaseChangelog } from "@ykdz/template-workspace/publication/changelog";

const standardCategories = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

void describe("package release changelog", () => {
  void it("projects the exact target release body without its heading or footer links", () => {
    const source = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-08-26

### Added

- Add a release command with an [inline guide](https://example.test/guide).

[Unreleased]: https://github.com/example/tool/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/example/tool/releases/tag/v1.2.3
`;

    assert.deepStrictEqual(inspectPackageReleaseChangelog(source, "1.2.3"), {
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes:
        "### Added\n\n- Add a release command with an [inline guide](https://example.test/guide).\n",
    });
  });

  void it("ignores Unreleased headings inside backtick and tilde fences", () => {
    const source = `# Changelog

## [Unreleased]

\`\`\`md
## [Unreleased]
\`\`\`

   ~~~md
## [Unreleased]
   ~~~

## [1.0.0] - 2026-08-26

- Publish the first release.
`;

    assert.deepStrictEqual(inspectPackageReleaseChangelog(source, "1.0.0"), {
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes: "- Publish the first release.\n",
    });
  });

  for (const releaseDate of [
    "0000-01-01",
    "1900-02-29",
    "2025-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-8-01",
  ]) {
    void it(`rejects a non-existent Gregorian release date: ${releaseDate}`, () => {
      const inspection = inspectPackageReleaseChangelog(
        `## [Unreleased]

## [1.0.0] - ${releaseDate}

- Publish the first release.
`,
        "1.0.0",
      );

      assert.deepStrictEqual(
        inspection.blockers.map(({ code }) => code),
        ["changelog-target-release-date-invalid"],
      );
      assert.ok(!("releaseDate" in inspection));
      assert.ok(!("releaseNotes" in inspection));
    });
  }

  for (const testCase of [
    {
      name: "missing Unreleased",
      source: `## [1.0.0] - 2026-08-26

- Publish the first release.
`,
      code: "changelog-unreleased-missing",
    },
    {
      name: "duplicate Unreleased",
      source: `## [Unreleased]

## [Unreleased]

## [1.0.0] - 2026-08-26

- Publish the first release.
`,
      code: "changelog-unreleased-duplicate",
    },
    {
      name: "missing exact target",
      source: `## [Unreleased]

## [v1.0.0] - 2026-08-26

- Publish the first release.
`,
      code: "changelog-target-release-missing",
    },
    {
      name: "duplicate target",
      source: `## [Unreleased]

## [1.0.0] - not-a-date

## [1.0.0] - 2026-08-26
`,
      code: "changelog-target-release-duplicate",
    },
    {
      name: "empty target body after footer removal",
      source: `## [Unreleased]

## [1.0.0] - 2026-08-26

[Unreleased]: https://example.test/compare/v1.0.0...HEAD
[1.0.0]: https://example.test/releases/tag/v1.0.0
`,
      code: "changelog-target-release-body-empty",
    },
  ] as const) {
    const { name, source, code } = testCase;
    void it(`returns the stable blocker for ${name}`, () => {
      const inspection = inspectPackageReleaseChangelog(source, "1.0.0");

      assert.deepStrictEqual(
        inspection.blockers.map((item) => item.code),
        [code],
      );
      const [blocker] = inspection.blockers;
      assert.ok(blocker !== undefined);
      assert.deepStrictEqual(Object.keys(blocker).toSorted(), [
        "code",
        "expected",
        "nextAction",
        "observed",
      ]);
      assert.strictEqual(blocker.code, code);
      assert.strictEqual(typeof blocker.observed, "string");
      assert.strictEqual(typeof blocker.expected, "string");
      assert.strictEqual(typeof blocker.nextAction, "string");
      assert.ok(!("releaseDate" in inspection));
      assert.ok(!("releaseNotes" in inspection));
    });
  }

  void it("reports independent missing sections in deterministic contract order", () => {
    assert.deepStrictEqual(
      inspectPackageReleaseChangelog("# Changelog\n", "1.0.0").blockers.map(
        ({ code }) => code,
      ),
      ["changelog-unreleased-missing", "changelog-target-release-missing"],
    );
  });

  void it("does not let shorter or different fence markers expose fake headings", () => {
    const source = `## [Unreleased]

\`\`\`\`md
## [1.0.0] - 2025-02-29
\`\`\`
## [1.0.0] - 2026-13-01
~~~
## [1.0.0] - 2026-04-31
\`\`\`\`

## [1.0.0] - 2024-02-29

- Publish the first release.
`;

    assert.deepStrictEqual(inspectPackageReleaseChangelog(source, "1.0.0"), {
      blockers: [],
      releaseDate: "2024-02-29",
      releaseNotes: "- Publish the first release.\n",
    });
  });

  void it("preserves CRLF body bytes while omitting the complete footer", () => {
    const source = [
      "## [Unreleased]",
      "",
      "## [1.0.0] - 2000-02-29",
      "",
      "### Fixed",
      "",
      "- Preserve CRLF bytes.",
      "",
      "[Unreleased]: https://example.test/compare/v1.0.0...HEAD",
      "",
      "[1.0.0]: https://example.test/releases/tag/v1.0.0",
      "",
    ].join("\r\n");

    assert.deepStrictEqual(inspectPackageReleaseChangelog(source, "1.0.0"), {
      blockers: [],
      releaseDate: "2000-02-29",
      releaseNotes: "### Fixed\r\n\r\n- Preserve CRLF bytes.\r\n",
    });
  });

  void it("only omits reference definitions from the document-bottom footer", () => {
    const source = `## [Unreleased]

## [1.1.0] - 2026-08-26

[details]: https://example.test/release-details

## [1.0.0] - 2026-08-01

- Publish the first release.

[Unreleased]: https://example.test/compare/v1.1.0...HEAD
[1.1.0]: https://example.test/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.test/releases/tag/v1.0.0
`;

    assert.deepStrictEqual(inspectPackageReleaseChangelog(source, "1.1.0"), {
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes: "[details]: https://example.test/release-details\n",
    });
  });

  for (const category of standardCategories) {
    void it(`accepts the fixed KAC category without requiring every category: ${category}`, () => {
      const inspection = inspectPackageReleaseChangelog(
        `## [Unreleased]

## [1.0.0] - 2026-08-26

### ${category}

- Publish a user-visible change.
`,
        "1.0.0",
      );

      assert.deepStrictEqual(inspection.blockers, []);
    });
  }

  void it("does not expand profile style into release-critical blockers", () => {
    const inspection = inspectPackageReleaseChangelog(
      `Custom project preamble.

## [Unreleased]

## [1.0.0] - 2026-08-26

### Breaking

- Publish a user-visible change without comparison links.
`,
      "1.0.0",
    );

    assert.deepStrictEqual(inspection.blockers, []);
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { inspectPackageReleaseChangelog } from "../../templates/ts-cli/publication/changelog.ts";

const standardCategories = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

describe("package release changelog", () => {
  it("keeps the checked template on the fixed English KAC 2.0.0 profile", async () => {
    const template = await readFile(
      new URL(
        "../../templates/ts-cli/publication/CHANGELOG.md.template",
        import.meta.url,
      ),
      "utf8",
    );
    const preamble = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;
    expect(template.startsWith(preamble)).toBe(true);
    const renderedCategories = [...template.matchAll(/^### (.+)$/gmu)].map(
      (match) => match[1],
    );
    expect(renderedCategories).toEqual(["Added"]);
    expect(
      renderedCategories.every((category) =>
        standardCategories.includes(
          category as (typeof standardCategories)[number],
        ),
      ),
    ).toBe(true);
    expect(template).toContain(
      "[Unreleased]: {{REPOSITORY_URL}}/compare/v{{PACKAGE_VERSION}}...HEAD",
    );
    expect(template).toContain(
      "[{{PACKAGE_VERSION}}]: {{REPOSITORY_URL}}/releases/tag/v{{PACKAGE_VERSION}}",
    );
    expect(
      inspectPackageReleaseChangelog(
        template
          .replaceAll("{{PACKAGE_VERSION}}", "1.0.0")
          .replaceAll("{{RELEASE_DATE}}", "2026-08-26")
          .replaceAll("{{REPOSITORY_URL}}", "https://github.com/example/tool"),
        "1.0.0",
      ),
    ).toEqual({
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes: "### Added\n\n- Publish the first stable release.\n",
    });
  });

  it("projects the exact target release body without its heading or footer links", () => {
    const source = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-08-26

### Added

- Add a release command with an [inline guide](https://example.test/guide).

[Unreleased]: https://github.com/example/tool/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/example/tool/releases/tag/v1.2.3
`;

    expect(inspectPackageReleaseChangelog(source, "1.2.3")).toEqual({
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes:
        "### Added\n\n- Add a release command with an [inline guide](https://example.test/guide).\n",
    });
  });

  it("ignores Unreleased headings inside backtick and tilde fences", () => {
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

    expect(inspectPackageReleaseChangelog(source, "1.0.0")).toEqual({
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes: "- Publish the first release.\n",
    });
  });

  it.each([
    "0000-01-01",
    "1900-02-29",
    "2025-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-8-01",
  ])("rejects a non-existent Gregorian release date: %s", (releaseDate) => {
    const inspection = inspectPackageReleaseChangelog(
      `## [Unreleased]

## [1.0.0] - ${releaseDate}

- Publish the first release.
`,
      "1.0.0",
    );

    expect(inspection.blockers.map(({ code }) => code)).toEqual([
      "changelog-target-release-date-invalid",
    ]);
    expect(inspection).not.toHaveProperty("releaseDate");
    expect(inspection).not.toHaveProperty("releaseNotes");
  });

  it.each([
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
  ] as const)("returns the stable blocker for $name", ({ source, code }) => {
    const inspection = inspectPackageReleaseChangelog(source, "1.0.0");

    expect(inspection.blockers.map((item) => item.code)).toEqual([code]);
    expect(inspection.blockers[0]).toEqual({
      code,
      observed: expect.any(String),
      expected: expect.any(String),
      nextAction: expect.any(String),
    });
    expect(inspection).not.toHaveProperty("releaseDate");
    expect(inspection).not.toHaveProperty("releaseNotes");
  });

  it("reports independent missing sections in deterministic contract order", () => {
    expect(
      inspectPackageReleaseChangelog("# Changelog\n", "1.0.0").blockers.map(
        ({ code }) => code,
      ),
    ).toEqual([
      "changelog-unreleased-missing",
      "changelog-target-release-missing",
    ]);
  });

  it("does not let shorter or different fence markers expose fake headings", () => {
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

    expect(inspectPackageReleaseChangelog(source, "1.0.0")).toEqual({
      blockers: [],
      releaseDate: "2024-02-29",
      releaseNotes: "- Publish the first release.\n",
    });
  });

  it("preserves CRLF body bytes while omitting the complete footer", () => {
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

    expect(inspectPackageReleaseChangelog(source, "1.0.0")).toEqual({
      blockers: [],
      releaseDate: "2000-02-29",
      releaseNotes: "### Fixed\r\n\r\n- Preserve CRLF bytes.\r\n",
    });
  });

  it("only omits reference definitions from the document-bottom footer", () => {
    const source = `## [Unreleased]

## [1.1.0] - 2026-08-26

[details]: https://example.test/release-details

## [1.0.0] - 2026-08-01

- Publish the first release.

[Unreleased]: https://example.test/compare/v1.1.0...HEAD
[1.1.0]: https://example.test/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.test/releases/tag/v1.0.0
`;

    expect(inspectPackageReleaseChangelog(source, "1.1.0")).toEqual({
      blockers: [],
      releaseDate: "2026-08-26",
      releaseNotes: "[details]: https://example.test/release-details\n",
    });
  });

  it.each(standardCategories)(
    "accepts the fixed KAC category without requiring every category: %s",
    (category) => {
      const inspection = inspectPackageReleaseChangelog(
        `## [Unreleased]

## [1.0.0] - 2026-08-26

### ${category}

- Publish a user-visible change.
`,
        "1.0.0",
      );

      expect(inspection.blockers).toEqual([]);
    },
  );

  it("does not expand profile style into release-critical blockers", () => {
    const inspection = inspectPackageReleaseChangelog(
      `Custom project preamble.

## [Unreleased]

## [1.0.0] - 2026-08-26

### Breaking

- Publish a user-visible change without comparison links.
`,
      "1.0.0",
    );

    expect(inspection.blockers).toEqual([]);
  });
});

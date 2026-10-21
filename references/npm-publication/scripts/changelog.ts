export type ChangelogBlockerCode =
  | "changelog-target-release-missing"
  | "changelog-target-release-duplicate"
  | "changelog-target-release-body-empty";

export type ChangelogBlocker = {
  readonly code: ChangelogBlockerCode;
};

export type PackageReleaseChangelogInspection =
  | {
      readonly blockers: readonly [];
      readonly releaseNotes: string;
    }
  | {
      readonly blockers: readonly [ChangelogBlocker, ...ChangelogBlocker[]];
      readonly releaseNotes?: never;
    };

function hasVersionHeading(line: string, version: string): boolean {
  const heading = `## [${version}]`;
  const suffix = line.slice(heading.length);
  return (
    line.startsWith(heading) && (suffix.length === 0 || /^[\t ]/u.test(suffix))
  );
}

/** 只要求目标版本区段唯一且正文非空。 */
export function inspectPackageReleaseChangelog(
  source: string,
  targetVersion: string,
): PackageReleaseChangelogInspection {
  const lines = source.split(/\r?\n/u);
  const headings = lines
    .map((line, index) => (hasVersionHeading(line, targetVersion) ? index : -1))
    .filter((index) => index >= 0);
  if (headings.length === 0) {
    return {
      blockers: [{ code: "changelog-target-release-missing" }],
    };
  }
  if (headings.length > 1) {
    return {
      blockers: [{ code: "changelog-target-release-duplicate" }],
    };
  }
  const start = headings[0]! + 1;
  const nextSection = lines.findIndex(
    (line, index) => index >= start && /^##(?:\s|$)/u.test(line),
  );
  const end = nextSection < 0 ? lines.length : nextSection;
  const releaseNotes = lines.slice(start, end).join("\n").trim();
  if (releaseNotes.length === 0) {
    return {
      blockers: [{ code: "changelog-target-release-body-empty" }],
    };
  }
  return { blockers: [], releaseNotes };
}

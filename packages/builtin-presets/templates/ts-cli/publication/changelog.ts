export type ChangelogBlockerCode =
  | "changelog-unreleased-missing"
  | "changelog-unreleased-duplicate"
  | "changelog-target-release-missing"
  | "changelog-target-release-duplicate"
  | "changelog-target-release-date-invalid"
  | "changelog-target-release-body-empty";

export type ChangelogBlocker = {
  readonly code: ChangelogBlockerCode;
  readonly observed: string;
  readonly expected: string;
  readonly nextAction: string;
};

export type PackageReleaseChangelogInspection =
  | {
      readonly blockers: readonly [];
      readonly releaseDate: string;
      readonly releaseNotes: string;
    }
  | {
      readonly blockers: readonly [ChangelogBlocker, ...ChangelogBlocker[]];
      readonly releaseDate?: never;
      readonly releaseNotes?: never;
    };

type SourceLine = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly outsideFence: boolean;
};

type Fence = {
  readonly marker: "`" | "~";
  readonly length: number;
};

function openingFence(text: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
  if (match === null) return undefined;
  const run = match[1]!;
  const marker = run[0] as "`" | "~";
  if (marker === "`" && match[2]!.includes("`")) return undefined;
  return { marker, length: run.length };
}

function closesFence(text: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(text);
  return (
    match !== null &&
    match[1]![0] === fence.marker &&
    match[1]!.length >= fence.length
  );
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let fence: Fence | undefined;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    let contentEnd = newline === -1 ? source.length : newline;
    if (contentEnd > start && source[contentEnd - 1] === "\r") {
      contentEnd -= 1;
    }
    const text = source.slice(start, contentEnd);
    const outsideFence = fence === undefined;
    if (fence === undefined) {
      fence = openingFence(text);
    } else if (closesFence(text, fence)) {
      fence = undefined;
    }
    lines.push({
      text,
      start,
      end,
      outsideFence: outsideFence && fence === undefined,
    });
    start = end;
  }
  return lines;
}

function blocker(
  code: ChangelogBlockerCode,
  observed: string,
  expected: string,
  nextAction: string,
): ChangelogBlocker {
  return { code, observed, expected, nextAction };
}

function releaseHeading(
  text: string,
): { readonly label: string; readonly suffix: string } | undefined {
  const match = /^## \[([^\]]+)\](.*)$/u.exec(text);
  return match === null ? undefined : { label: match[1]!, suffix: match[2]! };
}

function isGregorianCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function trimBoundaryBlankLines(
  source: string,
  lines: readonly SourceLine[],
): string {
  const contentLines = lines.filter((line) => line.text.trim().length > 0);
  const first = contentLines.at(0);
  const last = contentLines.at(-1);
  return first === undefined || last === undefined
    ? ""
    : source.slice(first.start, last.end);
}

function isReferenceDefinition(line: SourceLine): boolean {
  return line.outsideFence && /^\[[^\]]+\]:\s+\S/u.test(line.text);
}

function documentFooterStart(lines: readonly SourceLine[]): number | undefined {
  let index = lines.length - 1;
  while (index >= 0 && lines[index]!.text.trim().length === 0) index -= 1;
  if (index < 0 || !isReferenceDefinition(lines[index]!)) return undefined;

  let footerStart = lines[index]!.start;
  index -= 1;
  while (index >= 0) {
    const line = lines[index]!;
    if (isReferenceDefinition(line)) {
      footerStart = line.start;
      index -= 1;
      continue;
    }
    if (line.text.trim().length === 0) {
      index -= 1;
      continue;
    }
    break;
  }
  return footerStart;
}

export function inspectPackageReleaseChangelog(
  source: string,
  targetVersion: string,
): PackageReleaseChangelogInspection {
  const lines = sourceLines(source);
  const blockers: ChangelogBlocker[] = [];
  const unreleased = lines.filter(
    (line) => line.outsideFence && line.text === "## [Unreleased]",
  );
  if (unreleased.length === 0) {
    blockers.push(
      blocker(
        "changelog-unreleased-missing",
        "No Unreleased section was found",
        "Exactly one ## [Unreleased] section",
        "Add the package changelog Unreleased section.",
      ),
    );
  } else if (unreleased.length > 1) {
    blockers.push(
      blocker(
        "changelog-unreleased-duplicate",
        `${unreleased.length} Unreleased sections were found`,
        "Exactly one ## [Unreleased] section",
        "Keep one package changelog Unreleased section.",
      ),
    );
  }

  const targets = lines.filter(
    (line) =>
      line.outsideFence && releaseHeading(line.text)?.label === targetVersion,
  );
  if (targets.length === 0) {
    blockers.push(
      blocker(
        "changelog-target-release-missing",
        `No ${targetVersion} release section was found`,
        `Exactly one ## [${targetVersion}] - YYYY-MM-DD section`,
        `Add the ${targetVersion} release section to the package changelog.`,
      ),
    );
  } else if (targets.length > 1) {
    blockers.push(
      blocker(
        "changelog-target-release-duplicate",
        `${targets.length} ${targetVersion} release sections were found`,
        `Exactly one ## [${targetVersion}] - YYYY-MM-DD section`,
        `Keep one ${targetVersion} release section in the package changelog.`,
      ),
    );
  }

  const target = targets.length === 1 ? targets[0] : undefined;
  const dateMatch = /^ - (\d{4}-\d{2}-\d{2})$/u.exec(
    target === undefined ? "" : releaseHeading(target.text)!.suffix,
  );
  const releaseDate = dateMatch?.[1];
  if (
    target !== undefined &&
    (releaseDate === undefined || !isGregorianCalendarDate(releaseDate))
  ) {
    blockers.push(
      blocker(
        "changelog-target-release-date-invalid",
        target.text,
        `## [${targetVersion}] - YYYY-MM-DD with a real calendar date`,
        `Correct the ${targetVersion} release heading date.`,
      ),
    );
  }

  let releaseNotes = "";
  if (
    target !== undefined &&
    releaseDate !== undefined &&
    isGregorianCalendarDate(releaseDate)
  ) {
    const followingHeading = lines.find(
      (line) =>
        line.start >= target.end &&
        line.outsideFence &&
        line.text.startsWith("## "),
    );
    const footerStart = documentFooterStart(lines);
    const sectionEnd = Math.min(
      followingHeading?.start ?? source.length,
      footerStart ?? source.length,
    );
    const sectionLines = lines.filter(
      (line) => line.start >= target.end && line.start < sectionEnd,
    );
    releaseNotes = trimBoundaryBlankLines(source, sectionLines);
    if (releaseNotes.length === 0) {
      blockers.push(
        blocker(
          "changelog-target-release-body-empty",
          `The ${targetVersion} release body is empty`,
          "A non-empty release body after footer definitions are removed",
          `Document the ${targetVersion} user-visible changes.`,
        ),
      );
    }
  }

  if (blockers.length > 0) {
    return {
      blockers: blockers as [ChangelogBlocker, ...ChangelogBlocker[]],
    };
  }

  return {
    blockers: [],
    releaseDate: releaseDate!,
    releaseNotes,
  };
}

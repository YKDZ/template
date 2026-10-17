import { dependencyCatalogSnapshot } from "./workspace-policy-snapshot.ts";

export type TemplateDependencyCatalog = Record<string, string>;

export type GeneratedDependencyCatalogOptions = {
  readonly dependencies: readonly string[];
  readonly packages?: readonly string[];
  readonly allowBuilds?: Record<string, boolean>;
  readonly dependencyLinker?:
    | { readonly kind: "isolated" }
    | { readonly kind: "hoisted"; readonly evidence: string };
  readonly minimumReleaseAgeExclude?: readonly string[];
  readonly overrides?: Readonly<Record<string, string>>;
};

export type GeneratedPackageManifestDependencies = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

const exactNpmPackageIdentityPattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const defaultGeneratedMinimumReleaseAgeExclusions = ["@ykdz/template"] as const;

function assertMinimumReleaseAgeExclusions(
  exclusions: readonly string[],
): void {
  if (exclusions.some((dependency) => dependency.length === 0)) {
    throw new Error("Dependency maturity exclusions must be non-empty");
  }

  if (new Set(exclusions).size !== exclusions.length) {
    throw new Error("Dependency maturity exclusions must be unique");
  }

  const invalid = exclusions.find(
    (dependency) =>
      dependency.length > 214 ||
      !exactNpmPackageIdentityPattern.test(dependency),
  );
  if (invalid !== undefined) {
    throw new Error(
      `Dependency maturity exclusions must be exact npm package identities: ${JSON.stringify(invalid)}`,
    );
  }
}

function parseTemplateCatalogSection(
  workspaceYaml: string,
  sectionName: "catalog",
): TemplateDependencyCatalog {
  const catalog: TemplateDependencyCatalog = {};
  const lines = workspaceYaml.split(/\r?\n/);
  const catalogStart = lines.findIndex((line) => line === `${sectionName}:`);

  if (catalogStart === -1) {
    return catalog;
  }

  for (const line of lines.slice(catalogStart + 1)) {
    if (line.length > 0 && !line.startsWith("  ")) {
      break;
    }

    const match = /^  (?:"([^"]+)"|([^:]+)): (.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1] ?? match[2];
    const version = match[3];
    if (key === undefined || version === undefined) {
      continue;
    }

    catalog[key] = version;
  }

  return catalog;
}

function parseTemplateDependencyCatalog(
  workspaceYaml: string,
): TemplateDependencyCatalog {
  return parseTemplateCatalogSection(workspaceYaml, "catalog");
}

export function loadTemplateDependencyCatalog(): TemplateDependencyCatalog {
  return { ...dependencyCatalogSnapshot };
}

export function selectTemplateDependencyCatalogEntries(
  dependencies: readonly string[],
  catalog: TemplateDependencyCatalog = loadTemplateDependencyCatalog(),
): TemplateDependencyCatalog {
  const selected: TemplateDependencyCatalog = {};

  for (const dependency of dependencies.toSorted()) {
    const version = catalog[dependency];
    if (version === undefined) {
      throw new Error(
        `Template Dependency Catalog is missing dependency: ${dependency}`,
      );
    }

    selected[dependency] = version;
  }

  return selected;
}

export function collectGeneratedManifestCatalogReferences(
  manifests: readonly GeneratedPackageManifestDependencies[],
): string[] {
  const dependencies = new Set<string>();

  for (const manifest of manifests) {
    for (const dependencyMap of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, specifier] of Object.entries(
        dependencyMap ?? {},
      )) {
        if (specifier.startsWith("catalog:")) {
          dependencies.add(dependency);
        }
      }
    }
  }

  return [...dependencies].toSorted();
}

function renderCatalogKey(key: string): string {
  return key.startsWith("@") ? JSON.stringify(key) : key;
}

export function pnpmWorkspaceYamlWithCatalogDependencies(
  workspaceYaml: string,
  dependencies: readonly string[],
  templateCatalog: TemplateDependencyCatalog = loadTemplateDependencyCatalog(),
): string {
  const catalogStart = workspaceYaml
    .split(/\r?\n/)
    .findIndex((line) => line === "catalog:");

  if (catalogStart === -1) {
    throw new Error(
      "Cannot update pnpm Dependency Catalog: missing catalog section",
    );
  }

  const existingCatalog = parseTemplateDependencyCatalog(workspaceYaml);
  const missingDependencies = dependencies.filter(
    (dependency) => existingCatalog[dependency] === undefined,
  );

  if (missingDependencies.length === 0) {
    return workspaceYaml;
  }

  const nextCatalog = {
    ...existingCatalog,
    ...selectTemplateDependencyCatalogEntries(
      missingDependencies,
      templateCatalog,
    ),
  };
  const lines = workspaceYaml.split(/\r?\n/);
  const catalogEnd = lines.findIndex(
    (line, index) =>
      index > catalogStart && line.length > 0 && !line.startsWith("  "),
  );
  const replacementEnd = catalogEnd === -1 ? lines.length : catalogEnd;
  const catalogLines = [
    "catalog:",
    ...Object.entries(nextCatalog)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(
        ([dependency, version]) =>
          `  ${renderCatalogKey(dependency)}: ${version}`,
      ),
    "",
  ];

  return [
    ...lines.slice(0, catalogStart),
    ...catalogLines,
    ...lines.slice(replacementEnd),
  ].join("\n");
}

export function renderGeneratedPnpmWorkspaceYaml(
  options: GeneratedDependencyCatalogOptions,
): string {
  const configuredMinimumReleaseAgeExclusions =
    options.minimumReleaseAgeExclude ?? [];
  assertMinimumReleaseAgeExclusions(configuredMinimumReleaseAgeExclusions);
  const minimumReleaseAgeExclude = [
    ...new Set([
      ...defaultGeneratedMinimumReleaseAgeExclusions,
      ...configuredMinimumReleaseAgeExclusions,
    ]),
  ];
  if (
    options.dependencyLinker?.kind === "hoisted" &&
    (options.dependencyLinker.evidence.trim().length === 0 ||
      options.dependencyLinker.evidence.includes("\n"))
  ) {
    throw new Error(
      "Hoisted linking requires single-line compatibility evidence",
    );
  }
  const catalog = selectTemplateDependencyCatalogEntries(options.dependencies);
  const packages = options.packages ?? ["."];
  const dependencyLinker = options.dependencyLinker?.kind ?? "isolated";
  const lines = [
    "packages:",
    ...packages.map((workspacePackage) => `  - ${workspacePackage}`),
    "",
    ...(options.dependencyLinker?.kind === "hoisted"
      ? [
          `# Hoisted linker compatibility evidence: ${options.dependencyLinker.evidence}`,
        ]
      : []),
    `nodeLinker: ${dependencyLinker}`,
    "autoInstallPeers: false",
    "resolvePeersFromWorkspaceRoot: false",
    "injectWorkspacePackages: false",
    "dedupeInjectedDeps: false",
    "syncInjectedDepsAfterScripts:",
    "  - build",
    "minimumReleaseAge: 1440",
    "minimumReleaseAgeStrict: true",
    "",
  ];

  if (minimumReleaseAgeExclude.length) {
    lines.push(
      "minimumReleaseAgeExclude:",
      ...minimumReleaseAgeExclude
        .toSorted()
        .map((dependency) => `  - ${JSON.stringify(dependency)}`),
      "",
    );
  }

  if (options.allowBuilds) {
    lines.push(
      "allowBuilds:",
      ...Object.entries(options.allowBuilds)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([dependency, allowed]) => `  ${dependency}: ${allowed}`),
      "",
    );
  }

  const overrides = options.overrides ?? {};
  if (Object.keys(overrides).length > 0) {
    lines.push(
      "overrides:",
      ...Object.entries(overrides)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(
          ([dependency, version]) =>
            `  ${JSON.stringify(dependency)}: ${JSON.stringify(version)}`,
        ),
      "",
    );
  }

  lines.push(
    "catalog:",
    ...Object.entries(catalog).map(
      ([dependency, version]) =>
        `  ${renderCatalogKey(dependency)}: ${version}`,
    ),
    "",
  );

  return lines.join("\n");
}

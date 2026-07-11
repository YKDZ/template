import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TemplateDependencyCatalog = Record<string, string>;
export type TemplateCargoDependencyVersions = Record<string, string>;

export type GeneratedDependencyCatalogOptions = {
  readonly dependencies: readonly string[];
  readonly packages?: readonly string[];
  readonly allowBuilds?: Record<string, boolean>;
  readonly dependencyLinker?:
    | { readonly kind: "isolated" }
    | { readonly kind: "hoisted"; readonly evidence: string };
  readonly minimumReleaseAgeExclude?: readonly string[];
  readonly overrides?: Readonly<Record<string, string>>;
  readonly pnpmfile?: string;
};

export type GeneratedPackageManifestDependencies = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

const exactNpmPackageIdentityPattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

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

function templateRepositoryRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.TEMPLATE_REPOSITORY_ROOT,
    moduleDir,
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", ".."),
    path.resolve(moduleDir, "..", "..", ".."),
  ];

  return (
    candidates.find(
      (candidate) =>
        candidate !== undefined &&
        existsSync(path.join(candidate, "pnpm-workspace.yaml")),
    ) ?? moduleDir
  );
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
  return parseTemplateDependencyCatalog(
    readFileSync(
      path.join(templateRepositoryRoot(), "pnpm-workspace.yaml"),
      "utf8",
    ),
  );
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

function parseTemplateCargoDependencyVersions(
  cargoToml: string,
): TemplateCargoDependencyVersions {
  const dependencies: TemplateCargoDependencyVersions = {};
  const lines = cargoToml.split(/\r?\n/);
  const dependenciesStart = lines.findIndex(
    (line) => line.trim() === "[dependencies]",
  );

  if (dependenciesStart === -1) {
    return dependencies;
  }

  for (const line of lines.slice(dependenciesStart + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      break;
    }

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*"([^"]+)"\s*$/.exec(
      trimmed,
    );
    if (!match) {
      throw new Error(
        `Unsupported Template Cargo dependency declaration: ${trimmed}`,
      );
    }

    const dependency = match[1] ?? match[2];
    const version = match[3];
    if (dependency === undefined || version === undefined) {
      continue;
    }

    dependencies[dependency] = version;
  }

  return dependencies;
}

export function loadTemplateCargoDependencyVersions(): TemplateCargoDependencyVersions {
  return parseTemplateCargoDependencyVersions(
    readFileSync(path.join(templateRepositoryRoot(), "Cargo.toml"), "utf8"),
  );
}

function loadTemplateCargoLock(): string {
  return readFileSync(
    path.join(templateRepositoryRoot(), "Cargo.lock"),
    "utf8",
  );
}

export function renderCargoLockForPackage(options: {
  readonly packageName: string;
  readonly packageVersion: string;
}): string {
  return loadTemplateCargoLock()
    .replace(
      'name = "template-cargo-dependencies"',
      `name = ${JSON.stringify(options.packageName)}`,
    )
    .replace(
      'version = "0.0.0"',
      `version = ${JSON.stringify(options.packageVersion)}`,
    );
}

export function selectTemplateCargoDependencyVersions(
  dependencies: readonly string[],
  catalog: TemplateCargoDependencyVersions = loadTemplateCargoDependencyVersions(),
): TemplateCargoDependencyVersions {
  const selected: TemplateCargoDependencyVersions = {};

  for (const dependency of dependencies.toSorted()) {
    const version = catalog[dependency];
    if (version === undefined) {
      throw new Error(
        `Template Cargo dependency versions are missing dependency: ${dependency}`,
      );
    }

    selected[dependency] = version;
  }

  return selected;
}

function renderTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function renderCargoDependencyTomlEntries(
  dependencies: readonly string[],
  catalog: TemplateCargoDependencyVersions = loadTemplateCargoDependencyVersions(),
): string[] {
  return Object.entries(
    selectTemplateCargoDependencyVersions(dependencies, catalog),
  ).map(([dependency, version]) => {
    return `${renderTomlKey(dependency)} = ${JSON.stringify(version)}`;
  });
}

export function collectGeneratedManifestCatalogDependencies(
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
        if (specifier !== "catalog:") {
          throw new Error(
            `Generated manifest dependency ${dependency} must use catalog:, got ${specifier}`,
          );
        }

        dependencies.add(dependency);
      }
    }
  }

  return [...dependencies].toSorted();
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
  assertMinimumReleaseAgeExclusions(options.minimumReleaseAgeExclude ?? []);
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
    ...(options.pnpmfile === undefined
      ? []
      : [`pnpmfile: ${options.pnpmfile}`]),
    "autoInstallPeers: false",
    "resolvePeersFromWorkspaceRoot: false",
    "injectWorkspacePackages: true",
    "dedupeInjectedDeps: false",
    "syncInjectedDepsAfterScripts:",
    "  - build:run",
    "minimumReleaseAge: 1440",
    "minimumReleaseAgeStrict: true",
    "",
  ];

  if (options.minimumReleaseAgeExclude?.length) {
    lines.push(
      "minimumReleaseAgeExclude:",
      ...options.minimumReleaseAgeExclude
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

  const overrides = {
    "pinia>typescript": "-",
    "valibot>typescript": "-",
    "vue>typescript": "-",
    ...options.overrides,
  };
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

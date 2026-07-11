export type ToolchainResolutionSource = "online" | "bundled-fallback";

export type NodeLtsMajor = {
  readonly kind: "NodeLtsMajor";
  readonly value: string;
};

export type PackageManagerPin = {
  readonly kind: "PackageManagerPin";
  readonly value: `pnpm@${string}`;
};

export type ResolvedToolchainVersions = {
  readonly nodeLtsMajor: NodeLtsMajor;
  readonly packageManagerPin: PackageManagerPin;
  readonly source: ToolchainResolutionSource;
  readonly diagnostics: string[];
};

export type ResolveToolchainVersionsOptions = {
  readonly source?: ToolchainResolutionSource | "auto" | undefined;
  readonly fetchJson?: ((url: string) => Promise<unknown>) | undefined;
  readonly nodeReleaseIndexUrl?: string | undefined;
  readonly pnpmRegistryUrl?: string | undefined;
  readonly now?: Date | string | undefined;
};

export const nodeReleaseIndexUrl = "https://nodejs.org/dist/index.json";
export const pnpmRegistryUrl = "https://registry.npmjs.org/pnpm";

type OnlineToolchainResolutionContractOptions = {
  readonly fetchJson?: ((url: string) => Promise<unknown>) | undefined;
};

export type OnlineToolchainResolutionContractResult = {
  readonly nodeLtsMajor: NodeLtsMajor;
  readonly packageManagerPin: PackageManagerPin;
  readonly diagnostics: string[];
};

const bundledFallbackToolchain = {
  nodeLtsMajor: nodeLtsMajor("24"),
  packageManagerPin: packageManagerPin("11.11.0"),
};

type NodeRelease = {
  readonly version: string;
  readonly lts: string | boolean;
};

type PnpmRegistryMetadata = {
  readonly time: Readonly<Record<string, string>>;
  readonly versions: Record<
    string,
    { readonly engines?: { readonly node?: string } }
  >;
};

export async function resolveToolchainVersions(
  options: ResolveToolchainVersionsOptions = {},
): Promise<ResolvedToolchainVersions> {
  const source = options.source ?? "online";

  if (source === "bundled-fallback") {
    return fallbackResult([]);
  }

  try {
    const fetchJson = options.fetchJson ?? fetchOfficialJson;
    const nodeReleases = parseNodeReleaseIndex(
      await fetchJson(options.nodeReleaseIndexUrl ?? nodeReleaseIndexUrl),
    );
    const nodeMajor = latestLtsMajor(nodeReleases);
    const pnpmMetadata = parsePnpmRegistryMetadata(
      await fetchJson(options.pnpmRegistryUrl ?? pnpmRegistryUrl),
    );
    const nodeVersion = latestLtsVersion(nodeReleases, nodeMajor);
    const pnpmVersion = latestCompatiblePnpmVersion(
      pnpmMetadata,
      nodeVersion,
      instant(options.now ?? new Date()),
    );

    return {
      nodeLtsMajor: nodeMajor,
      packageManagerPin: packageManagerPin(pnpmVersion),
      source: "online",
      diagnostics: [],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackResult([
      `Using bundled fallback toolchain metadata because online resolution failed: ${message}`,
    ]);
  }
}

export async function checkOnlineToolchainResolutionContract(
  options: OnlineToolchainResolutionContractOptions = {},
): Promise<OnlineToolchainResolutionContractResult> {
  const fetchJson = options.fetchJson ?? fetchOfficialJson;
  const nodeSource = await contractPhase("Node source parsing", async () => {
    const releases = parseNodeReleaseIndex(
      await fetchJson(nodeReleaseIndexUrl),
    );
    const major = latestLtsMajor(releases);
    return { major, version: latestLtsVersion(releases, major) };
  });
  const pnpmMetadata = await contractPhase("pnpm source parsing", async () =>
    parsePnpmRegistryMetadata(await fetchJson(pnpmRegistryUrl)),
  );
  const pnpmVersion = await contractPhase("compatibility selection", async () =>
    latestCompatiblePnpmVersion(pnpmMetadata, nodeSource.version),
  );

  return {
    nodeLtsMajor: nodeSource.major,
    packageManagerPin: packageManagerPin(pnpmVersion),
    diagnostics: [
      `Node source parsing succeeded; latest LTS major is ${nodeSource.major.value}.`,
      `pnpm source parsing succeeded; latest compatible pnpm release is ${pnpmVersion}.`,
      `Compatibility selection succeeded for pnpm@${pnpmVersion} on Node ${nodeSource.major.value}.`,
    ],
  };
}

async function contractPhase<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Online toolchain resolution contract failed during ${phase}: ${message}`,
      { cause: error },
    );
  }
}

function fallbackResult(diagnostics: string[]): ResolvedToolchainVersions {
  return {
    nodeLtsMajor: bundledFallbackToolchain.nodeLtsMajor,
    packageManagerPin: bundledFallbackToolchain.packageManagerPin,
    source: "bundled-fallback",
    diagnostics,
  };
}

function nodeLtsMajor(value: string): NodeLtsMajor {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid Node LTS major: ${value}`);
  }

  return { kind: "NodeLtsMajor", value };
}

function packageManagerPin(version: string): PackageManagerPin {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid pnpm version: ${version}`);
  }

  return { kind: "PackageManagerPin", value: `pnpm@${version}` };
}

async function fetchOfficialJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }

  return response.json();
}

function parseNodeReleaseIndex(value: unknown): NodeRelease[] {
  if (!Array.isArray(value)) {
    throw new Error("Node release index was not an array");
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Node release entry was not an object");
    }

    const version = entry.version;
    const lts = entry.lts;
    if (
      typeof version !== "string" ||
      (typeof lts !== "string" && typeof lts !== "boolean")
    ) {
      throw new Error("Node release entry is missing version or lts");
    }

    return { version, lts };
  });
}

function latestLtsMajor(releases: readonly NodeRelease[]): NodeLtsMajor {
  const majors = releases
    .filter((release) => release.lts !== false)
    .map((release) => release.version.match(/^v(\d+)\./)?.[1])
    .filter((major): major is string => major !== undefined)
    .map(Number);

  if (majors.length === 0) {
    throw new Error("Node release index did not contain any LTS releases");
  }

  return nodeLtsMajor(String(Math.max(...majors)));
}

function latestLtsVersion(
  releases: readonly NodeRelease[],
  major: NodeLtsMajor,
): string {
  const versions = releases
    .filter((release) => release.lts !== false)
    .map((release) => release.version.replace(/^v/, ""))
    .filter(
      (version) =>
        valid(version) !== null && version.startsWith(`${major.value}.`),
    )
    .toSorted(compare);
  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(`Node release index did not contain Node ${major.value}`);
  }
  return latest;
}

function parsePnpmRegistryMetadata(value: unknown): PnpmRegistryMetadata {
  if (!isRecord(value) || !isRecord(value.versions) || !isRecord(value.time)) {
    throw new Error("pnpm registry metadata is missing versions or time");
  }

  const versions: PnpmRegistryMetadata["versions"] = {};
  for (const [version, metadata] of Object.entries(value.versions)) {
    if (!isRecord(metadata)) {
      continue;
    }

    const nodeRange = isRecord(metadata.engines)
      ? metadata.engines.node
      : undefined;
    versions[version] = isRecord(metadata.engines)
      ? {
          engines: typeof nodeRange === "string" ? { node: nodeRange } : {},
        }
      : {};
  }

  const time = Object.fromEntries(
    Object.entries(value.time).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  return { time, versions };
}

function latestCompatiblePnpmVersion(
  metadata: PnpmRegistryMetadata,
  nodeVersion: string,
  now = Date.now(),
): string {
  const candidates = Object.entries(metadata.versions)
    .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version))
    .filter(([, packageMetadata]) =>
      nodeSatisfiesRange(nodeVersion, packageMetadata.engines?.node),
    )
    .filter(([version]) => isMatureRelease(metadata.time[version], now))
    .map(([version]) => version)
    .toSorted(compare);

  const latest = candidates.at(-1);
  if (!latest) {
    throw new Error(
      `pnpm registry metadata did not contain a release compatible with Node ${nodeVersion}`,
    );
  }

  return latest;
}

const pnpmMaturityWindowMilliseconds = 24 * 60 * 60 * 1_000;

function isMatureRelease(
  publishedAt: string | undefined,
  now: number,
): boolean {
  if (publishedAt === undefined) {
    return false;
  }

  const publishedAtMilliseconds = Date.parse(publishedAt);
  return (
    Number.isFinite(publishedAtMilliseconds) &&
    now - publishedAtMilliseconds >= pnpmMaturityWindowMilliseconds
  );
}

function instant(value: Date | string): number {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid resolution time: ${String(value)}`);
  }

  return milliseconds;
}

function nodeSatisfiesRange(
  nodeVersion: string,
  range: string | undefined,
): boolean {
  if (!range) {
    return true;
  }

  return satisfies(nodeVersion, range, { includePrerelease: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { compare, satisfies, valid } from "semver";

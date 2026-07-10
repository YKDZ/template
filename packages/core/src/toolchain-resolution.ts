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
    const pnpmVersion = latestCompatiblePnpmVersion(
      pnpmMetadata,
      Number(nodeMajor.value),
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
  const nodeMajor = await contractPhase("Node source parsing", async () => {
    const nodeReleases = parseNodeReleaseIndex(
      await fetchJson(nodeReleaseIndexUrl),
    );
    return latestLtsMajor(nodeReleases);
  });
  const pnpmMetadata = await contractPhase("pnpm source parsing", async () =>
    parsePnpmRegistryMetadata(await fetchJson(pnpmRegistryUrl)),
  );
  const pnpmVersion = await contractPhase("compatibility selection", async () =>
    latestCompatiblePnpmVersion(pnpmMetadata, Number(nodeMajor.value)),
  );

  return {
    nodeLtsMajor: nodeMajor,
    packageManagerPin: packageManagerPin(pnpmVersion),
    diagnostics: [
      `Node source parsing succeeded; latest LTS major is ${nodeMajor.value}.`,
      `pnpm source parsing succeeded; latest compatible pnpm release is ${pnpmVersion}.`,
      `Compatibility selection succeeded for pnpm@${pnpmVersion} on Node ${nodeMajor.value}.`,
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

function parsePnpmRegistryMetadata(value: unknown): PnpmRegistryMetadata {
  if (!isRecord(value) || !isRecord(value.versions)) {
    throw new Error("pnpm registry metadata is missing versions");
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

  return { versions };
}

function latestCompatiblePnpmVersion(
  metadata: PnpmRegistryMetadata,
  nodeMajor: number,
): string {
  const candidates = Object.entries(metadata.versions)
    .filter(([version]) =>
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version),
    )
    .filter(([, packageMetadata]) =>
      nodeSatisfiesRange(nodeMajor, packageMetadata.engines?.node),
    )
    .map(([version]) => version)
    .toSorted(compareSemver);

  const latest = candidates.at(-1);
  if (!latest) {
    throw new Error(
      `pnpm registry metadata did not contain a release compatible with Node ${nodeMajor}`,
    );
  }

  return latest;
}

function nodeSatisfiesRange(
  nodeMajor: number,
  range: string | undefined,
): boolean {
  if (!range) {
    return true;
  }

  return range
    .split(/\s+/)
    .filter(Boolean)
    .every((comparator) => nodeSatisfiesComparator(nodeMajor, comparator));
}

function nodeSatisfiesComparator(
  nodeMajor: number,
  comparator: string,
): boolean {
  const match = comparator.match(/^(>=|>|<=|<|=)?(\d+)(?:\.\d+){0,2}$/);
  if (!match) {
    return false;
  }

  const operator = match[1] ?? "=";
  const major = Number(match[2]);

  if (operator === ">=") {
    return nodeMajor >= major;
  }

  if (operator === ">") {
    return nodeMajor > major;
  }

  if (operator === "<=") {
    return nodeMajor <= major;
  }

  if (operator === "<") {
    return nodeMajor < major;
  }

  return nodeMajor === major;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).slice(0, 3).map(Number);
  const rightParts = right.split(/[.-]/).slice(0, 3).map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return left.localeCompare(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

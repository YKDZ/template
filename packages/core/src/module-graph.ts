export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: string;
};

export type WorkspaceOrchestrationOwner = {
  readonly kind: "workspace-orchestration";
  readonly path: ".";
};

export type ComponentOwner = PackageBoundaryOwner | WorkspaceOrchestrationOwner;

export type PlaywrightBrowserAssetsEnvironmentNeed = {
  readonly kind: "playwright-browser-assets";
  readonly browser: "chromium";
  readonly owner: ComponentOwner;
};

export type ShellCheckEnvironmentNeed = {
  readonly kind: "shellcheck-command";
  readonly owner: ComponentOwner;
};

/** Rust task leaves require the maintained toolchain in local and CI plans. */
export type RustToolchainEnvironmentNeed = {
  readonly kind: "rust-toolchain";
  readonly owner: ComponentOwner;
  readonly toolchain: "stable";
};

/**
 * Docker is needed only by the focused deployment mode. It is deliberately
 * outside ordinary Check Environment Needs, which apply to every
 * generated-check scenario.
 */
export type DockerEngineEnvironmentNeed = {
  readonly kind: "docker-engine";
};

export type CheckEnvironmentNeed =
  | PlaywrightBrowserAssetsEnvironmentNeed
  | ShellCheckEnvironmentNeed
  | RustToolchainEnvironmentNeed;

export type DeploymentEnvironmentNeed = DockerEngineEnvironmentNeed;

export type EnvironmentNeedsMetadata = {
  readonly schemaVersion: 1;
  readonly check: readonly CheckEnvironmentNeed[];
  readonly deployment: readonly DeploymentEnvironmentNeed[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${context} contains unknown field: ${key}`);
    }
  }
}

function parseComponentOwner(value: unknown, context: string): ComponentOwner {
  if (!isRecord(value)) {
    throw new Error(`${context} must be a Component Owner`);
  }
  assertExactKeys(value, ["kind", "path"], context);
  if (value.kind === "workspace-orchestration" && value.path === ".") {
    return { kind: value.kind, path: value.path };
  }
  if (
    value.kind === "package-boundary" &&
    typeof value.path === "string" &&
    value.path.length > 0
  ) {
    return { kind: value.kind, path: value.path };
  }
  throw new Error(`${context} is not a supported Component Owner`);
}

function parseCheckEnvironmentNeed(
  value: unknown,
  context: string,
): CheckEnvironmentNeed {
  if (!isRecord(value)) {
    throw new Error(`${context} must be a Check Environment Need`);
  }
  switch (value.kind) {
    case "playwright-browser-assets": {
      assertExactKeys(value, ["kind", "browser", "owner"], context);
      if (value.browser !== "chromium") {
        throw new Error(`${context}.browser must be chromium`);
      }
      return {
        kind: value.kind,
        browser: value.browser,
        owner: parseComponentOwner(value.owner, `${context}.owner`),
      };
    }
    case "shellcheck-command":
      assertExactKeys(value, ["kind", "owner"], context);
      return {
        kind: value.kind,
        owner: parseComponentOwner(value.owner, `${context}.owner`),
      };
    case "rust-toolchain": {
      assertExactKeys(value, ["kind", "owner", "toolchain"], context);
      if (value.toolchain !== "stable") {
        throw new Error(`${context}.toolchain must be stable`);
      }
      return {
        kind: value.kind,
        owner: parseComponentOwner(value.owner, `${context}.owner`),
        toolchain: value.toolchain,
      };
    }
    default:
      throw new Error(`${context} has unsupported kind: ${String(value.kind)}`);
  }
}

function parseDeploymentEnvironmentNeed(
  value: unknown,
  context: string,
): DeploymentEnvironmentNeed {
  if (!isRecord(value)) {
    throw new Error(`${context} must be a Deployment Environment Need`);
  }
  assertExactKeys(value, ["kind"], context);
  if (value.kind !== "docker-engine") {
    throw new Error(`${context} has unsupported kind: ${String(value.kind)}`);
  }
  return { kind: value.kind };
}

function componentOwnerIdentity(owner: ComponentOwner): string {
  return `${owner.kind}:${owner.path}`;
}

function checkEnvironmentNeedConflictKey(need: CheckEnvironmentNeed): string {
  return `${need.kind}:${componentOwnerIdentity(need.owner)}`;
}

function checkEnvironmentNeedIdentity(need: CheckEnvironmentNeed): string {
  switch (need.kind) {
    case "playwright-browser-assets":
      return `${checkEnvironmentNeedConflictKey(need)}:browser=${need.browser}`;
    case "shellcheck-command":
      return checkEnvironmentNeedConflictKey(need);
    case "rust-toolchain":
      return `${checkEnvironmentNeedConflictKey(need)}:toolchain=${need.toolchain}`;
  }
}

function normalizeCheckEnvironmentNeeds(
  needs: readonly CheckEnvironmentNeed[],
): readonly CheckEnvironmentNeed[] {
  const byIdentity = new Map<string, CheckEnvironmentNeed>();
  const identityByConflictKey = new Map<string, string>();
  for (const [index, input] of needs.entries()) {
    const need = parseCheckEnvironmentNeed(input, `check[${index}]`);
    const identity = checkEnvironmentNeedIdentity(need);
    const conflictKey = checkEnvironmentNeedConflictKey(need);
    const previousIdentity = identityByConflictKey.get(conflictKey);
    if (previousIdentity !== undefined && previousIdentity !== identity) {
      throw new Error(
        `Check Environment Need ${conflictKey} has conflicting semantic parameters`,
      );
    }
    identityByConflictKey.set(conflictKey, identity);
    byIdentity.set(identity, need);
  }
  return [...byIdentity]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, need]) => need);
}

function normalizeDeploymentEnvironmentNeeds(
  needs: readonly DeploymentEnvironmentNeed[],
): readonly DeploymentEnvironmentNeed[] {
  const byIdentity = new Map<string, DeploymentEnvironmentNeed>();
  for (const [index, input] of needs.entries()) {
    const need = parseDeploymentEnvironmentNeed(input, `deployment[${index}]`);
    byIdentity.set(need.kind, need);
  }
  return [...byIdentity]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, need]) => need);
}

/** Validates, deduplicates, and canonically orders durable Environment Needs. */
export function normalizeEnvironmentNeeds(options: {
  readonly check: readonly CheckEnvironmentNeed[];
  readonly deployment: readonly DeploymentEnvironmentNeed[];
}): EnvironmentNeedsMetadata {
  return {
    schemaVersion: 1,
    check: normalizeCheckEnvironmentNeeds(options.check),
    deployment: normalizeDeploymentEnvironmentNeeds(options.deployment),
  };
}

/** Strict codec for Local Template Metadata consumed by Package Addition. */
export function parseEnvironmentNeedsMetadata(
  value: unknown,
): EnvironmentNeedsMetadata {
  if (!isRecord(value)) {
    throw new Error("Environment Need metadata must be an object");
  }
  assertExactKeys(value, ["schemaVersion", "check", "deployment"], "$");
  if (value.schemaVersion !== 1) {
    throw new Error(
      `Unsupported Environment Need metadata schema version ${String(value.schemaVersion)}; expected 1`,
    );
  }
  if (!Array.isArray(value.check)) {
    throw new Error("$.check must be an array");
  }
  if (!Array.isArray(value.deployment)) {
    throw new Error("$.deployment must be an array");
  }
  return normalizeEnvironmentNeeds({
    check: value.check as CheckEnvironmentNeed[],
    deployment: value.deployment as DeploymentEnvironmentNeed[],
  });
}

export function rustToolchainEnvironmentNeed(
  owner: ComponentOwner,
): RustToolchainEnvironmentNeed {
  return {
    kind: "rust-toolchain",
    owner,
    toolchain: "stable",
  };
}

export function dockerEngineEnvironmentNeed(): DockerEngineEnvironmentNeed {
  return { kind: "docker-engine" };
}

export const qualityTaskVocabulary = [
  "boundaries",
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:e2e",
] as const;

export function renderTurboRunCommand(
  taskNames: readonly string[],
  args: readonly string[] = [],
  options: {
    readonly outputLogs?: "errors-only" | "full";
    readonly continueAfterFailure?: boolean;
    readonly taskPrefix?: boolean;
  } = {},
): string {
  return [
    "turbo run",
    ...taskNames,
    ...args,
    ...(options.continueAfterFailure
      ? ["--continue=dependencies-successful"]
      : []),
    `--output-logs=${options.outputLogs ?? "errors-only"}`,
    "--log-order=grouped",
    ...(options.taskPrefix ? ["--log-prefix=task"] : []),
  ].join(" ");
}

export function renderRootCheckCommand(
  additionalTasks: readonly string[] = [],
): string {
  return renderTurboRunCommand(
    [...qualityTaskVocabulary, ...additionalTasks],
    [],
    {
      continueAfterFailure: true,
      taskPrefix: true,
    },
  );
}

export function renderDeploymentCheckCommand(): string {
  return renderTurboRunCommand(["deployment"], [], { taskPrefix: true });
}

export function renderFixCommand(): string {
  return renderTurboRunCommand(["lint:fix", "format:write"], [], {
    continueAfterFailure: true,
    outputLogs: "full",
    taskPrefix: true,
  });
}

export function playwrightBrowserAssetsEnvironmentNeed(options: {
  readonly browser: "chromium";
  readonly owner: ComponentOwner;
}): PlaywrightBrowserAssetsEnvironmentNeed {
  return {
    kind: "playwright-browser-assets",
    browser: options.browser,
    owner: options.owner,
  };
}

export function shellCheckEnvironmentNeed(
  owner: ComponentOwner,
): ShellCheckEnvironmentNeed {
  return {
    kind: "shellcheck-command",
    owner,
  };
}

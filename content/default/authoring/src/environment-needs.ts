import type {
  CheckEnvironmentNeed,
  ComponentOwner,
  DockerEngineEnvironmentNeed,
  DeploymentEnvironmentNeed,
  EnvironmentNeedsMetadata,
  PlaywrightBrowserAssetsEnvironmentNeed,
  RustToolchainEnvironmentNeed,
  ShellCheckEnvironmentNeed,
} from "./contracts.ts";

export type {
  CheckEnvironmentNeed,
  ComponentOwner,
  DeploymentEnvironmentNeed,
  DockerEngineEnvironmentNeed,
  EnvironmentNeedsMetadata,
  PackageBoundaryOwner,
  PlaywrightBrowserAssetsEnvironmentNeed,
  RustToolchainEnvironmentNeed,
  ShellCheckEnvironmentNeed,
  WorkspaceOrchestrationOwner,
} from "./contracts.ts";

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
      throw new Error(`${context} 含有未知字段：${key}`);
    }
  }
}

function parseComponentOwner(value: unknown, context: string): ComponentOwner {
  if (!isRecord(value)) {
    throw new Error(`${context} 必须是组件所有者`);
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
  throw new Error(`${context} 不是受支持的组件所有者`);
}

function parseCheckEnvironmentNeed(
  value: unknown,
  context: string,
): CheckEnvironmentNeed {
  if (!isRecord(value)) {
    throw new Error(`${context} 必须是检查环境需求`);
  }
  switch (value.kind) {
    case "playwright-browser-assets": {
      assertExactKeys(value, ["kind", "browser", "owner"], context);
      if (value.browser !== "chromium") {
        throw new Error(`${context}.browser 必须是 chromium`);
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
        throw new Error(`${context}.toolchain 必须是 stable`);
      }
      return {
        kind: value.kind,
        owner: parseComponentOwner(value.owner, `${context}.owner`),
        toolchain: value.toolchain,
      };
    }
    default:
      throw new Error(`${context} 含有不支持的 kind：${String(value.kind)}`);
  }
}

function parseDeploymentEnvironmentNeed(
  value: unknown,
  context: string,
): DeploymentEnvironmentNeed {
  if (!isRecord(value)) {
    throw new Error(`${context} 必须是部署环境需求`);
  }
  assertExactKeys(value, ["kind"], context);
  if (value.kind !== "docker-engine") {
    throw new Error(`${context} 含有不支持的 kind：${String(value.kind)}`);
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
      throw new Error(`检查环境需求 ${conflictKey} 的语义参数冲突`);
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

/** 校验、去重并按固定顺序排列持久化环境需求。 */
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

/** 严格解析加包流程消费的本地模板元数据。 */
export function parseEnvironmentNeedsMetadata(
  value: unknown,
): EnvironmentNeedsMetadata {
  if (!isRecord(value)) {
    throw new Error("环境需求元数据必须是对象");
  }
  assertExactKeys(value, ["schemaVersion", "check", "deployment"], "$");
  if (value.schemaVersion !== 1) {
    throw new Error(
      `不支持环境需求元数据 schemaVersion ${String(value.schemaVersion)}；预期为 1`,
    );
  }
  if (!Array.isArray(value.check)) {
    throw new Error("$.check 必须是数组");
  }
  if (!Array.isArray(value.deployment)) {
    throw new Error("$.deployment 必须是数组");
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

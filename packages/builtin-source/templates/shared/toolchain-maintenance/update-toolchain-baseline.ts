#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Baseline = {
  readonly nodeLtsMajor: string;
  readonly packageManagerPin: `pnpm@${string}`;
};

export type Candidate = {
  readonly pullRequest:
    | { readonly kind: "absent" }
    | { readonly kind: "open"; readonly pullRequestNumber: number };
  readonly remoteBranch:
    | { readonly kind: "absent" }
    | { readonly kind: "present"; readonly sha: string };
};

export type Plan =
  | { readonly kind: "no-drift" }
  | {
      readonly kind: "cleanup-stale";
      readonly pullRequestNumber?: number;
      readonly deleteBranch: true;
    }
  | {
      readonly kind: "update";
      readonly mode: "create";
      readonly desired: Baseline;
    }
  | {
      readonly kind: "update";
      readonly mode: "replace";
      readonly pullRequestNumber: number;
      readonly desired: Baseline;
    };

type NodeRelease = { readonly version: string; readonly lts: string | boolean };
type PnpmMetadata = {
  readonly versions: Record<
    string,
    { readonly engines?: { readonly node?: string } }
  >;
  readonly time: Record<string, string>;
};

const automationBranch = "automation/toolchain-baseline";
const maturityMilliseconds = 24 * 60 * 60 * 1_000;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export type GithubEffects = {
  readonly findPullRequests: (options: {
    readonly owner: string;
    readonly branch: string;
    readonly base: string;
  }) => Promise<readonly number[]>;
  readonly closePullRequest: (number: number, comment: string) => Promise<void>;
  readonly createPullRequest: (options: {
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<void>;
  readonly updatePullRequest: (
    number: number,
    options: { readonly title: string; readonly body: string },
  ) => Promise<void>;
};

export type MaintenanceHooks = {
  readonly installPackageManager?: (baseline: Baseline) => Promise<void>;
  readonly updateLockfile?: (baseline: Baseline) => Promise<void>;
  readonly prepareChecks?: (baseline: Baseline) => Promise<void>;
  readonly runChecks?: (baseline: Baseline) => Promise<void>;
  readonly beforePush?: () => Promise<void>;
};

export function planToolchainBaselineUpdate(options: {
  readonly current: Baseline & { readonly materialConsistent?: boolean };
  readonly desired: Baseline;
  readonly candidate: Candidate;
}): Plan {
  const drift =
    options.current.materialConsistent === false ||
    options.current.nodeLtsMajor !== options.desired.nodeLtsMajor ||
    options.current.packageManagerPin !== options.desired.packageManagerPin;

  if (!drift) {
    return options.candidate.pullRequest.kind === "absent" &&
      options.candidate.remoteBranch.kind === "absent"
      ? { kind: "no-drift" }
      : {
          kind: "cleanup-stale",
          ...(options.candidate.pullRequest.kind === "open"
            ? {
                pullRequestNumber:
                  options.candidate.pullRequest.pullRequestNumber,
              }
            : {}),
          deleteBranch: true,
        };
  }

  return options.candidate.pullRequest.kind === "open"
    ? {
        kind: "update",
        mode: "replace",
        pullRequestNumber: options.candidate.pullRequest.pullRequestNumber,
        desired: options.desired,
      }
    : { kind: "update", mode: "create", desired: options.desired };
}

export async function resolveToolchainBaseline(
  nodeInput: unknown,
  pnpmInput: unknown,
  now: Date,
): Promise<Baseline> {
  const { compare, satisfies, valid } = await import("semver");
  if (!Array.isArray(nodeInput)) {
    throw new Error("Node release index was not an array");
  }
  const releases = nodeInput.map((entry): NodeRelease => {
    if (!isRecord(entry) || typeof entry.version !== "string") {
      throw new Error("Node release entry is missing version");
    }
    if (typeof entry.lts !== "string" && typeof entry.lts !== "boolean") {
      throw new Error("Node release entry is missing LTS state");
    }
    return { version: entry.version, lts: entry.lts };
  });
  if (
    !isRecord(pnpmInput) ||
    !isRecord(pnpmInput.versions) ||
    !isRecord(pnpmInput.time)
  ) {
    throw new Error("pnpm metadata is missing versions or publication times");
  }
  const pnpmMetadata = pnpmInput as PnpmMetadata;
  const ltsVersions = releases
    .filter((release) => release.lts !== false)
    .map((release) => release.version.replace(/^v/, ""))
    .filter((version) => valid(version) !== null)
    .toSorted(compare);
  const nodeVersion = ltsVersions.at(-1);
  if (nodeVersion === undefined) {
    throw new Error("Node release index contains no LTS release");
  }
  const nodeLtsMajor = nodeVersion.split(".")[0]!;
  const maturityCutoff = now.getTime() - maturityMilliseconds;
  const pnpmVersion = Object.entries(pnpmMetadata.versions)
    .filter(([version, metadata]) => {
      if (!/^\d+\.\d+\.\d+$/.test(version) || valid(version) === null)
        return false;
      const publishedAt = Date.parse(pnpmMetadata.time[version] ?? "");
      return (
        Number.isFinite(publishedAt) &&
        publishedAt <= maturityCutoff &&
        satisfies(nodeVersion, metadata.engines?.node ?? "*")
      );
    })
    .map(([version]) => version)
    .toSorted(compare)
    .at(-1);
  if (pnpmVersion === undefined) {
    throw new Error("pnpm metadata contains no mature Node-compatible release");
  }
  return { nodeLtsMajor, packageManagerPin: `pnpm@${pnpmVersion}` };
}

async function resolveOfficialBaseline(): Promise<Baseline> {
  const [nodeResponse, pnpmResponse] = await Promise.all([
    fetch("https://nodejs.org/dist/index.json"),
    fetch("https://registry.npmjs.org/pnpm"),
  ]);
  if (!nodeResponse.ok || !pnpmResponse.ok) {
    throw new Error(
      `Official toolchain metadata request failed: Node ${nodeResponse.status}, pnpm ${pnpmResponse.status}`,
    );
  }
  return await resolveToolchainBaseline(
    await nodeResponse.json(),
    await pnpmResponse.json(),
    new Date(),
  );
}

export async function readCurrentBaseline(
  rootDirectory: string,
): Promise<Baseline & { readonly materialConsistent: boolean }> {
  const manifest = JSON.parse(
    await readFile(path.join(rootDirectory, "package.json"), "utf8"),
  ) as { engines?: { node?: string }; packageManager?: string };
  const nodeLtsMajor = manifest.engines?.node?.match(
    /^(?:>=)?(\d+)(?:\.0\.0)?$/,
  )?.[1];
  if (
    !nodeLtsMajor ||
    !manifest.packageManager?.match(/^pnpm@\d+\.\d+\.\d+$/)
  ) {
    throw new Error("Repository Toolchain Baseline is malformed");
  }
  let materialConsistent = true;
  for (const manifestPath of await packageManifestPaths(rootDirectory)) {
    const packageManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as { engines?: { node?: string }; packageManager?: string };
    if (
      packageManifest.engines?.node !== undefined &&
      packageManifest.engines.node !== nodeLtsMajor
    ) {
      materialConsistent = false;
    }
    if (
      packageManifest.packageManager !== undefined &&
      packageManifest.packageManager !== manifest.packageManager
    ) {
      materialConsistent = false;
    }
  }
  materialConsistent &&= await jsonBaselineMatches(
    rootDirectory,
    ".devcontainer/devcontainer.json",
    (value) => {
      const root = requireRecord(value, ".devcontainer/devcontainer.json");
      const build = requireRecord(
        root.build,
        ".devcontainer/devcontainer.json: build",
      );
      const args = requireRecord(
        build.args,
        ".devcontainer/devcontainer.json: build.args",
      );
      return (
        args.NODE_VERSION === nodeLtsMajor &&
        args.PACKAGE_MANAGER_PIN === manifest.packageManager
      );
    },
  );
  materialConsistent &&= await jsonBaselineMatches(
    rootDirectory,
    ".template/generated-by.json",
    (value) => {
      const root = requireRecord(value, ".template/generated-by.json");
      const toolchain = requireRecord(
        root.toolchain,
        ".template/generated-by.json: toolchain",
      );
      return (
        toolchain.nodeLtsMajor === nodeLtsMajor &&
        toolchain.packageManagerPin === manifest.packageManager
      );
    },
  );
  const dockerfilePath = path.join(rootDirectory, "apps/web/Dockerfile");
  try {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const nodeImages = dockerfile.match(/^FROM node:[^\s]+/gm) ?? [];
    const pins = dockerfile.match(/^ARG PACKAGE_MANAGER_PIN=.*$/gm) ?? [];
    materialConsistent &&=
      nodeImages.length > 0 &&
      nodeImages.every((image) =>
        image.startsWith(`FROM node:${nodeLtsMajor}-`),
      ) &&
      pins.length === 1 &&
      pins[0] === `ARG PACKAGE_MANAGER_PIN="${manifest.packageManager}"`;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }

  return {
    nodeLtsMajor,
    packageManagerPin: manifest.packageManager as `pnpm@${string}`,
    materialConsistent,
  };
}

async function jsonBaselineMatches(
  rootDirectory: string,
  relativePath: string,
  matches: (value: unknown) => boolean,
): Promise<boolean> {
  try {
    return matches(
      JSON.parse(
        await readFile(path.join(rootDirectory, relativePath), "utf8"),
      ) as unknown,
    );
  } catch (error: unknown) {
    if (isMissing(error)) return true;
    throw error;
  }
}

async function command(
  commandName: string,
  arguments_: readonly string[],
  rootDirectory = repositoryRoot,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, [...arguments_], {
      cwd: rootDirectory,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve(stdout.trim());
      else reject(new Error(`${commandName} exited with ${String(exitCode)}`));
    });
  });
}

async function findCandidate(
  rootDirectory: string,
  defaultBranch: string,
  owner: string,
  github: GithubEffects,
): Promise<Candidate> {
  const pulls = await github.findPullRequests({
    owner,
    branch: automationBranch,
    base: defaultBranch,
  });
  if (pulls.length > 1)
    throw new Error("More than one toolchain candidate is open");
  const remote = await command(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${automationBranch}`],
    rootDirectory,
  );
  const sha = remote.split(/\s+/)[0] ?? "";
  return {
    pullRequest:
      pulls[0] !== undefined
        ? { kind: "open", pullRequestNumber: pulls[0] }
        : { kind: "absent" },
    remoteBranch: sha ? { kind: "present", sha } : { kind: "absent" },
  };
}

async function packageManifestPaths(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        [".git", "node_modules", "dist"].includes(entry.name)
      )
        continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.name === "package.json") results.push(entryPath);
    }
  }
  await visit(root);
  return results;
}

export function checkEnvironmentNeedsForPackageManifests(
  manifests: readonly unknown[],
): readonly "shellcheck"[] {
  const needsShellCheck = manifests.some((value) => {
    if (!isRecord(value) || !isRecord(value.scripts)) return false;
    return Object.values(value.scripts).some(
      (script) =>
        typeof script === "string" && /(^|\s|&&)shellcheck\s/u.test(script),
    );
  });

  return needsShellCheck ? ["shellcheck"] : [];
}

async function prepareCheckEnvironment(
  rootDirectory: string,
  baseline: Baseline,
): Promise<void> {
  const manifestPaths = await packageManifestPaths(rootDirectory);
  const manifests = await Promise.all(
    manifestPaths.map(async (manifestPath) =>
      JSON.parse(await readFile(manifestPath, "utf8")),
    ),
  );
  if (
    checkEnvironmentNeedsForPackageManifests(manifests).includes("shellcheck")
  ) {
    await command("sudo", ["apt-get", "update"], rootDirectory);
    await command(
      "sudo",
      ["apt-get", "install", "-y", "shellcheck"],
      rootDirectory,
    );
  }

  for (const [index, manifestPath] of manifestPaths.entries()) {
    const manifest = manifests[index] as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (
      manifest.dependencies?.["@playwright/test"] === undefined &&
      manifest.devDependencies?.["@playwright/test"] === undefined
    ) {
      continue;
    }
    await command(
      "corepack",
      [
        baseline.packageManagerPin,
        "--dir",
        path.dirname(manifestPath),
        "exec",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
      ],
      rootDirectory,
    );
  }
}

export async function updateToolchainBaselineMaterials(
  rootDirectory: string,
  baseline: Baseline,
): Promise<void> {
  for (const manifestPath of await packageManifestPaths(rootDirectory)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    > & {
      engines?: Record<string, string>;
      packageManager?: string;
    };
    if (manifest.engines !== undefined && !isRecord(manifest.engines)) {
      throw new Error(
        `${path.relative(rootDirectory, manifestPath)}: engines must be an object`,
      );
    }
    if (
      manifest.engines?.node !== undefined &&
      typeof manifest.engines.node !== "string"
    ) {
      throw new Error(
        `${path.relative(rootDirectory, manifestPath)}: engines.node must be a string`,
      );
    }
    if (
      manifest.packageManager !== undefined &&
      typeof manifest.packageManager !== "string"
    ) {
      throw new Error(
        `${path.relative(rootDirectory, manifestPath)}: packageManager must be a string`,
      );
    }
    if (manifest.engines?.node !== undefined)
      manifest.engines.node = baseline.nodeLtsMajor;
    if (
      manifestPath === path.join(rootDirectory, "package.json") ||
      manifest.packageManager !== undefined
    ) {
      manifest.packageManager = baseline.packageManagerPin;
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await updateJsonIfPresent(
    rootDirectory,
    ".devcontainer/devcontainer.json",
    (value) => {
      const root = requireRecord(value, ".devcontainer/devcontainer.json");
      const build = requireRecord(
        root.build,
        ".devcontainer/devcontainer.json: build",
      );
      const args = requireRecord(
        build.args,
        ".devcontainer/devcontainer.json: build.args",
      );
      if (
        typeof args.NODE_VERSION !== "string" ||
        typeof args.PACKAGE_MANAGER_PIN !== "string"
      )
        throw new Error(
          ".devcontainer/devcontainer.json: baseline build args are malformed",
        );
      args.NODE_VERSION = baseline.nodeLtsMajor;
      args.PACKAGE_MANAGER_PIN = baseline.packageManagerPin;
    },
  );
  await updateJsonIfPresent(
    rootDirectory,
    ".template/generated-by.json",
    (value) => {
      const root = requireRecord(value, ".template/generated-by.json");
      const toolchain = requireRecord(
        root.toolchain,
        ".template/generated-by.json: toolchain",
      );
      if (
        typeof toolchain.nodeLtsMajor !== "string" ||
        typeof toolchain.packageManagerPin !== "string"
      )
        throw new Error(
          ".template/generated-by.json: toolchain baseline is malformed",
        );
      toolchain.nodeLtsMajor = baseline.nodeLtsMajor;
      toolchain.packageManagerPin = baseline.packageManagerPin;
    },
  );
  const dockerfilePath = path.join(rootDirectory, "apps/web/Dockerfile");
  try {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const nodeImages = dockerfile.match(/FROM node:\d+-/g) ?? [];
    const allNodeImages = dockerfile.match(/^FROM node:[^\s]+/gm) ?? [];
    const packageManagerPins =
      dockerfile.match(/ARG PACKAGE_MANAGER_PIN="pnpm@[^"]+"/g) ?? [];
    if (
      nodeImages.length === 0 ||
      nodeImages.length !== allNodeImages.length ||
      packageManagerPins.length !== 1
    )
      throw new Error(
        "apps/web/Dockerfile: expected Node image and exactly one Package Manager Pin",
      );
    await writeFile(
      dockerfilePath,
      dockerfile
        .replaceAll(/FROM node:\d+-/g, `FROM node:${baseline.nodeLtsMajor}-`)
        .replace(
          /ARG PACKAGE_MANAGER_PIN="pnpm@[^"]+"/,
          `ARG PACKAGE_MANAGER_PIN="${baseline.packageManagerPin}"`,
        ),
    );
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function updateJsonIfPresent(
  rootDirectory: string,
  relativePath: string,
  update: (value: unknown) => void,
): Promise<void> {
  const filePath = path.join(rootDirectory, relativePath);
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    update(value);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function applyPlan(
  rootDirectory: string,
  plan: Plan,
  candidate: Candidate,
  defaultBranch: string,
  owner: string,
  github: GithubEffects,
  hooks: MaintenanceHooks,
): Promise<void> {
  if (plan.kind === "no-drift") return;
  if (plan.kind === "cleanup-stale") {
    const latest = await findCandidate(
      rootDirectory,
      defaultBranch,
      owner,
      github,
    );
    if (JSON.stringify(latest) !== JSON.stringify(candidate))
      throw new Error(
        "Toolchain candidate changed before cleanup; refusing stale cleanup",
      );
    if (candidate.remoteBranch.kind === "present") {
      await command(
        "git",
        [
          "push",
          `--force-with-lease=refs/heads/${automationBranch}:${candidate.remoteBranch.sha}`,
          "origin",
          `:refs/heads/${automationBranch}`,
        ],
        rootDirectory,
      );
    }
    if (plan.pullRequestNumber !== undefined) {
      await github.closePullRequest(
        plan.pullRequestNumber,
        "Closing because the default branch no longer has Toolchain Baseline drift.",
      );
    }
    return;
  }
  await updateToolchainBaselineMaterials(rootDirectory, plan.desired);
  const consistent = await readCurrentBaseline(rootDirectory);
  if (
    !consistent.materialConsistent ||
    consistent.nodeLtsMajor !== plan.desired.nodeLtsMajor ||
    consistent.packageManagerPin !== plan.desired.packageManagerPin
  )
    throw new Error(
      "Toolchain Baseline materials remained inconsistent after update",
    );
  await (hooks.installPackageManager?.(plan.desired) ??
    command(
      "corepack",
      ["install", "--global", plan.desired.packageManagerPin],
      rootDirectory,
    ));
  await (hooks.updateLockfile?.(plan.desired) ??
    command(
      "corepack",
      [plan.desired.packageManagerPin, "install", "--lockfile-only"],
      rootDirectory,
    ));
  await (hooks.prepareChecks?.(plan.desired) ??
    prepareCheckEnvironment(rootDirectory, plan.desired));
  await (hooks.runChecks?.(plan.desired) ??
    command(
      "corepack",
      [plan.desired.packageManagerPin, "run", "check"],
      rootDirectory,
    ));
  await command(
    "git",
    ["config", "user.name", "github-actions[bot]"],
    rootDirectory,
  );
  await command(
    "git",
    [
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ],
    rootDirectory,
  );
  await command("git", ["add", "-A"], rootDirectory);
  await command(
    "git",
    ["commit", "-m", "chore: update toolchain baseline"],
    rootDirectory,
  );
  await hooks.beforePush?.();
  await command("git", ["fetch", "origin", defaultBranch], rootDirectory);
  const latestDefaultSha = await command(
    "git",
    ["rev-parse", `origin/${defaultBranch}`],
    rootDirectory,
  );
  const baseSha = await command("git", ["rev-parse", "HEAD^"], rootDirectory);
  if (latestDefaultSha !== baseSha)
    throw new Error(
      "Default branch advanced while preparing Toolchain Baseline candidate",
    );
  const latestCandidate = await findCandidate(
    rootDirectory,
    defaultBranch,
    owner,
    github,
  );
  if (JSON.stringify(latestCandidate) !== JSON.stringify(candidate))
    throw new Error(
      "Toolchain candidate changed while checks ran; refusing stale push",
    );
  const lease =
    candidate.remoteBranch.kind === "present" ? candidate.remoteBranch.sha : "";
  await command(
    "git",
    [
      "push",
      `--force-with-lease=refs/heads/${automationBranch}:${lease}`,
      "origin",
      `HEAD:refs/heads/${automationBranch}`,
    ],
    rootDirectory,
  );
  const body =
    "Updates the Node LTS and mature compatible pnpm baselines together. This automation never auto-merges.";
  if (plan.mode === "create") {
    await github.createPullRequest({
      base: defaultBranch,
      head: automationBranch,
      title: "chore: update toolchain baseline",
      body,
    });
  } else {
    await github.updatePullRequest(plan.pullRequestNumber, {
      title: "chore: update toolchain baseline",
      body,
    });
  }
}

export async function runToolchainBaselineMaintenance(options: {
  readonly rootDirectory: string;
  readonly desired: Baseline;
  readonly defaultBranch: string;
  readonly owner: string;
  readonly github: GithubEffects;
  readonly hooks?: MaintenanceHooks;
}): Promise<void> {
  const rootDirectory = path.resolve(options.rootDirectory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await command(
      "git",
      ["fetch", "origin", options.defaultBranch],
      rootDirectory,
    );
    await command(
      "git",
      ["checkout", "-B", automationBranch, `origin/${options.defaultBranch}`],
      rootDirectory,
    );
    const [current, candidate] = await Promise.all([
      readCurrentBaseline(rootDirectory),
      findCandidate(
        rootDirectory,
        options.defaultBranch,
        options.owner,
        options.github,
      ),
    ]);
    try {
      await applyPlan(
        rootDirectory,
        planToolchainBaselineUpdate({
          current,
          desired: options.desired,
          candidate,
        }),
        candidate,
        options.defaultBranch,
        options.owner,
        options.github,
        options.hooks ?? {},
      );
      return;
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        error.message !==
          "Default branch advanced while preparing Toolchain Baseline candidate" ||
        attempt === 1
      )
        throw error;
    }
  }
}

const cliGithubEffects: GithubEffects = {
  async findPullRequests({ owner, branch, base }) {
    const pulls = JSON.parse(
      await command("gh", [
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        `${owner}:${branch}`,
        "--base",
        base,
        "--json",
        "number",
        "--limit",
        "2",
      ]),
    ) as Array<{ number: number }>;
    return pulls.map(({ number }) => number);
  },
  async closePullRequest(number, comment) {
    await command("gh", ["pr", "close", String(number), "--comment", comment]);
  },
  async createPullRequest({ base, head, title, body }) {
    await command("gh", [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      head,
      "--title",
      title,
      "--body",
      body,
    ]);
  },
  async updatePullRequest(number, { title, body }) {
    await command("gh", [
      "pr",
      "edit",
      String(number),
      "--title",
      title,
      "--body",
      body,
    ]);
  },
};

async function main(): Promise<void> {
  const fixtureIndex = process.argv.indexOf("--plan-fixture");
  if (fixtureIndex !== -1) {
    const fixturePath = process.argv[fixtureIndex + 1];
    if (!fixturePath) throw new Error("--plan-fixture requires a JSON path");
    const fixture = JSON.parse(
      await readFile(path.resolve(fixturePath), "utf8"),
    ) as {
      current: Baseline;
      desired: Baseline;
      candidate: Candidate;
    };
    console.log(JSON.stringify(planToolchainBaselineUpdate(fixture)));
    return;
  }
  const desired = await resolveOfficialBaseline();
  if (process.argv.includes("--print-workflow-outputs")) {
    console.log(`node-major=${desired.nodeLtsMajor}`);
    console.log(`pnpm-pin=${desired.packageManagerPin}`);
    return;
  }
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "main";
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "";
  if (!owner) throw new Error("GITHUB_REPOSITORY_OWNER is required");
  await runToolchainBaselineMaintenance({
    rootDirectory: repositoryRoot,
    desired,
    defaultBranch,
    owner,
    github: cliGithubEffects,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

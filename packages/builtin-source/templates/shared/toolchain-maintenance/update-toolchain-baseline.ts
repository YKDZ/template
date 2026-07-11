#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Baseline = {
  readonly nodeLtsMajor: string;
  readonly packageManagerPin: `pnpm@${string}`;
};

type Candidate = {
  readonly pullRequest:
    | { readonly kind: "absent" }
    | { readonly kind: "open"; readonly pullRequestNumber: number };
  readonly remoteBranch:
    | { readonly kind: "absent" }
    | { readonly kind: "present"; readonly sha: string };
};

type Plan =
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

async function readCurrentBaseline(): Promise<
  Baseline & { readonly materialConsistent: boolean }
> {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
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
  for (const manifestPath of await packageManifestPaths(repositoryRoot)) {
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
    ".devcontainer/devcontainer.json",
    (value) => {
      const root = value as { build?: { args?: Record<string, string> } };
      return (
        root.build?.args?.NODE_VERSION === nodeLtsMajor &&
        root.build.args.PACKAGE_MANAGER_PIN === manifest.packageManager
      );
    },
  );
  materialConsistent &&= await jsonBaselineMatches(
    ".template/generated-by.json",
    (value) => {
      const root = value as { toolchain?: Record<string, string> };
      return (
        root.toolchain?.nodeLtsMajor === nodeLtsMajor &&
        root.toolchain.packageManagerPin === manifest.packageManager
      );
    },
  );
  const dockerfilePath = path.join(repositoryRoot, "apps/web/Dockerfile");
  try {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    materialConsistent &&=
      dockerfile.includes(`FROM node:${nodeLtsMajor}-`) &&
      dockerfile.includes(
        `ARG PACKAGE_MANAGER_PIN="${manifest.packageManager}"`,
      );
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
  relativePath: string,
  matches: (value: unknown) => boolean,
): Promise<boolean> {
  try {
    return matches(
      JSON.parse(
        await readFile(path.join(repositoryRoot, relativePath), "utf8"),
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, [...arguments_], {
      cwd: repositoryRoot,
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
  defaultBranch: string,
  owner: string,
): Promise<Candidate> {
  const pulls = JSON.parse(
    await command("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      `${owner}:${automationBranch}`,
      "--base",
      defaultBranch,
      "--json",
      "number",
      "--limit",
      "2",
    ]),
  ) as Array<{ number: number }>;
  if (pulls.length > 1)
    throw new Error("More than one toolchain candidate is open");
  const remote = await command("git", [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${automationBranch}`,
  ]);
  const sha = remote.split(/\s+/)[0] ?? "";
  return {
    pullRequest: pulls[0]
      ? { kind: "open", pullRequestNumber: pulls[0].number }
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

async function prepareCheckEnvironment(baseline: Baseline): Promise<void> {
  for (const manifestPath of await packageManifestPaths(repositoryRoot)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (
      manifest.dependencies?.["@playwright/test"] === undefined &&
      manifest.devDependencies?.["@playwright/test"] === undefined
    ) {
      continue;
    }
    await command("corepack", [
      baseline.packageManagerPin,
      "--dir",
      path.dirname(manifestPath),
      "exec",
      "playwright",
      "install",
      "--with-deps",
      "chromium",
    ]);
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
      const root = value as { build?: { args?: Record<string, string> } };
      if (root.build?.args) {
        root.build.args.NODE_VERSION = baseline.nodeLtsMajor;
        root.build.args.PACKAGE_MANAGER_PIN = baseline.packageManagerPin;
      }
    },
  );
  await updateJsonIfPresent(
    rootDirectory,
    ".template/generated-by.json",
    (value) => {
      const root = value as { toolchain?: Record<string, string> };
      if (root.toolchain) {
        root.toolchain.nodeLtsMajor = baseline.nodeLtsMajor;
        root.toolchain.packageManagerPin = baseline.packageManagerPin;
      }
    },
  );
  const dockerfilePath = path.join(rootDirectory, "apps/web/Dockerfile");
  try {
    const dockerfile = await readFile(dockerfilePath, "utf8");
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
  plan: Plan,
  candidate: Candidate,
  defaultBranch: string,
): Promise<void> {
  if (plan.kind === "no-drift") return;
  if (plan.kind === "cleanup-stale") {
    if (plan.pullRequestNumber !== undefined) {
      await command("gh", [
        "pr",
        "close",
        String(plan.pullRequestNumber),
        "--comment",
        "Closing because the default branch no longer has Toolchain Baseline drift.",
      ]);
    }
    if (candidate.remoteBranch.kind === "present") {
      await command("git", [
        "push",
        `--force-with-lease=refs/heads/${automationBranch}:${candidate.remoteBranch.sha}`,
        "origin",
        `:refs/heads/${automationBranch}`,
      ]);
    }
    return;
  }
  await command("git", ["fetch", "origin", defaultBranch]);
  await command("git", [
    "checkout",
    "-B",
    automationBranch,
    `origin/${defaultBranch}`,
  ]);
  await updateToolchainBaselineMaterials(repositoryRoot, plan.desired);
  await command("corepack", [
    "install",
    "--global",
    plan.desired.packageManagerPin,
  ]);
  await command("corepack", [
    plan.desired.packageManagerPin,
    "install",
    "--lockfile-only",
  ]);
  await prepareCheckEnvironment(plan.desired);
  await command("corepack", [plan.desired.packageManagerPin, "run", "check"]);
  await command("git", ["config", "user.name", "github-actions[bot]"]);
  await command("git", [
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  await command("git", ["add", "-A"]);
  await command("git", ["commit", "-m", "chore: update toolchain baseline"]);
  const lease =
    candidate.remoteBranch.kind === "present" ? candidate.remoteBranch.sha : "";
  await command("git", [
    "push",
    `--force-with-lease=refs/heads/${automationBranch}:${lease}`,
    "origin",
    `HEAD:refs/heads/${automationBranch}`,
  ]);
  const body =
    "Updates the Node LTS and mature compatible pnpm baselines together. This automation never auto-merges.";
  if (plan.mode === "create") {
    await command("gh", [
      "pr",
      "create",
      "--base",
      defaultBranch,
      "--head",
      automationBranch,
      "--title",
      "chore: update toolchain baseline",
      "--body",
      body,
    ]);
  } else {
    await command("gh", [
      "pr",
      "edit",
      String(plan.pullRequestNumber),
      "--title",
      "chore: update toolchain baseline",
      "--body",
      body,
    ]);
  }
}

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
  const [current, candidate] = await Promise.all([
    readCurrentBaseline(),
    findCandidate(defaultBranch, owner),
  ]);
  await applyPlan(
    planToolchainBaselineUpdate({ current, desired, candidate }),
    candidate,
    defaultBranch,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

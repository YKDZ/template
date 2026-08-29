import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validRange } from "semver";
import { list } from "tar";

import {
  inspectNpmPublicationReadiness,
  type NpmPublicationReadiness,
} from "./readiness.ts";

type JsonObject = Record<string, unknown>;

export type PublicationArtifactFailureCode =
  | "artifact-output-invalid"
  | "artifact-temporary-output-failed"
  | "artifact-pack-failed"
  | "artifact-pack-output-invalid"
  | "artifact-archive-unsafe"
  | "artifact-manifest-invalid"
  | "artifact-manifest-contract"
  | "artifact-files-contract"
  | "artifact-bin-contract"
  | "consumer-install-failed"
  | "consumer-smoke-failed"
  | "artifact-receipt-failed"
  | "artifact-cleanup-failed";

export type PublicationArtifactFailure = {
  readonly code: PublicationArtifactFailureCode;
  readonly observed: string;
  readonly expected: string;
  readonly nextAction: string;
  readonly command?: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly exitCode: number;
  };
};

export type VerifiedPublicationArtifactReceipt = {
  readonly schemaVersion: 1;
  readonly artifact: {
    readonly file: string;
    readonly checksumFile: "SHA512SUMS";
    readonly size: number;
    readonly integrity: string;
  };
  readonly publication: {
    readonly packageName: string;
    readonly version: string;
    readonly commandName: string;
    readonly repository: string;
    readonly releaseDate: string;
    readonly releaseNotes: string;
  };
  readonly packedManifest: Readonly<JsonObject>;
  readonly files: readonly {
    readonly path: string;
    readonly mode: number;
    readonly size: number;
  }[];
  readonly bin: {
    readonly path: "package/dist/cli.js";
    readonly shebang: "#!/usr/bin/env node";
    readonly mode: number;
    readonly posixExecutableChecked: boolean;
  };
  readonly smokes: readonly [
    {
      readonly name: "runtime-import";
      readonly args: readonly [];
      readonly stdout: "";
    },
    {
      readonly name: "help";
      readonly args: readonly ["--help"];
      readonly stdout: string;
    },
    {
      readonly name: "version";
      readonly args: readonly ["--version"];
      readonly stdout: string;
    },
    {
      readonly name: "greet";
      readonly args: readonly ["greet", "  Ada Lovelace  "];
      readonly stdout: string;
    },
  ];
};

export type VerifiedPublicationArtifactResult =
  | {
      readonly kind: "blocked";
      readonly readiness: Extract<
        NpmPublicationReadiness,
        { readonly kind: "blocked" }
      >;
    }
  | { readonly kind: "failed"; readonly failure: PublicationArtifactFailure }
  | {
      readonly kind: "verified";
      readonly artifactPath: string;
      readonly checksumPath: string;
      readonly receiptPath: string;
      readonly receipt: VerifiedPublicationArtifactReceipt;
    };

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ArchiveFile = {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly body?: Buffer;
};

type ArchiveInspection = {
  readonly files: readonly ArchiveFile[];
  readonly manifest: JsonObject;
  readonly cliSource: Buffer;
};

const expectedFiles = [
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli-command-identity.js",
  "package/dist/cli.js",
  "package/dist/main.js",
  "package/package.json",
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: unknown): string {
  return String(value)
    .replaceAll(/\s*\r?\n\s*/gu, " ")
    .slice(0, 1_000);
}

function failure(
  code: PublicationArtifactFailureCode,
  observed: unknown,
  expected: string,
  nextAction: string,
  command?: PublicationArtifactFailure["command"],
): PublicationArtifactFailure {
  return {
    code,
    observed: oneLine(observed),
    expected,
    nextAction,
    ...(command === undefined ? {} : { command }),
  };
}

function commandFailure(
  code:
    | "artifact-pack-failed"
    | "consumer-install-failed"
    | "consumer-smoke-failed",
  executable: string,
  args: readonly string[],
  result: CommandResult,
  expected: string,
  nextAction: string,
): PublicationArtifactFailure {
  return failure(
    code,
    `${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    expected,
    nextAction,
    { executable, args, exitCode: result.exitCode },
  );
}

function runCommand(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function validateOutputDirectory(options: {
  readonly repositoryRoot: string;
  readonly packageRoot: string;
  readonly outputDirectory: string;
}): Promise<PublicationArtifactFailure | undefined> {
  try {
    const output = await stat(options.outputDirectory);
    if (!output.isDirectory())
      throw new Error("output path is not a directory");
    if ((await readdir(options.outputDirectory)).length !== 0) {
      throw new Error("output directory is not empty");
    }
    if (
      pathContains(options.repositoryRoot, options.outputDirectory) ||
      pathContains(options.outputDirectory, options.repositoryRoot) ||
      pathContains(options.packageRoot, options.outputDirectory) ||
      pathContains(options.outputDirectory, options.packageRoot)
    ) {
      throw new Error("output directory overlaps the repository or package");
    }
    return undefined;
  } catch (error) {
    return failure(
      "artifact-output-invalid",
      error instanceof Error ? error.message : error,
      "An existing empty output directory outside the repository and package",
      "Create a new isolated output directory and retry.",
    );
  }
}

function validArchivePath(entryPath: string): boolean {
  if (
    entryPath.includes("\0") ||
    entryPath.includes("\\") ||
    entryPath.startsWith("/") ||
    !entryPath.startsWith("package/")
  ) {
    return false;
  }
  const canonicalPath = entryPath.endsWith("/")
    ? entryPath.slice(0, -1)
    : entryPath;
  const segments = canonicalPath.split("/");
  return !segments.some(
    (segment) => segment === "" || segment === "." || segment === "..",
  );
}

function archivePathIdentity(entryPath: string): string {
  return entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
}

/** @internal Pure archive seam used by the verifier's focused negative tests. */
export async function inspectPublicationArchive(
  archivePath: string,
): Promise<ArchiveInspection | PublicationArtifactFailure> {
  const files: ArchiveFile[] = [];
  const paths = new Set<string>();
  let unsafe: string | undefined;
  const bodyReads: Promise<void>[] = [];
  try {
    await list({
      file: archivePath,
      onentry(entry) {
        const entryPath = entry.path;
        const pathIdentity = archivePathIdentity(entryPath);
        if (!validArchivePath(entryPath) || paths.has(pathIdentity)) {
          unsafe ??= `unsafe or duplicate path ${JSON.stringify(entryPath)}`;
          entry.resume();
          return;
        }
        paths.add(pathIdentity);
        const entryType = entry.type;
        if (entryType === "Directory") {
          const directory = archivePathIdentity(entryPath);
          if (
            !expectedFiles.some((filePath) =>
              filePath.startsWith(`${directory}/`),
            )
          ) {
            unsafe ??= `unexpected directory ${JSON.stringify(entryPath)}`;
          }
          entry.resume();
          return;
        }
        if (entryType !== "File") {
          unsafe ??= `unsupported ${entryType} entry ${JSON.stringify(entryPath)}`;
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        const capture =
          entryPath === "package/package.json" ||
          entryPath === "package/dist/cli.js";
        entry.on("data", (chunk: Buffer | string) => {
          if (capture)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        bodyReads.push(
          new Promise((resolve, reject) => {
            entry.once("end", () => {
              files.push({
                path: entryPath,
                mode: entry.mode ?? 0,
                size: entry.size,
                ...(capture ? { body: Buffer.concat(chunks) } : {}),
              });
              resolve();
            });
            entry.once("error", reject);
          }),
        );
      },
    });
    await Promise.all(bodyReads);
  } catch (error) {
    return failure(
      "artifact-archive-unsafe",
      error instanceof Error ? error.message : error,
      "A readable gzip tar archive containing only safe package entries",
      "Correct the package contents and run artifact verification again.",
    );
  }
  if (unsafe !== undefined) {
    return failure(
      "artifact-archive-unsafe",
      unsafe,
      "Canonical package/ paths with only regular files and ancestor directories",
      "Remove unsafe archive entries and retry.",
    );
  }
  const sortedFiles = files.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const actualPaths = sortedFiles.map((item) => item.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedFiles)) {
    return failure(
      "artifact-files-contract",
      JSON.stringify(actualPaths),
      `Exactly ${JSON.stringify(expectedFiles)}`,
      "Correct the package files allow-list and compiled runtime outputs.",
    );
  }
  const manifestSource = sortedFiles.find(
    (item) => item.path === "package/package.json",
  )?.body;
  if (manifestSource === undefined) {
    return failure(
      "artifact-manifest-invalid",
      "package/package.json is missing or unreadable",
      "One UTF-8 JSON object at package/package.json",
      "Restore the package manifest and retry.",
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestSource),
    );
  } catch (error) {
    return failure(
      "artifact-manifest-invalid",
      error instanceof Error ? error.message : error,
      "A valid UTF-8 JSON object at package/package.json",
      "Correct the packed package manifest and retry.",
    );
  }
  if (!isObject(manifest)) {
    return failure(
      "artifact-manifest-invalid",
      JSON.stringify(manifest),
      "A JSON object at package/package.json",
      "Correct the packed package manifest and retry.",
    );
  }
  const cliSource = sortedFiles.find(
    (item) => item.path === "package/dist/cli.js",
  )?.body;
  if (cliSource === undefined) {
    return failure(
      "artifact-bin-contract",
      "package/dist/cli.js is missing",
      "A compiled JavaScript bin in the archive",
      "Restore the CLI build output and retry.",
    );
  }
  return { files: sortedFiles, manifest, cliSource };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
  );
}

/** @internal Pure packed-manifest seam used by focused contract tests. */
export function inspectPackedManifestContract(options: {
  readonly manifest: JsonObject;
  readonly sourceManifest: JsonObject;
  readonly readiness: Extract<
    NpmPublicationReadiness,
    { readonly kind: "ready" }
  >;
}): PublicationArtifactFailure | undefined {
  const { manifest, sourceManifest, readiness } = options;
  const bin = manifest.bin;
  const dependencies = manifest.dependencies;
  const files = manifest.files;
  const publishConfig = manifest.publishConfig;
  const forbidden = [
    "private",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "bundleDependencies",
    "main",
    "types",
    "typings",
    "exports",
    "imports",
    "packageManager",
    "pnpm",
    "provenance",
  ].filter((key) => Object.hasOwn(manifest, key));
  const exactIdentity =
    manifest.name === readiness.publication.packageName &&
    manifest.version === readiness.publication.version &&
    manifest.description === sourceManifest.description &&
    manifest.license === sourceManifest.license &&
    sameJson(manifest.repository, sourceManifest.repository) &&
    manifest.homepage === sourceManifest.homepage &&
    sameJson(manifest.bugs, sourceManifest.bugs) &&
    manifest.type === "module" &&
    sameJson(manifest.engines, sourceManifest.engines);
  const exactFiles =
    Array.isArray(files) &&
    files.length === 4 &&
    ["dist", "README.md", "LICENSE", "CHANGELOG.md"].every((item) =>
      files.includes(item),
    );
  const exactBin =
    isObject(bin) &&
    Object.keys(bin).length === 1 &&
    bin[readiness.publication.commandName] === "./dist/cli.js";
  const exactDependencies =
    isObject(dependencies) &&
    Object.keys(dependencies).length === 1 &&
    typeof dependencies.commander === "string" &&
    dependencies.commander.length > 0 &&
    validRange(dependencies.commander) !== null;
  const validPublishConfig =
    publishConfig === undefined ||
    (isObject(publishConfig) &&
      Object.keys(publishConfig).length === 2 &&
      publishConfig.access === "public" &&
      publishConfig.registry === "https://registry.npmjs.org/");
  if (
    !exactIdentity ||
    !exactFiles ||
    !exactBin ||
    !exactDependencies ||
    !validPublishConfig ||
    Object.hasOwn(manifest, "scripts") ||
    forbidden.length > 0
  ) {
    return failure(
      "artifact-manifest-contract",
      JSON.stringify({
        exactIdentity,
        exactFiles,
        exactBin,
        exactDependencies,
        validPublishConfig,
        forbidden,
        scripts: manifest.scripts,
      }),
      "The closed ready public CLI packed-manifest contract",
      "Correct the public CLI manifest or packing hook and retry.",
    );
  }
  return undefined;
}

function sanitizedNpmEnvironment(repositoryRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/iu.test(key) && value !== undefined) env[key] = value;
  }
  env.PATH = `${path.join(repositoryRoot, "node_modules", ".bin")}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

async function smokeCommand(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CommandResult | PublicationArtifactFailure> {
  const result = await runCommand(options);
  return result.exitCode === 0
    ? result
    : commandFailure(
        "consumer-smoke-failed",
        options.executable,
        options.args,
        result,
        "A successful installed CLI smoke command",
        "Correct the packed runtime or command behavior and retry.",
      );
}

export async function verifyNpmPublicationArtifact(options: {
  readonly repositoryRoot: string;
  readonly packagePath: string;
  readonly outputDirectory: string;
}): Promise<VerifiedPublicationArtifactResult> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const packageRoot = path.resolve(repositoryRoot, options.packagePath);
  const outputDirectory = path.resolve(options.outputDirectory);
  const outputFailure = await validateOutputDirectory({
    repositoryRoot,
    packageRoot,
    outputDirectory,
  });
  if (outputFailure !== undefined)
    return { kind: "failed", failure: outputFailure };

  const readiness = await inspectNpmPublicationReadiness({
    repositoryRoot,
    packagePath: options.packagePath,
  });
  if (readiness.kind === "blocked") return { kind: "blocked", readiness };

  const ownedTemporaryPaths: string[] = [];
  const ownedFinalPaths: string[] = [];
  let result: VerifiedPublicationArtifactResult | undefined;
  try {
    let packDirectory: string;
    let consumerDirectory: string;
    try {
      packDirectory = await mkdtemp(path.join(outputDirectory, "pack-"));
      ownedTemporaryPaths.push(packDirectory);
      consumerDirectory = await mkdtemp(
        path.join(outputDirectory, "consumer-"),
      );
      ownedTemporaryPaths.push(consumerDirectory);
    } catch (error) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-temporary-output-failed",
          error instanceof Error ? error.message : error,
          "Owned pack and consumer temporary directories",
          "Correct output directory permissions and retry.",
        ),
      };
      return result;
    }

    const packArgs = ["pack", "--pack-destination", packDirectory] as const;
    const pack = await runCommand({
      executable: "pnpm",
      args: packArgs,
      cwd: packageRoot,
    });
    if (pack.exitCode !== 0) {
      result = {
        kind: "failed",
        failure: commandFailure(
          "artifact-pack-failed",
          "pnpm",
          packArgs,
          pack,
          "The single pnpm pack lifecycle to succeed",
          "Correct the prepack build or package manifest and retry.",
        ),
      };
      return result;
    }

    const packEntries = await readdir(packDirectory, { withFileTypes: true });
    if (
      packEntries.length !== 1 ||
      !packEntries[0]!.isFile() ||
      !packEntries[0]!.name.endsWith(".tgz")
    ) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-pack-output-invalid",
          JSON.stringify(
            packEntries.map((entry) => ({
              name: entry.name,
              kind: entry.isFile() ? "file" : "other",
            })),
          ),
          "Exactly one ordinary .tgz in the owned pack directory",
          "Correct pack lifecycle outputs and retry.",
        ),
      };
      return result;
    }
    const artifactBasename = packEntries[0]!.name;
    if (!/^[A-Za-z0-9._-]+\.tgz$/u.test(artifactBasename)) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-pack-output-invalid",
          artifactBasename,
          "A safe portable tgz basename",
          "Correct the public package identity and retry.",
        ),
      };
      return result;
    }
    const packedArtifactPath = path.join(packDirectory, artifactBasename);
    const archive = await inspectPublicationArchive(packedArtifactPath);
    if ("code" in archive) {
      result = { kind: "failed", failure: archive };
      return result;
    }
    const sourceManifestValue: unknown = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (!isObject(sourceManifestValue)) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-manifest-invalid",
          "source package.json is not an object",
          "The readiness-approved source package manifest",
          "Restore the package manifest and retry.",
        ),
      };
      return result;
    }
    const manifestFailure = inspectPackedManifestContract({
      manifest: archive.manifest,
      sourceManifest: sourceManifestValue,
      readiness,
    });
    if (manifestFailure !== undefined) {
      result = { kind: "failed", failure: manifestFailure };
      return result;
    }
    const binFile = archive.files.find(
      (item) => item.path === "package/dist/cli.js",
    )!;
    const shebang = archive.cliSource.toString("utf8").split(/\r?\n/u)[0];
    if (
      shebang !== "#!/usr/bin/env node" ||
      (process.platform !== "win32" && (binFile.mode & 0o111) === 0)
    ) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-bin-contract",
          JSON.stringify({ shebang, mode: binFile.mode }),
          "A Node shebang and executable tar mode on POSIX",
          "Correct the compiled CLI entrypoint and retry.",
        ),
      };
      return result;
    }

    const cacheDirectory = path.join(consumerDirectory, "npm-cache");
    const userConfigPath = path.join(consumerDirectory, "user.npmrc");
    const globalConfigPath = path.join(consumerDirectory, "global.npmrc");
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      '{"private":true}\n',
    );
    await writeFile(userConfigPath, "");
    await writeFile(globalConfigPath, "");
    const npmArgs = [
      "install",
      packedArtifactPath,
      `--cache=${cacheDirectory}`,
      `--userconfig=${userConfigPath}`,
      `--globalconfig=${globalConfigPath}`,
      "--registry=https://registry.npmjs.org/",
      "--ignore-scripts=true",
      "--bin-links=true",
      "--package-lock=false",
      "--audit=false",
      "--fund=false",
    ] as const;
    const npmEnvironment = sanitizedNpmEnvironment(repositoryRoot);
    const npmExecutable = path.join(
      repositoryRoot,
      "node_modules/.bin",
      `npm${process.platform === "win32" ? ".cmd" : ""}`,
    );
    const install = await runCommand({
      executable: npmExecutable,
      args: npmArgs,
      cwd: consumerDirectory,
      env: npmEnvironment,
    });
    if (install.exitCode !== 0) {
      result = {
        kind: "failed",
        failure: commandFailure(
          "consumer-install-failed",
          npmExecutable,
          npmArgs,
          install,
          "The locked npm client to install the local tgz with public runtime dependencies",
          "Restore registry access or correct the packed runtime dependency and retry.",
        ),
      };
      return result;
    }
    const installedPackageRoot = path.join(
      consumerDirectory,
      "node_modules",
      readiness.publication.packageName,
    );
    const runtimeImportArgs = [
      "--input-type=module",
      "--eval",
      "await import(process.argv[1])",
      pathToFileURL(path.join(installedPackageRoot, "dist/main.js")).href,
    ] as const;
    const runtimeImport = await smokeCommand({
      executable: process.execPath,
      args: runtimeImportArgs,
      cwd: consumerDirectory,
      env: npmEnvironment,
    });
    if ("code" in runtimeImport) {
      result = { kind: "failed", failure: runtimeImport };
      return result;
    }
    if (runtimeImport.stdout !== "") {
      result = {
        kind: "failed",
        failure: failure(
          "consumer-smoke-failed",
          runtimeImport.stdout,
          "The installed internal runtime module to import without output",
          "Remove import-time output and retry.",
        ),
      };
      return result;
    }
    const binPath = path.join(
      consumerDirectory,
      "node_modules/.bin",
      `${readiness.publication.commandName}${process.platform === "win32" ? ".cmd" : ""}`,
    );
    if (
      process.platform !== "win32" &&
      ((await lstat(binPath)).mode & 0o111) === 0
    ) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-bin-contract",
          "installed bin is not executable",
          "An executable npm-created package bin link",
          "Correct the bin manifest and retry.",
        ),
      };
      return result;
    }
    const helpArgs = ["--help"] as const;
    const versionArgs = ["--version"] as const;
    const greetArgs = ["greet", "  Ada Lovelace  "] as const;
    const help = await smokeCommand({
      executable: binPath,
      args: helpArgs,
      cwd: consumerDirectory,
      env: npmEnvironment,
    });
    if ("code" in help) {
      result = { kind: "failed", failure: help };
      return result;
    }
    const version = await smokeCommand({
      executable: binPath,
      args: versionArgs,
      cwd: consumerDirectory,
      env: npmEnvironment,
    });
    if ("code" in version) {
      result = { kind: "failed", failure: version };
      return result;
    }
    const greet = await smokeCommand({
      executable: binPath,
      args: greetArgs,
      cwd: consumerDirectory,
      env: npmEnvironment,
    });
    if ("code" in greet) {
      result = { kind: "failed", failure: greet };
      return result;
    }
    if (
      !help.stdout.includes(`Usage: ${readiness.publication.commandName}`) ||
      !help.stdout.includes("greet") ||
      version.stdout !== `${readiness.publication.version}\n` ||
      greet.stdout !== "Hello, Ada Lovelace\n"
    ) {
      result = {
        kind: "failed",
        failure: failure(
          "consumer-smoke-failed",
          JSON.stringify({
            help: help.stdout,
            version: version.stdout,
            greet: greet.stdout,
          }),
          "Installed help, exact version, and greet behavior",
          "Correct the packed command identity or behavior and retry.",
        ),
      };
      return result;
    }

    const artifactBytes = await readFile(packedArtifactPath);
    const digest = createHash("sha512").update(artifactBytes).digest();
    const artifactPath = path.join(outputDirectory, artifactBasename);
    const checksumPath = path.join(outputDirectory, "SHA512SUMS");
    const receiptPath = path.join(
      outputDirectory,
      "verified-publication-artifact.json",
    );
    const checksumTemporaryPath = path.join(outputDirectory, ".SHA512SUMS.tmp");
    const receiptTemporaryPath = path.join(
      outputDirectory,
      ".verified-publication-artifact.json.tmp",
    );
    ownedTemporaryPaths.push(checksumTemporaryPath, receiptTemporaryPath);
    const receipt: VerifiedPublicationArtifactReceipt = {
      schemaVersion: 1,
      artifact: {
        file: artifactBasename,
        checksumFile: "SHA512SUMS",
        size: artifactBytes.byteLength,
        integrity: `sha512-${digest.toString("base64")}`,
      },
      publication: readiness.publication,
      packedManifest: archive.manifest,
      files: archive.files.map(({ path: filePath, mode, size }) => ({
        path: filePath,
        mode,
        size,
      })),
      bin: {
        path: "package/dist/cli.js",
        shebang: "#!/usr/bin/env node",
        mode: binFile.mode,
        posixExecutableChecked: process.platform !== "win32",
      },
      smokes: [
        { name: "runtime-import", args: [], stdout: "" },
        { name: "help", args: helpArgs, stdout: help.stdout },
        { name: "version", args: versionArgs, stdout: version.stdout },
        { name: "greet", args: greetArgs, stdout: greet.stdout },
      ],
    };
    try {
      await writeFile(
        checksumTemporaryPath,
        `${digest.toString("hex")}  ${artifactBasename}\n`,
      );
      await writeFile(
        receiptTemporaryPath,
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      await rename(packedArtifactPath, artifactPath);
      ownedFinalPaths.push(artifactPath);
      await rename(checksumTemporaryPath, checksumPath);
      ownedFinalPaths.push(checksumPath);
      await rename(receiptTemporaryPath, receiptPath);
      ownedFinalPaths.push(receiptPath);
    } catch (error) {
      result = {
        kind: "failed",
        failure: failure(
          "artifact-receipt-failed",
          error instanceof Error ? error.message : error,
          "Atomic tgz, SHA512SUMS, and receipt finalization",
          "Correct output permissions and retry with a new empty directory.",
        ),
      };
      return result;
    }
    result = {
      kind: "verified",
      artifactPath,
      checksumPath,
      receiptPath,
      receipt,
    };
    return result;
  } catch (error) {
    result = {
      kind: "failed",
      failure: failure(
        "artifact-receipt-failed",
        error instanceof Error ? error.message : error,
        "A completely verified and recorded publication artifact",
        "Correct the reported local failure and retry.",
      ),
    };
    return result;
  } finally {
    const cleanupFailures: string[] = [];
    const cleanupTargets = [
      ...ownedTemporaryPaths.toReversed(),
      ...(result?.kind === "verified" ? [] : ownedFinalPaths.toReversed()),
    ];
    for (const target of cleanupTargets) {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(
          `${target}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (cleanupFailures.length > 0 && result?.kind === "verified") {
      for (const target of ownedFinalPaths.toReversed()) {
        try {
          await rm(target, { recursive: true, force: true });
        } catch (error) {
          cleanupFailures.push(
            `${target}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (cleanupFailures.length > 0 && result !== undefined) {
      Object.assign(result, {
        kind: "failed",
        failure: failure(
          "artifact-cleanup-failed",
          `${result.kind === "failed" ? `${result.failure.code}; ` : ""}${cleanupFailures.join("; ")}`,
          "All exact invocation-owned temporary and partial final paths removed",
          "Remove the reported invocation-owned paths before retrying.",
        ),
      });
    }
  }
}

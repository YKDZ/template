import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  installContentCollection,
  prepareContentCollection,
} from "@ykdz/template-content/artifact-builder";
import { loadContentSource } from "@ykdz/template-generator/content-source";
import { execa } from "execa";

import { unprivilegedProcessOptions } from "../test-support/unprivileged-process.ts";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function withUnreadableAuthorDirectories<Result>(
  directories: readonly { readonly path: string; readonly mode: number }[],
  action: () => Promise<Result>,
): Promise<Result> {
  const ordered = [...directories].sort(
    (left, right) => right.path.length - left.path.length,
  );
  try {
    for (const directory of ordered) await chmod(directory.path, 0);
    return await action();
  } finally {
    for (const directory of [...ordered].reverse()) {
      await chmod(directory.path, directory.mode);
    }
  }
}

void it(
  "从正式Rust制品安装SDK后，在作者目录不可读的新Node进程加包并运行真实Cargo任务",
  { timeout: 900_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "rust-native-workspace-consumer-"),
    );
    await chmod(temporaryRoot, 0o777);
    let prepared:
      | Awaited<ReturnType<typeof prepareContentCollection>>
      | undefined;
    try {
      await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build:template",
          "--filter=@ykdz/preset-rust-bin",
          "--filter=@ykdz/preset-ts-lib",
          "--filter=@ykdz/reference-workspace-root",
          "--filter=@ykdz/reference-tooling-config",
          "--filter=@ykdz/reference-npm-publication",
          "--force",
        ],
        { cwd: workspaceRoot, timeout: 300_000 },
      );
      await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          "--filter=@ykdz/template-workspace",
          "--force",
        ],
        { cwd: workspaceRoot, timeout: 300_000 },
      );

      const content = await loadContentSource({
        namespace: "ykdz",
        resolve: (specifier) => import.meta.resolve(specifier),
        members: [
          {
            specifier: "@ykdz/reference-workspace-root/template",
            load: () => import("@ykdz/reference-workspace-root/template"),
          },
          {
            specifier: "@ykdz/reference-rust-bin/template",
            load: () => import("@ykdz/reference-rust-bin/template"),
          },
          {
            specifier: "@ykdz/reference-ts-lib/template",
            load: () => import("@ykdz/reference-ts-lib/template"),
          },
          {
            specifier: "@ykdz/reference-tooling-config/template",
            load: () => import("@ykdz/reference-tooling-config/template"),
          },
          {
            specifier: "@ykdz/reference-npm-publication/template",
            load: () => import("@ykdz/reference-npm-publication/template"),
          },
          {
            specifier: "@ykdz/preset-rust-bin/template",
            load: () => import("@ykdz/preset-rust-bin/template"),
          },
          {
            specifier: "@ykdz/preset-ts-lib/template",
            load: () => import("@ykdz/preset-ts-lib/template"),
          },
        ],
      });
      const libraryPreset = content.find(
        (member) =>
          member.kind === "preset" &&
          member.identity.packageName === "@ykdz/preset-ts-lib",
      );
      const rustPreset = content.find(
        (member) =>
          member.kind === "preset" &&
          member.identity.packageName === "@ykdz/preset-rust-bin",
      );
      assert.ok(libraryPreset);
      assert.ok(rustPreset);

      prepared = await prepareContentCollection({
        content,
        roots: [libraryPreset, rustPreset],
        workspaceRoot,
        root: path.join(temporaryRoot, "prepared"),
      });
      assert.ok(
        prepared.members.some(
          (member) =>
            member.identity.packageName === "@ykdz/reference-rust-bin",
        ),
      );
      const rustOwnerArtifact = prepared.owners.find(
        ({ member }) =>
          member.identity.packageName === "@ykdz/reference-rust-bin",
      );
      assert.ok(rustOwnerArtifact);
      const workspaceSdk = prepared.sdkPackages.find(
        ({ name }) => name === "@ykdz/template-workspace",
      );
      assert.ok(workspaceSdk);
      assert.match(workspaceSdk.sha256, /^[0-9a-f]{64}$/u);
      assert.match(rustOwnerArtifact.packed.sha256, /^[0-9a-f]{64}$/u);

      const consumerRoot = path.join(temporaryRoot, "consumer");
      await installContentCollection(prepared, consumerRoot);
      await execa("pnpm", ["add", workspaceSdk.tarball], {
        cwd: consumerRoot,
        timeout: 300_000,
      });

      const projectRoot = path.join(consumerRoot, "project");
      const targetRoot = path.join(projectRoot, "workspace");
      const driverPath = path.join(projectRoot, "default-sdk-driver.mjs");
      await mkdir(projectRoot, { recursive: true });
      await chmod(projectRoot, 0o777);
      const authorRoots = [
        workspaceRoot,
        ...new Set(prepared.owners.map(({ packageRoot }) => packageRoot)),
      ];
      const authorDirectoryStates = await Promise.all(
        authorRoots.map(async (directory) => ({
          path: directory,
          mode: (await stat(directory)).mode & 0o777,
        })),
      );
      const authorRootsPath = path.join(projectRoot, "author-roots.json");
      await writeFile(authorRootsPath, JSON.stringify(authorRoots));
      await writeFile(
        driverPath,
        [
          'import assert from "node:assert/strict";',
          'import { readdir, readFile } from "node:fs/promises";',
          'import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";',
          'import { templateContent } from "@ykdz/template-content";',
          "const [phase, targetRoot, authorRootsPath] = process.argv.slice(2);",
          "const authorRoots = JSON.parse(await readFile(authorRootsPath, 'utf8'));",
          "for (const authorRoot of authorRoots) await assert.rejects(readdir(authorRoot), { code: 'EACCES' });",
          'const libraryPreset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-ts-lib");',
          'const rustPreset = templateContent.find((member) => member.kind === "preset" && member.identity.packageName === "@ykdz/preset-rust-bin");',
          "if (!libraryPreset || !rustPreset) throw new Error('已安装内容集合缺少所需预设');",
          "const generator = createDefaultGenerator({ content: templateContent });",
          'const planning = phase === "init"',
          "  ? await generator.planInit({ targetRoot, selection: { presets: [{ contentIdentity: libraryPreset.identity }] }, conventions: { repositoryName: 'packed-rust-demo', defaultPackageScope: 'demo' } })",
          "  : await generator.planAdd({ repositoryRoot: targetRoot, preset: rustPreset.identity });",
          "if (planning.status !== 'planned') throw new Error(JSON.stringify(planning));",
          "const result = await generator.commitPlan(planning.plan);",
          "if (result.status !== 'success') throw new Error(JSON.stringify(result));",
          "process.stdout.write(JSON.stringify({ packagePaths: result.blueprint.packages.map(({ path }) => path).toSorted(), status: result.status, ...(phase === 'init' ? {} : { container: result.ownerFacts.container }) }));",
          "",
        ].join("\n"),
      );

      const cleanNodeEnv = {
        ...process.env,
        HOME: consumerRoot,
        TMPDIR: temporaryRoot,
        NODE_OPTIONS: "",
        NODE_PATH: "",
      };
      const runInstalledPhase = async (phase: "init" | "add-rust") =>
        await withUnreadableAuthorDirectories(
          authorDirectoryStates,
          async () =>
            await execa(
              process.execPath,
              [
                "--no-global-search-paths",
                driverPath,
                phase,
                targetRoot,
                authorRootsPath,
              ],
              {
                cwd: consumerRoot,
                env: cleanNodeEnv,
                timeout: 300_000,
                ...unprivilegedProcessOptions,
              },
            ),
        );
      const initialized = await runInstalledPhase("init");
      assert.deepEqual(JSON.parse(initialized.stdout), {
        packagePaths: [".", "packages/lib", "packages/tooling-config"],
        status: "success",
      });

      const addedRust = await runInstalledPhase("add-rust");
      const rustAddition = JSON.parse(addedRust.stdout) as {
        readonly packagePaths: readonly string[];
        readonly status: string;
        readonly container: {
          readonly dockerfileText: string;
          readonly buildArguments: readonly {
            readonly name: string;
            readonly value: string;
          }[];
          readonly mounts: readonly {
            readonly identity: string;
            readonly source: string;
            readonly target: string;
          }[];
          readonly probes: readonly {
            readonly identity: string;
            readonly command: string;
            readonly args: readonly string[];
          }[];
        };
      };
      assert.deepEqual(rustAddition.packagePaths, [
        ".",
        "packages/app",
        "packages/lib",
        "packages/tooling-config",
      ]);
      assert.equal(rustAddition.status, "success");

      const toolchainText = await readFile(
        path.join(targetRoot, "rust-toolchain.toml"),
        "utf8",
      );
      const rustVersion = toolchainText.match(
        /^channel\s*=\s*"([^"]+)"\s*$/mu,
      )?.[1];
      assert.ok(rustVersion);
      const rootManifest = JSON.parse(
        await readFile(path.join(targetRoot, "package.json"), "utf8"),
      ) as {
        readonly scripts: Readonly<Record<string, string>>;
      };
      assert.equal(
        rootManifest.scripts["toolchain:prepare"],
        "cargo --version",
      );
      const devcontainer = JSON.parse(
        await readFile(
          path.join(targetRoot, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as {
        readonly build: { readonly args: Readonly<Record<string, string>> };
        readonly mounts: readonly { readonly source?: string }[];
      };
      assert.equal(devcontainer.build.args.RUST_TOOLCHAIN, rustVersion);
      assert.ok(
        devcontainer.mounts.some(
          ({ source }) => source === "${devcontainerId}-cargo-registry",
        ),
      );
      assert.ok(
        devcontainer.mounts.some(
          ({ source }) => source === "${devcontainerId}-cargo-git",
        ),
      );
      assert.match(
        rustAddition.container.dockerfileText,
        /ARG RUST_TOOLCHAIN/u,
      );
      assert.match(
        rustAddition.container.dockerfileText,
        /toolchain install \$\{RUST_TOOLCHAIN\}.*--component rustfmt --component clippy/u,
      );
      assert.ok(
        rustAddition.container.buildArguments.some(
          ({ name, value }) =>
            name === "RUST_TOOLCHAIN" && value === rustVersion,
        ),
      );
      const probes = new Map(
        rustAddition.container.probes.map((probe) => [probe.identity, probe]),
      );
      assert.deepEqual(probes.get("cargo"), {
        identity: "cargo",
        command: "cargo",
        args: ["--version"],
      });
      assert.deepEqual(probes.get("rustc"), {
        identity: "rustc",
        command: "rustc",
        args: ["--version"],
      });
      assert.deepEqual(probes.get("rustfmt"), {
        identity: "rustfmt",
        command: "cargo",
        args: ["fmt", "--version"],
      });
      assert.deepEqual(probes.get("clippy"), {
        identity: "clippy",
        command: "cargo",
        args: ["clippy", "--version"],
      });
      const dockerfileText = await readFile(
        path.join(targetRoot, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.match(dockerfileText, /ARG RUST_TOOLCHAIN/u);
      const cargoManifest = await readFile(
        path.join(targetRoot, "packages/app/Cargo.toml"),
        "utf8",
      );
      assert.match(cargoManifest, /name = "app"/u);

      const cargoHome = path.join(temporaryRoot, "cargo-home");
      const rustupHome = path.join(temporaryRoot, "rustup-home");
      const cargoTarget = path.join(temporaryRoot, "cargo-target");
      const rustEnvironment = {
        ...process.env,
        CARGO_HOME: cargoHome,
        CARGO_TARGET_DIR: cargoTarget,
        RUSTUP_HOME: rustupHome,
      };
      await mkdir(cargoHome, { recursive: true });
      await mkdir(rustupHome, { recursive: true });
      const rustHost = (await execa("rustc", ["-vV"])).stdout.match(
        /^host:\s*(\S+)$/mu,
      )?.[1];
      assert.ok(rustHost);
      const toolchain = `${rustVersion}-${rustHost}`;
      const sharedRustupHome = (
        await execa("rustup", ["show", "home"])
      ).stdout.trim();
      const sharedToolchainPath = path.join(
        sharedRustupHome,
        "toolchains",
        toolchain,
      );
      const sharedComponents = await execa(
        "rustup",
        ["component", "list", "--toolchain", toolchain, "--installed"],
        { reject: false },
      );
      const installedComponents = new Set(
        sharedComponents.stdout
          .split(/\r?\n/u)
          .map((component) => component.trim()),
      );
      let canLinkInstalledToolchain =
        sharedComponents.exitCode === 0 &&
        ["clippy", "rustfmt"].every((component) =>
          installedComponents.has(`${component}-${rustHost}`),
        );
      try {
        await access(sharedToolchainPath);
      } catch {
        canLinkInstalledToolchain = false;
      }
      if (canLinkInstalledToolchain) {
        const isolatedToolchains = path.join(rustupHome, "toolchains");
        await mkdir(isolatedToolchains, { recursive: true });
        await symlink(
          sharedToolchainPath,
          path.join(isolatedToolchains, toolchain),
        );
      } else {
        await execa(
          "rustup",
          [
            "toolchain",
            "install",
            rustVersion,
            "--profile",
            "minimal",
            "--no-self-update",
            "--component",
            "clippy",
            "--component",
            "rustfmt",
          ],
          { env: rustEnvironment, timeout: 600_000 },
        );
      }
      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        env: rustEnvironment,
        timeout: 300_000,
      });

      const graph = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          "format:check",
          "lint",
          "test",
          "--filter=@demo/app",
          "--dry-run=json",
        ],
        { cwd: targetRoot, env: rustEnvironment, timeout: 300_000 },
      );
      const tasks = (
        JSON.parse(graph.stdout) as {
          readonly tasks: readonly {
            readonly taskId: string;
            readonly dependencies: readonly string[];
          }[];
        }
      ).tasks;
      assert.equal(
        tasks.filter(({ taskId }) => taskId === "//#toolchain:prepare").length,
        1,
      );
      for (const taskId of [
        "@demo/app#build",
        "@demo/app#format:check",
        "@demo/app#lint",
        "@demo/app#test",
      ]) {
        const task = tasks.find((candidate) => candidate.taskId === taskId);
        assert.ok(task, taskId);
        assert.ok(task.dependencies.includes("//#toolchain:prepare"), taskId);
      }

      const cargoTasks = await execa(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "build",
          "format:check",
          "lint",
          "test",
          "--filter=@demo/app",
          "--force",
        ],
        {
          cwd: targetRoot,
          env: rustEnvironment,
          timeout: 600_000,
        },
      );
      assert.match(
        `${cargoTasks.stdout}\n${cargoTasks.stderr}`,
        /toolchain:prepare/u,
      );

      console.log(
        JSON.stringify({
          collection: {
            name: prepared.collection.name,
            sha256: prepared.collection.sha256,
          },
          rustOwner: {
            name: rustOwnerArtifact.packed.name,
            sha256: rustOwnerArtifact.packed.sha256,
          },
          workspaceSdk: {
            name: workspaceSdk.name,
            sha256: workspaceSdk.sha256,
          },
          packagePaths: JSON.parse(addedRust.stdout).packagePaths,
          rustVersion,
          cargoTasks: [
            "//#toolchain:prepare",
            "@demo/app#build",
            "@demo/app#format:check",
            "@demo/app#lint",
            "@demo/app#test",
          ],
          cargoTaskOutput: `${cargoTasks.stdout}\n${cargoTasks.stderr}`.trim(),
          cargoTarget,
        }),
      );
    } finally {
      await prepared?.cleanup();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

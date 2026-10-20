import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { execa } from "execa";
import { create, extract } from "tar";

const { values } = parseArgs({
  options: { "pack-destination": { type: "string", default: "." } },
});
const destination = path.resolve(values["pack-destination"]);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "template-pack-"));

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readManifest(file: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(file, "utf8")) as PackageManifest;
}

async function packageDirectories(modules: string): Promise<string[]> {
  const entries = await readdir(modules, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const name of await readdir(directory))
        directories.push(path.join(directory, name));
    } else directories.push(directory);
  }
  return directories;
}

try {
  const raw = path.join(temporaryRoot, "raw");
  const unpacked = path.join(temporaryRoot, "unpacked");
  await mkdir(raw);
  await mkdir(unpacked);
  await execa(
    "pnpm",
    ["--config.node-linker=hoisted", "pack", "--pack-destination", raw],
    { stdio: "inherit" },
  );
  const archives = (await readdir(raw)).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("原生打包未产生唯一归档");
  const archive = archives[0]!;
  await extract({ file: path.join(raw, archive), cwd: unpacked });
  const packageRoot = path.join(unpacked, "package");
  const packages = await packageDirectories(
    path.join(packageRoot, "node_modules"),
  );

  // 只投影 npm 运行包的清单；dist 内参考源码的清单仍是生成输入。
  for (const directory of packages) {
    packages.push(
      ...(await packageDirectories(path.join(directory, "node_modules"))),
    );
    const manifestPath = path.join(directory, "package.json");
    const manifest = await readManifest(manifestPath);
    const require = createRequire(manifestPath);
    let changed = false;
    for (const dependencies of [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [name, version] of Object.entries(dependencies ?? {})) {
        if (!/^(?:catalog|workspace):/u.test(version)) continue;
        let installed: PackageManifest | undefined;
        for (const modules of require.resolve.paths(name) ?? []) {
          if (!modules.startsWith(`${packageRoot}${path.sep}`)) continue;
          try {
            installed = await readManifest(
              path.join(modules, name, "package.json"),
            );
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (!installed)
          throw new Error(`归档缺少运行依赖：${name}（${manifestPath}）`);
        dependencies![name] = installed.version;
        changed = true;
      }
    }
    if (changed)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await mkdir(destination, { recursive: true });
  const output = path.join(destination, archive);
  await create(
    {
      cwd: unpacked,
      file: output,
      gzip: true,
      portable: true,
      filter: (entryPath) =>
        !entryPath
          .split("/")
          .some((segment) => [".cache", ".pnpm", ".turbo"].includes(segment)),
    },
    ["package"],
  );
  console.log(output);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

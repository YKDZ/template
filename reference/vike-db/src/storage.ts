import { rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type DatabaseProfile = "dev" | "test" | "e2e";

function localProfile(): DatabaseProfile {
  const profile = process.env.DATABASE_PROFILE;
  if (process.env.DATABASE_FILE !== undefined) {
    throw new Error("DATABASE_FILE 不能与本地 DATABASE_PROFILE 同时设置");
  }
  if (profile === "dev" || profile === "test" || profile === "e2e") {
    return profile;
  }
  throw new Error("DATABASE_PROFILE 必须为 dev、test 或 e2e");
}

function localDatabaseStorageTarget(profile: DatabaseProfile): string {
  switch (profile) {
    case "dev":
      return fileURLToPath(new URL("../data/dev.sqlite", import.meta.url));
    case "test":
      return fileURLToPath(new URL("../data/test.sqlite", import.meta.url));
    case "e2e":
      return fileURLToPath(new URL("../data/e2e.sqlite", import.meta.url));
  }
}

export function databaseStorageTarget(): string {
  if (process.env.DATABASE_PROFILE !== undefined) {
    return localDatabaseStorageTarget(localProfile());
  }
  const externalTarget = process.env.DATABASE_FILE;
  if (externalTarget !== undefined && isAbsolute(externalTarget)) {
    return externalTarget;
  }
  throw new Error("部署必须提供绝对路径 DATABASE_FILE");
}

export function resetDatabaseStorageTarget(): void {
  switch (localProfile()) {
    case "dev":
      rmSync(fileURLToPath(new URL("../data/dev.sqlite", import.meta.url)), {
        force: true,
      });
      rmSync(
        fileURLToPath(new URL("../data/dev.sqlite-journal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/dev.sqlite-wal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/dev.sqlite-shm", import.meta.url)),
        { force: true },
      );
      return;
    case "test":
      rmSync(fileURLToPath(new URL("../data/test.sqlite", import.meta.url)), {
        force: true,
      });
      rmSync(
        fileURLToPath(new URL("../data/test.sqlite-journal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/test.sqlite-wal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/test.sqlite-shm", import.meta.url)),
        { force: true },
      );
      return;
    case "e2e":
      rmSync(fileURLToPath(new URL("../data/e2e.sqlite", import.meta.url)), {
        force: true,
      });
      rmSync(
        fileURLToPath(new URL("../data/e2e.sqlite-journal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/e2e.sqlite-wal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/e2e.sqlite-shm", import.meta.url)),
        { force: true },
      );
  }
}

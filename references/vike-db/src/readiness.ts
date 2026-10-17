import { sql } from "drizzle-orm";

import type { Database } from "#db/db";
import { todos } from "#db/schema";

export function assertDatabaseReady(db: Database) {
  try {
    db.select({ ready: sql`1` })
      .from(todos)
      .limit(1)
      .all();
  } catch (cause) {
    const profile = process.env.DATABASE_PROFILE;
    const preparation =
      profile === "dev" || profile === "test" || profile === "e2e"
        ? `请在仓库根运行 \`pnpm run database:prepare:${profile}\``
        : "请先使用配套 migration artifact 完成部署数据库迁移";
    throw new Error(
      `DATABASE_NOT_READY: 数据库尚未就绪。${preparation} 后重试。`,
      { cause },
    );
  }
}

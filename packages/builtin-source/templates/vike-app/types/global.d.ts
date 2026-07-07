import type { Database } from "#/database/db";

declare global {
  namespace Telefunc {
    interface Context {
      db: Database;
    }
  }
}

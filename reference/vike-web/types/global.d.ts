import type { Database } from "@ykdz/reference-vike-db";

declare global {
  namespace Telefunc {
    interface Context {
      db: Database;
    }
  }
}

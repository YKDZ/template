import { createDatabase } from "#db/db";
import { assertDatabaseReady } from "#db/readiness";
import { seedExampleData } from "#db/seed/example";

const db = createDatabase();
assertDatabaseReady(db);
await seedExampleData(db);

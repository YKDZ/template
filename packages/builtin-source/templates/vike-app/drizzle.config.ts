import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./database/schema.ts",
  out: "./database/migrations",
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? "./data/app.sqlite",
  },
});

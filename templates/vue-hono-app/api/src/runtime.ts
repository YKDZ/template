import { Hono } from "hono";

export const app = new Hono()
  .basePath("/api")
  .get("/health", (context) => context.json({ status: "ok" as const }));

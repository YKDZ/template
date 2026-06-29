import { Hono } from "hono";

const app = new Hono()
  .basePath("/api")
  .get("/health", (context) => context.json({ status: "ok" as const }));

export type AppType = typeof app;

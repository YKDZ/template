import { Hono } from "hono";

export const app = new Hono().basePath("/api");

app.get("/health", (context) => context.json({ status: "ok" as const }));

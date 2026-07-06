import { Hono } from "hono";

export const api = new Hono().get("/health", (c) =>
  c.json({ ok: true, service: "vike-app" }),
);

import vike from "@vikejs/hono";
import { Hono } from "hono";
import { Telefunc } from "telefunc/node";

import { createDatabase } from "#/database/db";
import { api } from "#/server/api";

const telefunc = new Telefunc();

export const app = new Hono();

app.route("/api", api);

app.all("/_telefunc", async (c) => {
  const response = await telefunc.serve({
    request: c.req.raw,
    context: {
      db: createDatabase(),
    },
  });

  return response ?? c.notFound();
});

vike(app);
